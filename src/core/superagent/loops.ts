/**
 * A superagent's own schedule (manifest `main.loops`, or one set with
 * `PUT /api/superagents/:name/loops/:id`): at each time of a recurring rule,
 * an optional check command decides whether to run, and the prompt goes to
 * the superagent's main conversation, whichever session that is now.
 * Agentbox owns the loop, so it survives the main moving to a new session,
 * a restart, and the conversation forgetting to set its next timer.
 *
 * The check runs in the main's directory (else the superagent's): exit 0
 * runs (what it prints goes before the prompt), exit 1 skips this time,
 * anything else is a failure that skips and is shown. A time that comes
 * while the main is mid-turn waits for the turn to end; times missed
 * meanwhile fold into that one.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { getSessionRecord } from "../db";
import { FleetError } from "../fleet";
import { runShell } from "../runcheck";
import { isRecurring, nextRun, parseWhen, type ScheduleRule } from "../schedule";
import { scheduleSentMark } from "../sent";
import type { SuperagentLoop } from "../types";
import { patchState, stateOf, type LoopState } from "./state";

export const LoopInput = z
  .object({ when: z.string().trim().min(1).max(200), check: z.string().trim().max(4000).nullable().optional(), prompt: z.string().trim().min(1).max(8000) })
  .strict();

/** How long a check may run, and how much of what it prints is said. */
export const CHECK_TIMEOUT_S = 120;
export const CHECK_MAX = 16_000;
export const LOOP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A loop's rule, or a refusal: it must repeat at a time. */
export function ruleOf(when: string, now: number): ScheduleRule {
  const parsed = parseWhen(when, now);
  if ("error" in parsed) throw new FleetError(400, parsed.error);
  if (!isRecurring(parsed.rule) || parsed.rule.kind === "red") throw new FleetError(400, "A loop repeats at a time: “every hour”, “every weekday at 9am”");
  return parsed.rule;
}

/** The clock of a loop as of `now`: a time that has come becomes `due`
 *  (folding any earlier one still waiting), and `nextAt` moves past `now`. */
export function advance(c: LoopState, rule: ScheduleRule, now: number): LoopState {
  if (c.nextAt === null || c.nextAt > now) return c;
  return { ...c, due: c.due ?? c.nextAt, nextAt: nextRun(rule, now) };
}

/** What the main conversation is told: the check's output, then the prompt. */
export function loopText(when: string, prompt: string, checkOut: string): string {
  const out = checkOut.trim();
  const said = out.length > CHECK_MAX ? `${out.slice(0, CHECK_MAX)}\n[agentbox: the check's output was cut here.]` : out;
  return [`Your loop (${when})${said ? ". Its check said:" : ":"}`, said, prompt].filter(Boolean).join("\n\n");
}

/** A loop as it is now: its spec (the manifest's prompt file read fresh) and its clock. */
export type Loop = { id: string; source: "manifest" | "set"; when: string; check: string | null; prompt: string };

export type ManifestLoop = { id?: string; when: string; check?: string; prompt?: string; file?: string };

/** Every loop of a superagent: the manifest's, then the ones set by API. */
export function loopsOf(dir: string, manifest: ManifestLoop[], set: Record<string, LoopState>): Loop[] {
  const out: Loop[] = manifest.map((l, i) => ({
    id: l.id ?? `loop-${i + 1}`,
    source: "manifest",
    when: l.when,
    check: l.check ?? null,
    prompt: l.prompt ?? promptFile(dir, l.file!),
  }));
  for (const [id, c] of Object.entries(set)) if (c.spec && !out.some((l) => l.id === id)) out.push({ id, source: "set", ...c.spec });
  return out;
}

/** A manifest loop's prompt file, inside the directory. */
function promptFile(dir: string, file: string): string {
  const path = isAbsolute(file) ? file : join(dir, file);
  if (relative(dir, path).startsWith("..")) return `[agentbox: the loop's file ${file} is outside the superagent's directory]`;
  try {
    return readFileSync(path, "utf8").trim().slice(0, 8000);
  } catch {
    return `[agentbox: the loop's file ${file} could not be read]`;
  }
}

const specKey = (l: Loop) => createHash("sha256").update(l.when).digest("hex").slice(0, 16);

/** The loops as the Agents page shows them, with each clock brought to `now`. */
export function loopViews(name: string, loops: Loop[], now: number): SuperagentLoop[] {
  const clocks = stateOf(name).loops ?? {};
  return loops.map((l) => {
    const c = clocks[l.id];
    let nextAt: number | null = null;
    try {
      nextAt = c && c.of === specKey(l) ? c.nextAt : nextRun(ruleOf(l.when, now), now);
    } catch {
      // A manifest rule that does not parse runs never; the manifest is shown as it is.
    }
    return { id: l.id, source: l.source, when: l.when, check: l.check, prompt: l.prompt, nextAt, due: c?.due ?? null, last: c?.last ?? null };
  });
}

