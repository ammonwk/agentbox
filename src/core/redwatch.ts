/**
 * "Whenever CD on staging is red" (schedule.ts): a workflow's runs read from
 * GitHub, and a red streak told from one that already has its session. The
 * scheduler (scheduler.ts) reads them every two minutes and starts a session
 * for each new red streak.
 *
 * Red is the newest run that finished red. Cancelled and skipped runs say
 * nothing about the code, so they are passed over. A streak is the red runs
 * since the last green one, and it has had its session once one started after
 * that green run: the session owns the streak until it is green, so ten red
 * pushes in a row are one session, not ten.
 */

import { basename } from "node:path";
import type { ScheduleRule } from "./schedule";

type RedRule = Extract<ScheduleRule, { kind: "red" }>;

export interface WorkflowRun {
  databaseId: number;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  headSha: string;
  displayTitle: string;
  event: string;
}

export interface RedStreak {
  /** Newest first. */
  failed: WorkflowRun[];
  /** The newest green run before them; null when none is among those read. */
  lastGreen: WorkflowRun | null;
}

const RED = new Set(["failure", "timed_out", "startup_failure"]);
/** How many runs are read: a streak longer than this is one, whatever its start. */
const RUNS_READ = 30;

/**
 * The red streak the workflow is in, or null when it is green or the streak
 * already had a session: one started at `startedAt`, after its last green run.
 */
export function redStreak(runs: WorkflowRun[], startedAt: number | null): RedStreak | null {
  const settled = runs
    .filter((r) => r.status === "completed" && (r.conclusion === "success" || RED.has(r.conclusion)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const i = settled.findIndex((r) => r.conclusion === "success");
  const failed = i === -1 ? settled : settled.slice(0, i);
  if (!failed.length) return null;
  const lastGreen = i === -1 ? null : settled[i]!;
  if (startedAt !== null && (!lastGreen || Date.parse(lastGreen.updatedAt) <= startedAt)) return null;
  return { failed, lastGreen };
}

/** What the session it starts is told first, before its prompt. */
export function redNote(rule: RedRule, streak: RedStreak | null, lastSessionId: string | null): string {
  const where = `${rule.workflow} on ${rule.branch} (${rule.repo})`;
  const run = (r: WorkflowRun) => `${r.url} · ${r.conclusion} · ${r.headSha.slice(0, 10)} “${r.displayTitle}” · ${r.event} · finished ${r.updatedAt}`;
  const lines = streak
    ? [
        `[agentbox: ${where} is red. Its red runs since the last green one, newest first:`,
        ...streak.failed.map((r) => `- ${run(r)}`),
        streak.lastGreen ? `The last green run: ${run(streak.lastGreen)}` : `No green run among its last ${RUNS_READ}.`,
      ]
    : [`[agentbox: started by hand. ${where} is not in a red streak right now; check its runs before anything else.`];
  if (lastSessionId) lines.push(`The session this schedule started last: ${lastSessionId}.`);
  return `${lines.join("\n")}]`;
}

/** The workflow's newest runs on its branch. */
export async function readRuns(rule: RedRule): Promise<WorkflowRun[]> {
  if (!rule.repo || !rule.branch) throw new Error("it does not know its repo and branch yet");
  const out = await gh([
    "run", "list", "-R", rule.repo, "--workflow", rule.file ?? rule.workflow, "--branch", rule.branch,
    "--limit", String(RUNS_READ), "--json", "databaseId,status,conclusion,createdAt,updatedAt,url,headSha,displayTitle,event",
  ]);
  return JSON.parse(out) as WorkflowRun[];
}

/** The workflow named, by its name or its file, as GitHub has it. */
export async function findWorkflow(repo: string, named: string): Promise<{ name: string; file: string }> {
  const all = JSON.parse(await gh(["workflow", "list", "-R", repo, "--all", "--limit", "500", "--json", "name,path"])) as { name: string; path: string }[];
  const want = named.toLowerCase();
  const hit =
    all.find((w) => w.name.toLowerCase() === want) ??
    all.find((w) => {
      const file = basename(w.path).toLowerCase();
      return file === want || file.replace(/\.ya?ml$/, "") === want;
    });
  if (!hit) throw new Error(`${repo} has no workflow “${named}”; it has ${all.map((w) => w.name).join(", ")}`);
  return { name: hit.name, file: basename(hit.path) };
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await gh(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
}

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim().split("\n")[0] || `gh exited ${code}`);
  return out;
}
