/** Whether the external programs agentbox needs are present *and usable*.
 *
 * The distinction is the whole point. `gh` on PATH but logged out reports the
 * same way as "this user has no open PRs": an empty Inbox, no session ever
 * reaching `done`, and nothing anywhere saying why. So this reports three
 * states — `ok`, `unusable` (installed, cannot be used, with the reason) and
 * `missing` — and never collapses the middle one into either neighbour.
 *
 * Each probe RUNS the program rather than asking `Bun.which` whether it exists
 * and then running it. Those two can disagree — `which` answered "installed"
 * for a `gh` the very next spawn could not find — and a probe whose two halves
 * disagree reports the wrong state in exactly the case it exists to catch.
 *
 * Probing costs subprocesses and `gh auth status` can touch the network, so the
 * snapshot is cached, a stale one is answered while it is probed again, and a
 * probe never blocks the server: a `gh` waiting on GitHub once held its event
 * loop for eight minutes. It must never be called from a broadcast path.
 */

import type { DepSnapshot, DepStatus } from "./core/types";

export type { DepSnapshot, DepStatus } from "./core/types";

/**
 * Long enough that nothing can turn `/api/health` into a subprocess treadmill;
 * `?refresh=1` exists for the case that actually needs freshness, a user who
 * has just fixed their `gh` auth and pressed Re-check.
 */
const TTL_MS = 60_000;
/** A probe still running after this is killed. */
const PROBE_TIMEOUT_MS = 10_000;

interface Attempt {
  code: number;
  stdout: string;
  /** Everything the program said, both streams, trimmed. */
  said: string;
  /** The program could not be found to run at all. */
  absent: boolean;
  /** Killed at PROBE_TIMEOUT_MS. */
  timedOut: boolean;
}

async function attempt(cmd: string[]): Promise<Attempt> {
  try {
    const p = Bun.spawn(cmd, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, said: `${stderr}\n${stdout}`.trim(), absent: false, timedOut: p.signalCode !== null };
  } catch (err) {
    // Bun.spawn throws on a missing binary rather than exiting non-zero.
    return { code: 127, stdout: "", said: (err as Error).message, absent: true, timedOut: false };
  }
}

async function probeTmux(): Promise<DepStatus> {
  const r = await attempt(["tmux", "-V"]);
  if (r.absent) {
    return { state: "missing", detail: "tmux is not on PATH — every agentbox session runs in tmux, so nothing can start without it" };
  }
  if (r.code !== 0) {
    return { state: "unusable", detail: `tmux is installed but will not run: ${r.said.split("\n")[0]?.slice(0, 160)}` };
  }
  return { state: "ok", detail: r.said.split("\n")[0]?.trim() || "installed" };
}

async function probeGit(): Promise<DepStatus> {
  const r = await attempt(["git", "--version"]);
  if (r.absent) {
    return { state: "missing", detail: "git is not on PATH — sessions cannot cut worktrees without it" };
  }
  if (r.code !== 0) {
    return { state: "unusable", detail: `git is installed but will not run: ${r.said.split("\n")[0]?.slice(0, 160)}` };
  }
  return { state: "ok", detail: r.said.split("\n")[0]?.trim() || "installed" };
}

/** What `gh auth status --json hosts` says of one account. */
interface GhAuthEntry {
  state?: string;
  error?: string;
  login?: string;
}

async function probeGh(): Promise<DepStatus> {
  // The JSON form, because it is the only one that tells a token GitHub
  // refused from a GitHub that could not be reached: offline, the text form
  // calls every token "invalid", so a laptop waking up read as logged out.
  const res = await attempt(["gh", "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"]);
  if (res.timedOut) return { state: "ok", detail: `GitHub did not answer gh in ${PROBE_TIMEOUT_MS / 1000}s, so its login is unchecked` };
  let hosts: Record<string, GhAuthEntry[]> | undefined;
  try {
    hosts = (JSON.parse(res.stdout) as { hosts?: Record<string, GhAuthEntry[]> }).hosts;
  } catch {
    // A gh too old for --json (or --active) says so here; ask it the old way.
    return probeGhText();
  }
  const entry = hosts?.["github.com"]?.[0];
  if (!entry) {
    return { state: "unusable", detail: "gh is installed but not authenticated — run `gh auth login`. Pull requests are invisible until you do." };
  }
  if (entry.state === "success") {
    return { state: "ok", detail: entry.login ? `authenticated as ${entry.login}` : "authenticated" };
  }
  if (/\b401\b|bad credentials/i.test(entry.error ?? "")) {
    return { state: "unusable", detail: "gh's token was refused by GitHub — run `gh auth login`. Pull requests are invisible until you do." };
  }
  // No answer, or not one about the token: it is logged in, just unchecked.
  // A token that turns out bad is the pull request sync's warning to raise.
  return { state: "ok", detail: `logged in${entry.login ? ` as ${entry.login}` : ""}; GitHub did not answer, so the token is unchecked` };
}

async function probeGhText(): Promise<DepStatus> {
  const r = await attempt(["gh", "auth", "status"]);
  if (r.absent) {
    return { state: "missing", detail: "gh is not installed — pull request data will be empty (cli.github.com)" };
  }
  if (r.code === 0) {
    const account = /Logged in to \S+ account (\S+)/.exec(r.said)?.[1];
    return { state: "ok", detail: account ? `authenticated as ${account}` : "authenticated" };
  }
  // The exit code alone does not say why, and the reason is the actionable
  // part — logged out and "token lost a scope" read identically here.
  const first = r.said.split("\n")[0] ?? "";
  return {
    state: "unusable",
    detail: /not logged|no accounts|authentication/i.test(r.said)
      ? "gh is installed but not authenticated — run `gh auth login`. Pull requests are invisible until you do."
      : `gh is installed but unusable: ${first.slice(0, 160)}`,
  };
}

let cached: DepSnapshot | null = null;
let probing: Promise<DepSnapshot> | null = null;

async function probeAll(): Promise<DepSnapshot> {
  const [tmux, gh, git] = await Promise.all([probeTmux(), probeGh(), probeGit()]);
  cached = { tmux, gh, git, at: Date.now() };
  return cached;
}

/** The dependency states: a stale snapshot is answered while it is probed
 *  again; with `force`, or with none yet, the probe is waited for. */
export function dependencies(force = false): Promise<DepSnapshot> {
  const fresh = cached !== null && Date.now() - cached.at < TTL_MS;
  if (force || !fresh) probing ??= probeAll().finally(() => { probing = null; });
  return force || !cached ? probing! : Promise.resolve(cached);
}