/** Set (or replace) a loop by API; refused for a manifest loop's id. */
export function setLoop(name: string, manifestIds: string[], id: string, value: unknown, now: number): void {
  if (!LOOP_ID.test(id)) throw new FleetError(400, "a loop id is lowercase letters, digits and dashes");
  if (manifestIds.includes(id)) throw new FleetError(409, `${id} is a loop of the manifest: change it there`);
  const p = LoopInput.parse(value);
  const rule = ruleOf(p.when, now);
  const spec = { when: p.when, check: p.check || null, prompt: p.prompt };
  patchState(name, (s) => {
    s.loops = { ...s.loops, [id]: { spec, of: specKey({ id, source: "set", ...spec }), nextAt: nextRun(rule, now), due: null, last: null } };
  });
}

export function removeLoop(name: string, manifestIds: string[], id: string): void {
  if (manifestIds.includes(id)) throw new FleetError(409, `${id} is a loop of the manifest: remove it there`);
  const had = !!stateOf(name).loops?.[id]?.spec;
  if (!had) throw new FleetError(404, `${name} has no loop ${id} set by API`);
  patchState(name, (s) => {
    if (s.loops) delete s.loops[id];
  });
}

/** What runs a loop: the hub's view of the superagent, and how to tell its main. */
export interface LoopHost {
  /** Enabled superagents with loops, their directory, and their main now. */
  looped(): { name: string; dir: string; main: string | null; loops: Loop[] }[];
  /** Is its main mid-turn (or rolling over): a due time waits. */
  busy(name: string): boolean;
  /** Say it to its main conversation; it may start one from the manifest. */
  tell(name: string, text: string, sendId: string): Promise<unknown>;
}

export class Loops {
  private running = new Set<string>();
  constructor(private readonly host: LoopHost) {}

  /** Each tick: the loops whose time has come, once their main is not mid-turn. */
  tick(now: number): void {
    for (const a of this.host.looped()) {
      for (const l of a.loops) {
        const key = `${a.name}/${l.id}`;
        let rule: ScheduleRule;
        try {
          rule = ruleOf(l.when, now);
        } catch {
          continue;
        }
        const c = this.clock(a.name, l, rule, now);
        if (!c.due || this.running.has(key) || this.host.busy(a.name)) continue;
        this.running.add(key);
        void this.run(a.name, a.dir, a.main, l, now)
          // Another message going in, or a rollover, is a moment's wait: the time stays due.
          .catch((e) => (/being delivered|being continued|being started/.test((e as Error).message) ? undefined : this.done(a.name, l.id, now, "failed", (e as Error).message)))
          .finally(() => this.running.delete(key));
      }
    }
  }

  /** Its clock, started or advanced and saved when it moved. */
  private clock(name: string, l: Loop, rule: ScheduleRule, now: number): LoopState {
    const old = stateOf(name).loops?.[l.id];
    const of = specKey(l);
    const base: LoopState = old && old.of === of ? old : { ...(old?.spec ? { spec: old.spec } : {}), of, nextAt: nextRun(rule, now), due: null, last: old?.last ?? null };
    const next = advance(base, rule, now);
    if (next !== old)
      patchState(name, (s) => {
        s.loops = { ...s.loops, [l.id]: next };
      });
    return next;
  }

  private done(name: string, id: string, now: number, result: "sent" | "skipped" | "failed", detail: string): void {
    patchState(name, (s) => {
      const c = s.loops?.[id];
      if (c) Object.assign(c, { due: null, last: { at: now, result, detail: detail.slice(0, 300) } });
    });
    console.log(`agentbox: ${name}'s loop ${id} ${result}${detail ? `: ${detail}` : ""}`);
  }

  private async run(name: string, dir: string, main: string | null, l: Loop, now: number): Promise<void> {
    let out = "";
    if (l.check) {
      const rec = main ? getSessionRecord(main) : null;
      const cwd = rec?.cwd && existsSync(rec.cwd) ? rec.cwd : dir;
      const r = await runShell(l.check, { cwd, timeoutS: CHECK_TIMEOUT_S, env: { AGENTBOX_SUPERAGENT: name, AGENTBOX_SUPERAGENT_SESSION: main ?? "" } });
      if (r.timedOut) return this.done(name, l.id, now, "failed", `the check did not finish in ${CHECK_TIMEOUT_S}s`);
      if (r.code === 1) return this.done(name, l.id, now, "skipped", "the check said not this time");
      if (r.code !== 0) return this.done(name, l.id, now, "failed", `the check exited ${r.code}${r.err.trim() ? `: ${r.err.trim().split("\n").pop()!}` : ""}`);
      out = r.out;
    }
    await this.host.tell(name, `${scheduleSentMark(`loop-${name}-${l.id}`)} ${loopText(l.when, l.prompt, out)}`, randomUUID());
    this.done(name, l.id, now, "sent", main ? "" : "it started a new main conversation");
  }
}
