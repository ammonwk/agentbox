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
 * pushes in a row are one session, not ten. A new streak while that session
 * is still at work is its too: the next starts once it stops, if still red.
 */

import { basename } from "node:path";
import { github } from "./github";
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
 * The red streak the workflow is in, or null when it is green or every red run
 * in it finished before the session started at `startedAt`. A red run that
 * finished after it needs a session once that one stops (the scheduler waits
 * while it is at work): 10-23 staging's candidate went red again a day after
 * its session ended, with no green run between, and nobody was started.
 */
export function redStreak(runs: WorkflowRun[], startedAt: number | null): RedStreak | null {
  const settled = runs
    .filter((r) => r.status === "completed" && (r.conclusion === "success" || RED.has(r.conclusion)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const i = settled.findIndex((r) => r.conclusion === "success");
  const failed = i === -1 ? settled : settled.slice(0, i);
  if (!failed.length) return null;
  const lastGreen = i === -1 ? null : settled[i]!;
  if (startedAt !== null && Date.parse(failed[0]!.updatedAt) <= startedAt) return null;
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

/** What was read last for a workflow and branch, and GitHub's tag for it. */
const read = new Map<string, { etag: string | null; runs: WorkflowRun[] }>();

interface RawRun {
  id: number; status: string | null; conclusion: string | null; created_at: string; updated_at: string;
  html_url: string; head_sha: string; display_title: string; event: string;
}

/**
 * The workflow's newest runs on its branch: one conditional GET, which GitHub
 * answers 304 and counts against nothing while no run has changed. `gh run
 * list --workflow` was two calls each time, 60 an hour per rule, on the
 * counter that ran dry (GitHub meters one run and workflows apart from run
 * lists). A rule made before its workflow's file was recorded still asks `gh`.
 */
export async function readRuns(rule: RedRule): Promise<WorkflowRun[]> {
  if (!rule.repo || !rule.branch) throw new Error("it does not know its repo and branch yet");
  if (!rule.file) {
    const out = await gh([
      "run", "list", "-R", rule.repo, "--workflow", rule.workflow, "--branch", rule.branch,
      "--limit", String(RUNS_READ), "--json", "databaseId,status,conclusion,createdAt,updatedAt,url,headSha,displayTitle,event",
    ]);
    return JSON.parse(out) as WorkflowRun[];
  }
  const path = `/repos/${rule.repo}/actions/workflows/${encodeURIComponent(rule.file)}/runs?branch=${encodeURIComponent(rule.branch)}&per_page=${RUNS_READ}`;
  const had = read.get(path);
  const res = await github("redwatch", path, { etag: had?.etag });
  if (res.status === 304 && had) return had.runs;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`.trim());
  const body = (await res.json()) as { workflow_runs: RawRun[] };
  const runs = body.workflow_runs.map((r) => ({
    databaseId: r.id, status: r.status ?? "", conclusion: r.conclusion ?? "", createdAt: r.created_at, updatedAt: r.updated_at,
    url: r.html_url, headSha: r.head_sha, displayTitle: r.display_title, event: r.event,
  }));
  read.set(path, { etag: res.headers.get("etag"), runs });
  return runs;
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
