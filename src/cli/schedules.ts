/** Scheduled sessions from the CLI: the same schedules as the app's Schedule…
 *  (src/core/scheduler.ts), so the voice agent and the Project session can
 *  say "start this in 4 hours" too. Plain text out, the id first on every line. */

import { resolve } from "node:path";
import type { Api } from "../client";
import { describeRule, isRecurring, until } from "../core/schedule";
import type { AppState, ProviderId, Schedule } from "../core/types";
import { parseArgs } from "./sessions";

const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp"];
const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** `agentbox schedule <when> [--agent claude] [--cwd DIR] [--big] [--account A] [--model M] [--effort E] [--name N] <prompt…|->` */
export async function schedule(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["agent", "cwd", "account", "model", "effort", "name"], ["big"]);
  const [when, ...words] = rest;
  if (!when) throw new Error('schedule needs a time and a prompt: agentbox schedule "tomorrow at 9am" fix the flaky test');
  const agent = (str(flags.get("agent")) ?? "claude") as ProviderId;
  if (!PROVIDERS.includes(agent)) throw new Error(`--agent must be one of ${PROVIDERS.join(", ")}`);
  const prompt = words.length === 1 && words[0] === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : words.join(" ").trim();
  if (!prompt) throw new Error("a scheduled session needs a prompt (the words after the time, or - to read it from stdin)");

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
    spec: {
      provider: agent,
      cwd: resolve(str(flags.get("cwd")) ?? process.cwd()),
      prompt,
      model: str(flags.get("model")),
      effort: str(flags.get("effort")),
      big: flags.has("big"),
      accountId,
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
  const next = !sc.enabled ? "paused" : sc.nextAt ? until(sc.nextAt) : sc.rule.kind === "merge" ? "on merge" : "—";
  const rule = isRecurring(sc.rule) ? `${describeRule(sc.rule)}, repeating` : describeRule(sc.rule);
  const failed = sc.lastError ? `  [last start failed: ${sc.lastError}]` : "";
  return `${sc.id}  ${next.padEnd(7)} ${rule} · ${sc.spec.provider} · ${title}${failed}`;
}
