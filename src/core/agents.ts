/**
 * Agents: programs that run on agentbox, not in it (docs/agents.md).
 *
 * An agent is a directory with a `agent.json`. Agentbox knows its
 * name, keeps its program running when it has one, shows it on the Agents
 * page with its main conversation, and relays its page (a view of blocks) and
 * the actions taken on it. What the agent does, when, and by what rules
 * is its own code, written against the same HTTP API and CLI any session uses.
 * Nothing here knows any agent by name, and nothing here should: a rule
 * one agent needs is that agent's to write.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Subprocess } from "bun";
import { moveCards } from "./cards";
import { getDb } from "./db";
import { FleetError, type Fleet, type SpawnRequest } from "./fleet";
import { agentboxBin, agentboxHome, packageRoot, userHome } from "./paths";
import { movePrClaims, prReleasedLine, prReleaseTold } from "./prclaims";
import { submitWithReceipt } from "./send-receipts";
import { scheduleSentMark } from "./sent";
import type { AgentInfo, ProviderId, Session } from "./types";

const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "devin", "omp", "opencode", "muse"];
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** How long a view or an action may take before the page is told it did not answer. */
const VIEW_MS = 8_000;
const ACTION_MS = 60_000;
const MAX_REPLY = 2 * 1024 * 1024;
const MAX_LOG = 4 * 1024 * 1024;
/** Tokens of context past which the next message starts a fresh main, unless
 *  the manifest names its own (`main.freshOver`): large enough to hold hours
 *  of conversation, small enough that waking it cold is not a monolith. */
