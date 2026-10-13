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
import type { WaitSpec } from "./types";

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
}

export interface RunRead {
  status: string;
  conclusion: string;
  name: string;
  url: string;
  head: string;
}

let token: string | null = null;

async function github(path: string, init: { method?: string; body?: string; etag?: string | null } = {}): Promise<Response> {
  if (!token) {
    const p = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 || !out.trim()) throw new Error(`gh has no GitHub login to read with: ${err.trim().split("\n")[0] || `gh exited ${code}`}`);
    token = out.trim();
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.etag ? { "If-None-Match": init.etag } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) token = null;
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
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

function check(c: RawContext): Check {
  if (c.__typename === "CheckRun") {
    const done = c.status === "COMPLETED";
    return { name: c.name ?? "?", done, ok: done && OK.has(c.conclusion ?? ""), how: (done ? (c.conclusion ?? "no conclusion") : (c.status ?? "queued")).toLowerCase() };
  }
  const done = c.state !== "PENDING" && c.state !== "EXPECTED";
  return { name: c.context ?? "?", done, ok: c.state === "SUCCESS", how: (c.state ?? "pending").toLowerCase() };
}

export const prKey = (s: Pick<PrSpec, "repo" | "number">): string => `${s.repo}#${s.number}`;

/**
 * Every pull request asked about, in one request: each one's read, or why it
 * could not be read. Throws when GitHub answered nothing usable at all.
 */
export async function readPrs(prs: Pick<PrSpec, "repo" | "number">[]): Promise<Map<string, PrRead | Error>> {
  const repos = [...new Set(prs.map((p) => p.repo))];
  const fields = `state headRefOid baseRefName mergeable commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){totalCount nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}`;
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
  repos.forEach((repo, i) => {
    for (const p of prs.filter((x) => x.repo === repo)) {
      const node = body.data![`r${i}`]?.[`p${p.number}`] as
        | { state: PrRead["state"]; headRefOid: string; baseRefName: string; mergeable: PrRead["mergeable"]; commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: { totalCount: number; nodes: RawContext[] } } | null } }[] } }
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
      if (contexts && contexts.totalCount > contexts.nodes.length) {
        out.set(prKey(p), new Error(`${prKey(p)} has ${contexts.totalCount} checks on its head, more than one look reads (${contexts.nodes.length})`));
        continue;
      }
      out.set(prKey(p), { state: node.state, head: node.headRefOid, base: node.baseRefName, mergeable: node.mergeable, checks: (contexts?.nodes ?? []).map(check) });
    }
  });
  return out;
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
  /** What systemd said of its end (`SERVICE_RESULT EXIT_CODE EXIT_STATUS`), once it has ended. */
  result: { result: string; code: string; status: string } | null;
  /** Its unit is still there and has not finished. */
  running: boolean;
}

export function readJob(spec: JobSpec): JobRead {
  if (existsSync(spec.result)) {
    const [result = "", code = "", status = ""] = readFileSync(spec.result, "utf8").trim().split(/\s+/);
    return { result: { result, code, status }, running: false };
  }
  const p = Bun.spawnSync(["systemctl", "--user", "is-active", spec.unit], { timeout: 10_000, env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` } });
  const state = p.stdout.toString().trim();
  // Only systemd's own word says a unit is gone: no answer is a look that failed.
  if (!["active", "activating", "deactivating", "reloading", "inactive", "failed"].includes(state)) throw new Error(`systemctl would not say whether ${spec.unit} runs: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`);
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
export async function readUntil(spec: UntilSpec, wait: number, session: string): Promise<{ yes: boolean; said: string }> {
  if (!existsSync(spec.cwd)) throw new Error(`its directory is gone: ${spec.cwd}`);
  const p = Bun.spawn(["nice", "-n", "19", "timeout", "--kill-after=5", String(UNTIL_TIMEOUT_S), "sh", "-c", spec.cmd], {
    cwd: spec.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTBOX_WAIT: String(wait), AGENTBOX_SESSION: session },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const said = out.trim();
  if (code === 0) return { yes: true, said: said.length > UNTIL_MAX ? `${said.slice(0, UNTIL_MAX)}\n(cut here, at ${UNTIL_MAX} characters)` : said };
  const error = err.trim().split("\n").pop()!.slice(0, 300);
  if (code === 1 && !error) return { yes: false, said: said.split("\n").pop()!.slice(0, 200) };
  if (code === 124 || code === 137) throw new Error(`the command did not finish in ${UNTIL_TIMEOUT_S}s`);
  throw new Error(`the command exited ${code}${error ? `: ${error}` : ""} (0 means it happened, 1 with nothing on stderr not yet)`);
}
