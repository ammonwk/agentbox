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
 * snapshot is cached. It must never be called from a broadcast path.
 */

import { run } from "./core/git";
import type { DepSnapshot, DepStatus } from "./core/types";

export type { DepSnapshot, DepState, DepStatus } from "./core/types";

/**
 * Long enough that nothing can turn `/api/health` into a subprocess treadmill;
 * `?refresh=1` exists for the case that actually needs freshness, a user who
 * has just fixed their `gh` auth and pressed Re-check.
 */
const TTL_MS = 60_000;

interface Attempt {
  code: number;
  /** Everything the program said, both streams, trimmed. */
  said: string;
  /** The program could not be found to run at all. */
  absent: boolean;
}

function attempt(cmd: string[]): Attempt {
  const res = run(cmd);
  const said = `${res.stderr}\n${res.stdout}`.trim();
  return {
    code: res.code,
    said,
    absent: /executable not found|command not found|ENOENT|no such file/i.test(said),
  };
}

function probeTmux(): DepStatus {
  const r = attempt(["tmux", "-V"]);
  if (r.absent) {
    return { state: "missing", detail: "tmux is not on PATH — every agentbox session runs in tmux, so nothing can start without it" };
  }
  if (r.code !== 0) {
    return { state: "unusable", detail: `tmux is installed but will not run: ${r.said.split("\n")[0]?.slice(0, 160)}` };
  }
  return { state: "ok", detail: r.said.split("\n")[0]?.trim() || "installed" };
}

function probeGit(): DepStatus {
  const r = attempt(["git", "--version"]);
  if (r.absent) {
    return { state: "missing", detail: "git is not on PATH — sessions cannot cut worktrees without it" };
  }
  if (r.code !== 0) {
    return { state: "unusable", detail: `git is installed but will not run: ${r.said.split("\n")[0]?.slice(0, 160)}` };
  }
  return { state: "ok", detail: r.said.split("\n")[0]?.trim() || "installed" };
}

export function probeGh(): DepStatus {
  const r = attempt(["gh", "auth", "status"]);
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

/** The cached dependency states, re-probed when stale or when forced. */
export function dependencies(force = false): DepSnapshot {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached;
  cached = { tmux: probeTmux(), gh: probeGh(), git: probeGit(), at: Date.now() };
  return cached;
}
