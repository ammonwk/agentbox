/**
 * What a wait looks at (waits.ts decides what each look means): a pull
 * request's head and checks, a GitHub Actions run, a job's unit, a command.
 *
 * GitHub's rate limit is shared with every agent's `gh`, so every pull
 * request waited on is read in one GraphQL request, and a run by a
 * conditional GET that costs nothing while it has not changed. A limit that
 * has run out is not a failed look: it throws `Held` with the reset, and
 * nothing is asked before then.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { github as request } from "./github";
import type { WaitSpec } from "./types";
import { isLaunchdJob, readLaunchdJob, stopLaunchdJob } from "./job-launchd";
import { ensureCheckout } from "./worktrees";

type PrSpec = Extract<WaitSpec, { kind: "pr" }>;
type JobSpec = Extract<WaitSpec, { kind: "job" }>;
type UntilSpec = Extract<WaitSpec, { kind: "until" }>;

/** GitHub will not answer before `until`. */
export class Held extends Error {
  constructor(readonly until: number) {
    super(`GitHub's rate limit is spent until ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  }
}

export interface Check {
  name: string;
  /** A stable identity for this run of this check, so a re-run counts as fresh. */
  key?: string;
  done: boolean;
  /** Concluded without failing: success, neutral or skipped. */
  ok: boolean;
  /** Its conclusion, or its status while it runs, as GitHub says it. */
  how: string;
}

export interface PrRead {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  base: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: Check[];
  /** Every check could not be read: the rest of the read still stands. */
  checksError?: Error;
  /** A digest of this PR's reviews and comments, never their text; an error when they could not be read. */
  feedback?: { fingerprint: string; count: number } | Error;
}

export interface RunRead {
  status: string;
  conclusion: string;
  name: string;
  url: string;
  head: string;
}

async function github(path: string, init: { method?: string; body?: string; etag?: string | null } = {}): Promise<Response> {
  const res = await request("waits", path, init);
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") throw new Held(resetOf(res));
  return res;
}

/** A minute over the reset GitHub names: its clock and this one differ. */
function resetOf(res: Response): number {
  const at = Number(res.headers.get("x-ratelimit-reset"));
  return (Number.isFinite(at) && at > 0 ? at * 1000 : Date.now() + 10 * 60_000) + 60_000;
}

const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

interface RawContext {
  __typename: string;
  id?: string;
  completedAt?: string;
  createdAt?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

function check(c: RawContext): Check {
  if (c.__typename === "CheckRun") {
    const done = c.status === "COMPLETED";
    return { name: c.name ?? "?", key: `${c.id}:${c.completedAt ?? ""}:${c.conclusion ?? ""}`, done, ok: done && OK.has(c.conclusion ?? ""), how: (done ? (c.conclusion ?? "no conclusion") : (c.status ?? "queued")).toLowerCase() };
  }
  const done = c.state !== "PENDING" && c.state !== "EXPECTED";
  return { name: c.context ?? "?", key: `${c.id}:${c.createdAt ?? ""}:${c.state ?? ""}`, done, ok: c.state === "SUCCESS", how: (c.state ?? "pending").toLowerCase() };
}

const CONTEXTS = `pageInfo{hasNextPage endCursor} nodes{__typename ... on CheckRun{id name status conclusion completedAt} ... on StatusContext{id context state createdAt}}`;

interface Contexts {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawContext[];
}

/** The checks on commit `oid` after the first page's `after`. */
async function restOfChecks(repo: string, oid: string, after: string | null): Promise<RawContext[]> {
  const [owner, name] = repo.split("/");
  const rest: RawContext[] = [];
  for (;;) {
    const query = `{ repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ object(oid:${JSON.stringify(oid)}){ ... on Commit{ statusCheckRollup{contexts(first:100,after:${JSON.stringify(after)}){${CONTEXTS}}} } } } }`;
    const res = await github("/graphql", { method: "POST", body: JSON.stringify({ query }) });
    const body = (await res.json().catch(() => null)) as { data?: { repository?: { object?: { statusCheckRollup?: { contexts: Contexts } | null } | null } | null }; errors?: { type?: string; message?: string }[] } | null;
    if (body?.errors?.some((e) => e.type === "RATE_LIMITED")) throw new Held(resetOf(res));
    const contexts = body?.data?.repository?.object?.statusCheckRollup?.contexts;
    if (!res.ok || !contexts) throw new Error(`GitHub answered ${res.status} reading ${repo}@${oid.slice(0, 10)}'s checks past the first ${100 + rest.length}${body?.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""}`);
    rest.push(...contexts.nodes);
    if (!contexts.pageInfo.hasNextPage) return rest;
    after = contexts.pageInfo.endCursor;
  }
}

