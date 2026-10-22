/** Scheduled sessions from the CLI: the same schedules as the app's Schedule…
 *  (src/core/scheduler.ts), so the voice agent and the Project session can
 *  say "start this in 4 hours" too. Plain text out, the id first on every line. */

import { resolve } from "node:path";
import type { Api } from "../client";
import { describeRule, isRecurring, until } from "../core/schedule";
import type { AppState, ProviderId, Schedule } from "../core/types";
import { parseArgs } from "./sessions";

const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp", "opencode", "muse"];
const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** `agentbox schedule <when> [--provider claude] [--fallback omp,codex] [--cwd DIR] [--account A] [--model M] [--effort E] [--name N]
 *  [--note-cmd CMD] [--to AGENT] [--org|--personal] <prompt…|->` */
export async function schedule(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["provider", "fallback", "cwd", "account", "model", "effort", "name", "note-cmd", "to"], ["org", "personal"]);
  const [when, ...words] = rest;
  if (!when) throw new Error('schedule needs a time and a prompt: agentbox schedule "tomorrow at 9am" fix the flaky test');
  const agent = (str(flags.get("provider")) ?? "claude") as ProviderId;
  if (!PROVIDERS.includes(agent)) throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}`);
  const fallbacks = str(flags.get("fallback"))?.split(",").map((p) => p.trim()).filter(Boolean) as ProviderId[] | undefined;
  for (const p of fallbacks ?? []) if (!PROVIDERS.includes(p)) throw new Error(`--fallback takes providers from ${PROVIDERS.join(", ")}`);
  const prompt = words.length === 1 && words[0] === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : words.join(" ").trim();
  const noteCmd = str(flags.get("note-cmd"));
  if (!prompt && !noteCmd) throw new Error("a scheduled session needs a prompt (the words after the time, or - to read it from stdin)");
  const to = str(flags.get("to"));

  let accountId: string | null = null;
  const wanted = str(flags.get("account"));
  if (wanted) {
    const s = await api<AppState>("GET", "/api/state");
    const match = s.accounts.find((a) => a.provider === agent && (a.id === wanted || a.label === wanted || a.email === wanted));
    if (!match) throw new Error(`no ${agent} account "${wanted}"`);
    accountId = match.id;
  }

  const sc = await api<Schedule>("POST", "/api/schedules", {
    when,
    label: str(flags.get("name")),
    noteCmd,
    agent: to,
    spec: to ? { prompt: prompt || undefined } : {
      provider: agent,
      cwd: resolve(str(flags.get("cwd")) ?? process.cwd()),
      prompt: prompt || undefined,
      model: str(flags.get("model")),
      effort: str(flags.get("effort")),
      accountId,
      fallbacks,
      scope: flags.has("org") ? "org" : flags.has("personal") ? "personal" : undefined,
    },
  });
  console.log(line(sc));
  return 0;
}

/** `agentbox schedules [--json]`: what is set to start, soonest first. */
export async function list(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, [], ["json"]);
  const { schedules } = await api<AppState>("GET", "/api/state");
  if (flags.has("json")) console.log(JSON.stringify(schedules, null, 2));
  else if (schedules.length === 0) console.error("nothing scheduled");
  else for (const sc of schedules) console.log(line(sc));
  return 0;
}

/** `agentbox unschedule <id>...`: it will not start. Sessions it started stay. */
export async function unschedule(api: Api, args: string[]): Promise<number> {
  const { rest } = parseArgs(args, []);
  if (rest.length === 0) throw new Error("unschedule needs schedule ids (agentbox schedules lists them)");
  let failed = 0;
  for (const id of rest) {
    try {
      await api("DELETE", `/api/schedules/${encodeURIComponent(id)}`);
      console.log(`${id}  unscheduled`);
    } catch (e) {
      failed++;
      console.error(`${id}  unschedule failed: ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

/** `id  when (next)  what`: one line per schedule. */
function line(sc: Schedule): string {
  const title = sc.label?.trim() || sc.spec.prompt?.split("\n")[0]?.slice(0, 70) || "";
  const next = !sc.enabled ? "paused" : sc.nextAt ? until(sc.nextAt) : sc.rule.kind === "merge" ? "on merge" : sc.rule.kind === "red" ? "on red" : "—";
  const rule = isRecurring(sc.rule) ? `${describeRule(sc.rule)}, repeating` : describeRule(sc.rule);
  const failed = sc.lastError ? `  [last time: ${sc.lastError}]` : "";
  const who = sc.agent ? `to ${sc.agent}` : [sc.spec.provider, ...(sc.spec.fallbacks ?? [])].join(" → ");
  return `${sc.id}  ${next.padEnd(7)} ${rule} · ${who} · ${title}${kind(sc)}${failed}`;
}

/** What sets a note-command schedule or one that speaks to an agent apart, and
 *  when it last had something to say: ` · note: cmd · last note 12m ago`. */
function kind(sc: Schedule): string {
  if (!sc.noteCmd && !sc.agent) return "";
  const parts: string[] = [];
  if (sc.noteCmd) parts.push(`note: ${sc.noteCmd}`);
  parts.push(sc.lastRunAt ? `last ${sc.noteCmd ? "note" : "said"} ${ago(sc.lastRunAt)} ago` : `no ${sc.noteCmd ? "note" : "run"} yet`);
  return ` · ${parts.join(" · ")}`;
}

function ago(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)}d`;
}