export const FRESH_OVER = 150_000;
/** A main this close to going cold is asked for its handoff (`askHandoff`). */
const HANDOFF_LEAD_MS = 5 * 60_000;
const HANDOFF_CHECK_MS = 60_000;
const HANDOFF_ASK = "[agentbox: you have been idle and your prompt cache goes cold in a few minutes,";
/** A program that lived this long before it exited starts again at once. */
const STEADY_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/** `agent.json`. Fields agentbox does not know are the program's own and left alone. */
export const Manifest = z
  .object({
    name: z.string().regex(NAME, "a name is lowercase letters, digits and dashes, starting with a letter"),
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(2000).default(""),
    /** The program, run in the directory and kept running: argv, not a shell line. */
    run: z.array(z.string().min(1)).min(1).optional(),
    /** Where a program agentbox does not run answers (`/agentbox/view`, `/agentbox/action`). */
    url: z.string().url().optional(),
    main: z
      .object({
        /** A `POST /api/sessions` body: what agentbox starts a main from. Its
         *  `fallbacks` are other providers, tried in order when its own has no room. */
        start: z.record(z.string(), z.unknown()).optional(),
        /** A file in the directory: each fresh main is told it first. */
        instructions: z.string().min(1).optional(),
        /** Tokens of context past which the next message starts a fresh main. */
        freshOver: z.number().int().min(20_000).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof Manifest>;

type Row = {
  name: string;
  dir: string;
  enabled: number;
  main: string | null;
  previous: string;
  main_send: string | null;
  /** The main it replaced while that one was mid-turn: closed once its turn is over. */
  retiring: string | null;
  /** When the main was last told its instructions. */
  briefed_at: number | null;
  created_at: number;
};

type Proc = {
  child: Subprocess | null;
  port: number;
  pid: number | null;
  since: number;
  restarts: number;
  /** Not started again before this. */
  backoffUntil: number;
  lastExit: { code: number | null; at: number } | null;
  stopping: boolean;
};

export type Caller = { session: string | null; via: "app" | "api" };

export const agentHome = (name: string): string => join(agentboxHome(), "agents", name);

function rowOf(name: string): Row | null {
  return getDb().query("SELECT * FROM agents WHERE name = ?").get(name) as Row | null;
}

function rows(): Row[] {
  return getDb().query("SELECT * FROM agents ORDER BY created_at").all() as Row[];
}

export function readManifest(dir: string): Manifest {
  const file = join(dir, "agent.json");
  if (!existsSync(file)) throw new FleetError(400, `${file} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new FleetError(400, `${file} is not JSON: ${(e as Error).message}`);
  }
  const m = Manifest.safeParse(raw);
  if (!m.success) throw new FleetError(400, `${file}: ${m.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  if (m.data.run && m.data.url) throw new FleetError(400, `${file}: give run or url, not both`);
  return m.data;
}

/** The secret agentbox sends its program, so a page on another site cannot drive it. Same-user readable, like a session capability. */
export function agentToken(name: string): string {
  const home = agentHome(name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "token");
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return readFileSync(file, "utf8").trim();
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function readCapped(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_REPLY) throw new FleetError(502, "the agent answered with more than 2 MiB");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new FleetError(502, `the agent did not answer with JSON (HTTP ${res.status})`);
  }
}

export class Agents {
  private procs = new Map<string, Proc>();
  private starting = new Set<string>();
  private handoffsAskedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fleet: Fleet,
    /** The server's own address, for the programs. */
    private readonly serverUrl: string,
    private readonly changed: () => void = () => {},
  ) {}

  start(): void {
    // Agents were called superagents until 2026-10-22, and their homes lived there.
    const old = join(agentboxHome(), "superagents");
    if (existsSync(old) && !existsSync(join(agentboxHome(), "agents"))) renameSync(old, join(agentboxHome(), "agents"));
    for (const r of rows()) {
      const moved = r.dir.replace("/superagents/", "/agents/");
      if (moved !== r.dir && !existsSync(r.dir) && existsSync(moved)) getDb().run("UPDATE agents SET dir = ? WHERE name = ?", [moved, r.name]);
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3_000);
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    for (const name of this.procs.keys()) this.kill(name);
  }

  list(): AgentInfo[] {
    return rows().map((r) => this.info(r));
  }

  get(name: string): AgentInfo {
    return this.info(this.row(name));
  }

  /** Add the agent in `dir`, or read its manifest again. */
  async register(dir: string): Promise<AgentInfo> {
    if (!isAbsolute(dir)) throw new FleetError(400, "give the agent's directory as an absolute path");
    const m = readManifest(dir);
    const old = rowOf(m.name);
    if (old && resolve(old.dir) !== resolve(dir))
      throw new FleetError(409, `an agent named ${m.name} is already registered from ${old.dir}; remove it first`);
    if (!old) getDb().run("INSERT INTO agents (name, dir, enabled, previous, created_at) VALUES (?, ?, 1, '[]', ?)", [m.name, resolve(dir), Date.now()]);
    agentToken(m.name);
    // A changed program is started again with the manifest it has now.
    if (old) this.kill(m.name);
    await this.tick();
    this.changed();
    return this.get(m.name);
  }

  /** Forget it. Its directory and its home stay where they are. */
  remove(name: string): void {
    this.row(name);
    this.kill(name);
    this.procs.delete(name);
    getDb().run("DELETE FROM agents WHERE name = ?", [name]);
    this.changed();
  }

  async patch(name: string, p: { enabled?: boolean; main?: string | null }): Promise<AgentInfo> {
    const r = this.row(name);
    if (p.enabled !== undefined) {
      getDb().run("UPDATE agents SET enabled = ? WHERE name = ?", [p.enabled ? 1 : 0, name]);
      if (!p.enabled) this.kill(name);
    }
    if (p.main !== undefined) {
      if (p.main !== null && !this.fleet.sessions().some((s) => s.id === p.main)) throw new FleetError(404, `no session ${p.main}`);
      this.setMain(r, p.main);
    }
    await this.tick();
    this.changed();
    return this.get(name);
  }

  async restart(name: string): Promise<AgentInfo> {
    this.row(name);
    this.kill(name);
    const p = this.procs.get(name);
    if (p) p.backoffUntil = 0;
    await this.tick();
    return this.get(name);
  }

  /** The end of its program's output. */
  log(name: string, bytes = 64 * 1024): string {
    this.row(name);
    const file = join(agentHome(name), "process.log");
    if (!existsSync(file)) return "";
    const all = readFileSync(file);
    return all.subarray(Math.max(0, all.length - bytes)).toString("utf8");
  }

  /** Its page: what its program answers at `/agentbox/view`. */
  async view(name: string, tab: string | null): Promise<unknown> {
    const ep = this.endpoint(name);
    if (!ep) return null;
    const url = `${ep}/agentbox/view${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
    const res = await this.call(name, url, { method: "GET" }, VIEW_MS);
    const body = await readCapped(res);
    if (!res.ok) throw new FleetError(502, `the agent's view failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  }

  /** An action on its page, or one of its sessions calling it: relayed with who asked. */
  async action(name: string, body: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const ep = this.endpoint(name);
    if (!ep) throw new FleetError(409, `${name} has no program answering: nothing to act on`);
    const res = await this.call(
      name,
      `${ep}/agentbox/action`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, caller }) },
      ACTION_MS,
    );
    const out = await readCapped(res);
    if (!res.ok) {
      const msg = out && typeof out === "object" && "error" in out ? String((out as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new FleetError(res.status >= 400 && res.status < 500 ? res.status : 502, msg);
    }
    return out;
  }

  /** A person says something to its main conversation (the Agents page, `agentbox agent chat`).
   *  A retry with the same `sendId` never starts a second main. */
  async chat(name: string, text: string, sendId: string): Promise<{ session: string; started: boolean }> {
    const r = this.row(name);
    if (r.enabled !== 1) throw new FleetError(409, `${name} is disabled: enable it to talk to it`);
    if (r.main_send === sendId && r.main) return { session: this.fleet.heir(r.main), started: true };
    const out = await this.say(r, text, { sendId });
    if ("quiet" in out) throw new FleetError(409, out.quiet);
    return out;
  }

  /** A schedule's note for its main conversation (src/core/scheduler.ts). Skipped
   *  while the main is mid-turn or showing a prompt: its next time says what is still true. */
  async note(name: string, text: string, scheduleId: string): Promise<{ session: string; started: boolean } | { quiet: string }> {
    const r = this.row(name);
    if (r.enabled !== 1) return { quiet: `${name} is disabled` };
    return this.say(r, text, { schedule: scheduleId });
  }

  /** Where a schedule that speaks to it runs its note command: the agent's directory. */
  dir(name: string): string {
    return this.row(name).dir;
  }

  /** Its main is mid-turn or showing a prompt. */
  busy(name: string): boolean {
    const main = this.mainOf(this.row(name));
    return !!main && atWork(this.session(main));
  }

  /**
   * Say `text` to its main conversation: the one it has, or a fresh one when
   * it has none, or when the one it has is closed, stopped at a usage limit,
   * holds more context than `main.freshOver`, or runs on a fallback while its
   * own provider has room again. A fresh main is told its instructions, the
   * handoff the last one wrote (`askHandoff`), and who it takes over from; the
   * last one's sessions, cards, PRs and messages go to it, and it is closed
   * once it is not at work. A main compacted since it was last told its
   * instructions is told them again, once.
   */
  private async say(r: Row, text: string, from: { sendId: string } | { schedule: string }): Promise<{ session: string; started: boolean } | { quiet: string }> {
    const m = readManifest(r.dir);
    const main = this.mainOf(r);
    const last = main ? this.session(main) : null;
    const start = m.main?.start;
    const busy = atWork(last);
    if (busy && "schedule" in from) return { quiet: "its main conversation is mid-turn or showing a prompt, so this time was skipped; its next time says what is still true" };
    const over = !last ? "none yet" : busy || !start ? null : (pastIt(last, m.main?.freshOver ?? FRESH_OVER) ?? this.backHome(start, last));
    const instructions = m.main?.instructions ? this.fill(readFileSync(join(r.dir, m.main.instructions), "utf8").trim(), r) : "";
    if (last && !over) {
      const compacted = !!instructions && (last.compactedAt ?? 0) > (r.briefed_at ?? 0);
      const said = compacted ? `${text}\n\n[agentbox: you were compacted since you were told your instructions, so here they are again]\n\n${instructions}` : text;
      if ("sendId" in from) await submitWithReceipt(last.id, from.sendId, "send", said, (attempt) => this.fleet.send(last.id, said, attempt));
      else await this.fleet.note(last.id, `${scheduleSentMark(from.schedule)} ${said}`);
      if (compacted) getDb().run("UPDATE agents SET briefed_at = ? WHERE name = ?", [Date.now(), r.name]);
      return { session: last.id, started: false };
    }
    if (!start) throw new FleetError(409, `${r.name} has no main conversation, and its manifest does not say how to start one`);
    if (this.starting.has(r.name)) return { quiet: `${r.name}'s main conversation is being started this moment` };
    this.starting.add(r.name);
    try {
      const provider = start.provider;
      if (typeof provider !== "string" || !PROVIDERS.includes(provider as ProviderId)) throw new FleetError(400, `${r.name}: main.start.provider must be one of ${PROVIDERS.join(", ")}`);
      const cwd = typeof start.cwd === "string" ? resolve(r.dir, start.cwd.replace(/^~(?=\/|$)/, userHome())) : r.dir;
      mkdirSync(cwd, { recursive: true });
      const closing = !!last && last.status !== "closed";
      const theirs = closing ? this.fleet.startedBy(last!.id) : [];
      const handoff = last ? this.handoffOf(r, last) : "";
      const follows = last
        ? `[agentbox: you take over from ${last.id}, ${r.name}'s main conversation until now (${over}).${handoff ? ` It left you this handoff:\n\n${handoff}\n\n` : " "}What it did is in \`agentbox log ${last.id} | tail -60\`; it will not be spoken to again.${theirs.length ? ` The sessions it started are still at their work and are now listed under you: ${theirs.join(" ")}.` : ""}]`
        : "";
      const ownership = last ? prReleasedLine(last.id) : "";
      const said = "schedule" in from ? `${scheduleSentMark(from.schedule)} ${text}` : text;
      const prompt = [instructions, [ownership, follows, said].filter(Boolean).join("\n\n")].filter(Boolean).join("\n\n---\n\n");
      const { fallbacks, ...spec } = start as Partial<SpawnRequest> & { fallbacks?: unknown };
      const others = Array.isArray(fallbacks) ? fallbacks.filter((p): p is ProviderId => PROVIDERS.includes(p as ProviderId) && p !== provider) : [];
      const asked = { ...spec, provider: provider as ProviderId, cwd, prompt, parent: undefined, callerPid: undefined, id: undefined };
      const session = await this.fleet.spawnFirstWithRoom([asked, ...others.map((p) => ({ ...asked, provider: p, model: undefined, effort: undefined, accountId: null }))]);
      getDb().run("UPDATE agents SET briefed_at = ?, main_send = ? WHERE name = ?", [Date.now(), "sendId" in from ? from.sendId : null, r.name]);
      this.setMain(this.row(r.name), session.id);
      if (closing) await this.retire(r.name, last!.id, session.id);
      // It was told in its first prompt what its predecessor had lost, once.
      if (ownership) prReleaseTold(session.id);
      this.changed();
      return { session: session.id, started: true };
    } finally {
      this.starting.delete(r.name);
    }
  }

  /**
   * `from` is replaced by `to`: handed over at once, mid-turn or not, so what
   * it started, its cards, the PRs it has and any agent's message to it go to
   * `to` from now on. It is closed alone once it is not at work; until then it
   * is the agent's `retiring`, tried again each tick.
   */
  private async retire(name: string, from: string, to: string): Promise<void> {
    try {
      await this.fleet.handOver(from, to);
      moveCards(from, to);
      movePrClaims(from, to);
      const s = this.session(from);
      if (s && s.status !== "closed" && atWork(s)) {
        getDb().run("UPDATE agents SET retiring = ? WHERE name = ?", [from, name]);
        return;
      }
      if (s && s.status !== "closed") await this.fleet.close(from, true, true);
      getDb().run("UPDATE agents SET retiring = NULL WHERE name = ?", [name]);
    } catch (e) {
      console.error(`agentbox: agent ${name}: retiring ${from}:`, e);
    }
  }

  /** Why a main started on a fallback gives way: its own provider has room again. */
  private backHome(start: Record<string, unknown>, last: Session): string | null {
    const provider = start.provider as ProviderId;
    if (last.provider === provider) return null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    if (!this.fleet.placement(provider, str(start.model), str(start.accountId), str(start.effort), true).accountId) return null;
    return `it ran on ${last.provider} while ${provider} had no account with room, and ${provider} has room again`;
  }

  /**
   * A main that is idle, large, and about to go cold is asked, once, to write
   * a handoff for the main that may take over from it: written now, while its
   * cache is warm, it costs a short turn; asked of a cold one, it costs a
   * re-read of everything it holds. The next fresh main is told it.
   */
  private async askHandoff(r: Row, m: Manifest | null, now: number): Promise<void> {
    if (!m?.main?.start) return;
    const main = r.main && this.session(this.fleet.heir(r.main));
    if (!main || main.status !== "waiting" || main.host !== "tmux") return;
    if (main.cacheWarmUntil < now || main.cacheWarmUntil - now > HANDOFF_LEAD_MS) return;
    if ((main.contextUsed ?? 0) < (m.main.freshOver ?? FRESH_OVER) / 2) return;
    if (main.lastPrompt?.startsWith(HANDOFF_ASK)) return;
    const file = join(agentHome(r.name), "handoff.md");
    await this.fleet.note(
      main.id,
      `${HANDOFF_ASK} and your conversation is large, so the next message may start a fresh main conversation in your place. Write what it needs to carry on to ${file}, replacing what is there, in at most 500 words: what you are in the middle of, what you decided and why, what you are waiting on, and who asked for what. Then end your turn without a reply.]`,
    ).catch((e) => console.error(`agentbox: agent ${r.name}: asking ${main.id} for a handoff:`, e));
  }

  /** The handoff `last` wrote, when it wrote one. */
  private handoffOf(r: Row, last: Session): string {
    const file = join(agentHome(r.name), "handoff.md");
    try {
      if (statSync(file).mtimeMs < last.startedAt) return "";
      return readFileSync(file, "utf8").trim().slice(0, 8_000);
    } catch {
      return "";
    }
  }

  private session(id: string): Session | null {
    try {
      return this.fleet.get(id);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- inside

  /** What instructions may name: its directory and home, and the agentbox checkout (its docs, its examples). */
  private fill(text: string, r: Row): string {
    return text.replaceAll("{{dir}}", r.dir).replaceAll("{{home}}", agentHome(r.name)).replaceAll("{{agentbox}}", packageRoot).replaceAll("{{bin}}", agentboxBin());
  }

  private row(name: string): Row {
    if (!NAME.test(name)) throw new FleetError(400, "not an agent name");
    const r = rowOf(name);
    if (!r) throw new FleetError(404, `no agent ${name}`);
    return r;
  }

  private manifestOrError(r: Row): { m: Manifest | null; error: string | null } {
    try {
      return { m: readManifest(r.dir), error: null };
    } catch (e) {
      return { m: null, error: (e as Error).message };
    }
  }

  /**
   * Its main conversation now, following each handover (`Fleet.heir`), so a
   * program that hands its main to a fresh session need not say so twice;
   * the one handed over from goes into `previous`.
   */
  private mainOf(r: Row): string | null {
    if (!r.main) return null;
    const heir = this.fleet.heir(r.main);
    if (heir !== r.main) this.setMain(r, heir);
    return heir;
  }

  private setMain(r: Row, main: string | null): void {
    const prev = JSON.parse(r.previous) as string[];
    const next = r.main && r.main !== main ? [r.main, ...prev.filter((x) => x !== r.main && x !== main)] : prev.filter((x) => x !== main);
    getDb().run("UPDATE agents SET main = ?, previous = ? WHERE name = ?", [main, JSON.stringify(next.slice(0, 200)), r.name]);
  }

  private info(r: Row): AgentInfo {
    const { m, error } = this.manifestOrError(r);
    const main = this.mainOf(r);
    const p = this.procs.get(r.name);
    return {
      name: r.name,
      title: m?.title ?? r.name,
      description: m?.description ?? "",
      dir: r.dir,
      enabled: r.enabled === 1,
      error,
      main,
      previous: JSON.parse(r.previous) as string[],
      canStart: !main && !!m?.main?.start,
      hasPage: !!(m?.url || m?.run),
      process: m?.run
        ? {
            state: p?.child ? "running" : r.enabled !== 1 ? "stopped" : p && p.backoffUntil > Date.now() ? "backoff" : "starting",
            pid: p?.pid ?? null,
            since: p?.since ?? null,
            restarts: p?.restarts ?? 0,
            lastExit: p?.lastExit ?? null,
          }
        : null,
      createdAt: r.created_at,
    };
  }

  private endpoint(name: string): string | null {
    const r = this.row(name);
    const m = readManifest(r.dir);
    if (m.url) return m.url.replace(/\/$/, "");
    const p = this.procs.get(name);
    return m.run && p?.child ? `http://127.0.0.1:${p.port}` : null;
  }

  private async call(name: string, url: string, init: RequestInit, ms: number): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), "x-agentbox-agent-token": agentToken(name) },
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? `did not answer within ${ms / 1000}s` : `could not be reached: ${(e as Error).message}`;
      throw new FleetError(502, `${name} ${why}`);
    }
  }

  /** Start what should run and is not, each after its backoff. */
  private async tick(): Promise<void> {
    const now = Date.now();
    const asking = now - this.handoffsAskedAt >= HANDOFF_CHECK_MS;
    if (asking) this.handoffsAskedAt = now;
    for (const r of rows()) {
      if (r.retiring && r.main && !atWork(this.session(r.retiring))) await this.retire(r.name, r.retiring, this.fleet.heir(r.main));
      if (r.enabled !== 1) continue;
      const { m } = this.manifestOrError(r);
      if (asking) await this.askHandoff(r, m, now);
      if (!m?.run) continue;
      const p = this.procs.get(r.name);
      if (p?.child || (p && p.backoffUntil > now)) continue;
      await this.spawn(r, m, p);
    }
  }

  private async spawn(r: Row, m: Manifest, old: Proc | undefined): Promise<void> {
    const home = agentHome(r.name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const logFile = join(home, "process.log");
    const pidFile = join(home, "pid");
    this.reap(r.name, pidFile);
    const port = await freePort();
    const p: Proc = old ?? { child: null, port, pid: null, since: 0, restarts: 0, backoffUntil: 0, lastExit: null, stopping: false };
    p.port = port;
    p.stopping = false;
    this.procs.set(r.name, p);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // The server's own environment may carry a session's id; the program is not that session.
    delete env.AGENTBOX_SESSION;
    Object.assign(env, {
      AGENTBOX_URL: this.serverUrl,
      AGENTBOX_BIN: agentboxBin(),
      AGENTBOX_AGENT: r.name,
      AGENTBOX_AGENT_DIR: r.dir,
      AGENTBOX_AGENT_HOME: home,
      AGENTBOX_AGENT_TOKEN: agentToken(r.name),
      PORT: String(port),
    });
    const note = (line: string) => this.append(logFile, `[agentbox ${new Date().toISOString()}] ${line}\n`);
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(m.run!, { cwd: r.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      note(`could not start ${JSON.stringify(m.run)}: ${(e as Error).message}`);
      p.lastExit = { code: null, at: Date.now() };
      p.backoffUntil = Date.now() + this.backoff(p);
      p.restarts++;
      return;
    }
    p.child = child;
    p.pid = child.pid;
    writeFileSync(pidFile, String(child.pid));
    p.since = Date.now();
    note(`started ${JSON.stringify(m.run)} as pid ${child.pid} on port ${port}`);
    void this.pipe(child.stdout, logFile);
    void this.pipe(child.stderr, logFile);
    void child.exited.then((code) => {
      const lived = Date.now() - p.since;
      p.child = null;
      p.pid = null;
      p.lastExit = { code, at: Date.now() };
      note(`exited with ${code}${p.stopping ? " (stopped)" : ""}`);
      if (lived >= STEADY_MS) p.restarts = 0;
      p.backoffUntil = p.stopping ? 0 : Date.now() + this.backoff(p);
      if (!p.stopping) p.restarts++;
      this.changed();
    });
    this.changed();
  }

  /** A program a server before this one started and did not see out (a
   *  crash, not a restart: systemd stops the whole unit) is stopped, so two
   *  never run at once. Only a process that is this agent's program. */
  private reap(name: string, pidFile: string): void {
    let pid: number;
    try {
      pid = Number(readFileSync(pidFile, "utf8"));
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 1 || this.procs.get(name)?.pid === pid) return;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.includes(`AGENTBOX_AGENT=${name}`)) process.kill(pid, "SIGTERM");
    } catch {
      // Gone, or not ours to read (macOS has no /proc): nothing to stop.
    }
  }

  private backoff(p: Proc): number {
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(p.restarts, 6));
  }

  private kill(name: string): void {
    const p = this.procs.get(name);
    const child = p?.child;
    if (!p || !child) return;
    p.stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (p.child === child) child.kill("SIGKILL");
    }, 5_000);
  }

  private async pipe(stream: ReadableStream<Uint8Array>, file: string): Promise<void> {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) this.append(file, dec.decode(r.value, { stream: true }));
    } catch {
      // The process went away mid-write: what it said is in the file.
    }
  }

  private append(file: string, text: string): void {
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG) renameSync(file, `${file}.1`);
      appendFileSync(file, text);
    } catch {
      // A full disk loses log lines, not the program.
    }
  }
}

/** Mid-turn, or showing a prompt it needs answered. */
function atWork(s: Session | null): boolean {
  return !!s && (s.status === "running" || s.status === "blocked");
}

/** Why the next message leaves this main for a fresh one, or null when it still goes to it. */
function pastIt(s: Session, freshOver: number): string | null {
  if (s.status === "closed") return "it was closed";
  if (s.limitHit) return "it stopped at a usage limit";
  if ((s.contextUsed ?? 0) > freshOver) return `it held ${Math.round(s.contextUsed! / 1000)}k tokens of context, over the ${Math.round(freshOver / 1000)}k a main is kept to`;
  return null;
}