export const prKey = (s: Pick<PrSpec, "repo" | "number">): string => `${s.repo}#${s.number}`;

/**
 * Every pull request asked about, in one request: each one's read, or why it
 * could not be read. Throws when GitHub answered nothing usable at all.
 */
export async function readPrs(prs: (Pick<PrSpec, "repo" | "number"> & { feedback?: boolean })[]): Promise<Map<string, PrRead | Error>> {
  const repos = [...new Set(prs.map((p) => p.repo))];
  const fields = `state headRefOid baseRefName mergeable commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){${CONTEXTS}}}}}}`;
  const query = `{ ${repos
    .map((repo, i) => {
      const [owner, name] = repo.split("/");
      const numbers = [...new Set(prs.filter((p) => p.repo === repo).map((p) => p.number))];
      return `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ ${numbers.map((n) => `p${n}: pullRequest(number:${n}){${fields}}`).join(" ")} }`;
    })
    .join(" ")} }`;
  const res = await github("/graphql", { method: "POST", body: JSON.stringify({ query }) });
  const body = (await res.json().catch(() => null)) as { data?: Record<string, Record<string, unknown> | null>; errors?: { type?: string; message?: string; path?: string[] }[] } | null;
  if (body?.errors?.some((e) => e.type === "RATE_LIMITED")) throw new Held(resetOf(res));
  if (!res.ok || !body?.data) throw new Error(`GitHub answered ${res.status}${body?.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""}`);
  const out = new Map<string, PrRead | Error>();
  const overflow: { read: PrRead; repo: string; oid: string; after: string | null }[] = [];
  repos.forEach((repo, i) => {
    for (const p of prs.filter((x) => x.repo === repo)) {
      const node = body.data![`r${i}`]?.[`p${p.number}`] as
        | { state: PrRead["state"]; headRefOid: string; baseRefName: string; mergeable: PrRead["mergeable"]; commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: Contexts } | null } }[] } }
        | null
        | undefined;
      if (!node) {
        const said = body.errors?.find((e) => e.path?.[0] === `r${i}` && (e.path.length === 1 || e.path[1] === `p${p.number}`))?.message;
        out.set(prKey(p), new Error(said ?? `GitHub returned nothing for ${prKey(p)}`));
        continue;
      }
      const commit = node.commits.nodes[0]?.commit;
      // The checks read must be the head's: after a push the two can be a moment apart.
      if (node.state === "OPEN" && commit && commit.oid !== node.headRefOid) {
        out.set(prKey(p), new Error(`GitHub shows ${prKey(p)}'s head as ${node.headRefOid.slice(0, 10)} but its last commit as ${commit.oid.slice(0, 10)}`));
        continue;
      }
      const contexts = commit?.statusCheckRollup?.contexts;
      out.set(prKey(p), { state: node.state, head: node.headRefOid, base: node.baseRefName, mergeable: node.mergeable, checks: (contexts?.nodes ?? []).map(check) });
      if (commit && contexts?.pageInfo.hasNextPage) overflow.push({ read: out.get(prKey(p)) as PrRead, repo, oid: commit.oid, after: contexts.pageInfo.endCursor });
    }
  });
  // A head with more than a page of checks (a release PR's matrix) is read
  // on, page by page. Incomplete checks cannot establish readiness, but must
  // not hide a separately complete review-feedback read.
  await Promise.all(overflow.map(async o => {
    try { o.read.checks.push(...(await restOfChecks(o.repo, o.oid, o.after)).map(check)); }
    catch (e) { o.read.checksError = e instanceof Error ? e : new Error(String(e)); }
  }));
  const feedback = [...new Map(prs.filter(p => p.feedback).map(p => [prKey(p), p])).values()];
  await Promise.all(feedback.map(async p => {
    const read = out.get(prKey(p));
    if (!read || read instanceof Error) return;
    try { read.feedback = await readPrFeedback(p.repo, p.number); }
    catch (e) { read.feedback = e instanceof Error ? e : new Error(String(e)); }
  }));
  return out;
}

/** Each feedback page as last read: asked again conditionally, so a page
 *  that has not changed (a 304) does not spend the REST limit. */
const feedbackPages = new Map<string, { etag: string | null; marks: string[]; next: boolean }>();

/** Review text stays on GitHub. Persist only a digest so edits and new replies
 * wake the owner once, including comments inside previously resolved threads. */
export async function readPrFeedback(repo: string, number: number): Promise<{ fingerprint: string; count: number }> {
  const surfaces = [`pulls/${number}/reviews`, `pulls/${number}/comments`, `issues/${number}/comments`];
  const rows = await Promise.all(surfaces.map(async surface => {
    const marks: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const path = `/repos/${repo}/${surface}?per_page=100&page=${page}`;
      const had = feedbackPages.get(path);
      const res = await github(path, { etag: had?.etag });
      let read = res.status === 304 ? had : undefined;
      if (!read) {
        if (!res.ok) throw new Error(`GitHub answered ${res.status} reading PR feedback`);
        const data = await res.json() as { id: number; state?: string; submitted_at?: string; updated_at?: string; body?: string }[];
        if (!Array.isArray(data) || data.some(r => !Number.isSafeInteger(r?.id))) throw new Error("GitHub returned invalid PR feedback");
        read = {
          etag: res.headers.get("etag"),
          marks: data.filter(r => r.state !== "PENDING").map(r => createHash("sha256").update(JSON.stringify([surface, r.id, r.state, r.submitted_at, r.updated_at, r.body])).digest("hex")),
          next: res.headers.get("link")?.includes('rel="next"') ?? false,
        };
        feedbackPages.set(path, read);
      }
      marks.push(...read.marks);
      if (!read.next) return marks;
    }
    throw new Error("PR feedback exceeds 1000 records on one surface; read it manually before rearming");
  }));
  const marks = rows.flat().sort();
  return { fingerprint: createHash("sha256").update(JSON.stringify(marks)).digest("hex"), count: marks.length };
}

const runs = new Map<string, { etag: string | null; run: RunRead }>();

export async function readRun(repo: string, id: number): Promise<RunRead> {
  const path = `/repos/${repo}/actions/runs/${id}`;
  const had = runs.get(path);
  const res = await github(path, { etag: had?.etag });
  if (res.status === 304 && had) return had.run;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText} for run ${id} of ${repo}`.trim());
  const r = (await res.json()) as { status: string | null; conclusion: string | null; name: string | null; html_url: string; head_sha: string };
  const run = { status: r.status ?? "", conclusion: r.conclusion ?? "", name: r.name ?? "", url: r.html_url, head: r.head_sha };
  if (run.status === "completed") runs.delete(path);
  else runs.set(path, { etag: res.headers.get("etag"), run });
  return run;
}

export interface JobRead {
  /** The command's end (`SERVICE_RESULT EXIT_CODE EXIT_STATUS`), once known. */
  result: { result: string; code: string; status: string } | null;
  /** Its unit is still there and has not finished. */
  running: boolean;
}

/** Asked without blocking: every job wait is looked at every two seconds,
 *  and a loaded machine can take a while to answer. */
export async function readJob(spec: JobSpec): Promise<JobRead> {
  if (existsSync(spec.result)) {
    const [result = "", code = "", status = ""] = readFileSync(spec.result, "utf8").trim().split(/\s+/);
    if (isLaunchdJob(spec.unit)) {
      if (!((result === "success" && code === "exited" && status === "0") ||
        (["exit-code", "launch-error"].includes(result) && code === "exited" && /^-?\d+$/.test(status) && Number(status) !== 0) ||
        (result === "signal" && code === "killed" && status))) throw new Error(`the job's result is incomplete or invalid: ${spec.result}`);
      // Completion evidence survives cleanup. A cleanup failure must not hide it.
      try { await stopLaunchdJob(spec); } catch { /* an inactive one-shot cannot rerun work */ }
    }
    return { result: { result, code, status }, running: false };
  }
  if (isLaunchdJob(spec.unit)) return readLaunchdJob(spec);
  const p = Bun.spawn(["systemctl", "--user", "is-active", spec.unit], {
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` },
  });
  const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const state = out.trim();
  // Only systemd's own word says a unit is gone: no answer is a look that failed.
  if (!["active", "activating", "deactivating", "reloading", "inactive", "failed"].includes(state)) throw new Error(`systemctl would not say whether ${spec.unit} runs: ${err.trim() || `exit ${exit}`}`);
  return { result: null, running: state !== "inactive" && state !== "failed" };
}

/** The end of a job's log, for the message that says it ended: its last 8 KB are read, however long it is. */
export function logTail(path: string, lines = 12, max = 1500): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const buf = Buffer.alloc(Math.min(size, 8192));
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const tail = buf.toString("utf8").trimEnd().split("\n").slice(-lines).join("\n");
    return tail.length > max ? tail.slice(-max) : tail;
  } catch (e) {
    return `(could not be read: ${(e as Error).message})`;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** How long one asking of an `until` command may take. */
const UNTIL_TIMEOUT_S = 120;
const UNTIL_MAX = 4_000;

/**
 * One asking of an `until` command: `yes` with what it printed when it exits
 * 0, `no` (with its last line) when it exits 1 and writes nothing to stderr.
 * Any other exit, an exit 1 with an error on stderr (a `gh` read that failed
 * makes a test after it false), or not finishing, throws: that is the command
 * failing to look, not an answer. Run by
 * `sh -c` in the directory the wait was made in, at the lowest priority, in
 * the server's environment (not the session's), told which wait and session
 * it answers for.
 */
export async function readUntil(spec: UntilSpec, wait: number, session: string, timeoutMs = UNTIL_TIMEOUT_S * 1000): Promise<{ yes: boolean; said: string }> {
  ensureCheckout(spec.cwd);
  // A separate POSIX process group bounds the shell *and* its children on
  // macOS/Linux. Killing only the shell leaves a blocked child holding pipes
  // open; GNU timeout is not installed on a stock Mac. The shorter internal
  // deadline is for exercising cleanup without a two-minute validation delay.
  const { out, tail, err, stderrError, code, signal, timedOut } = await new Promise<{
    out: string; tail: string; err: string; stderrError: boolean; code: number | null; signal: string | null; timedOut: boolean;
  }>((resolve, reject) => {
    const p = spawn("nice", ["-n", "19", "sh", "-c", spec.cmd], {
      cwd: spec.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTBOX_WAIT: String(wait), AGENTBOX_SESSION: session },
    });
    let out = "", tail = "", err = "", stderrError = false, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (p.pid) {
        try { process.kill(-p.pid, "SIGKILL"); }
        catch { p.kill("SIGKILL"); }
      }
      // Even a child which deliberately left the group cannot hold this
      // probe open through an inherited pipe. This is not an OS sandbox.
      p.stdout.destroy();
      p.stderr.destroy();
    }, Math.max(1, Math.min(timeoutMs, UNTIL_TIMEOUT_S * 1000)));
    p.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk.slice(0, Math.max(0, UNTIL_MAX + 1 - out.length));
      tail = (tail + chunk).slice(-200);
    });
    p.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderrError ||= /\S/.test(chunk); err = (err + chunk).slice(-300); });
    p.once("error", e => { clearTimeout(timer); reject(e); });
    p.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ out, tail, err, stderrError, code, signal, timedOut });
    });
  });
  if (timedOut) throw new Error(`the command did not finish in ${timeoutMs / 1000}s`);
  const said = out.trim();
  if (code === 0) return { yes: true, said: said.length > UNTIL_MAX ? `${said.slice(0, UNTIL_MAX)}\n(cut here, at ${UNTIL_MAX} characters)` : said };
  const error = err.trim().split("\n").pop()! || (stderrError ? "stderr contained an error (diagnostic exceeded retained output)" : "");
  if (code === 1 && !error) return { yes: false, said: tail.trim().split("\n").pop()! };
  throw new Error(`the command ${signal ? `was killed by ${signal}` : `exited ${code}`}${error ? `: ${error}` : ""} (0 means it happened, 1 with nothing on stderr not yet)`);
}
