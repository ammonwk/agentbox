/**
 * Whether the checkout's branch has commits the running server does not.
 * With serve-from-commit (snapshot.ts) a commit goes live only on a restart,
 * and without it the server runs the files it read when it started: either
 * way a new commit is invisible until someone restarts. The board's Update
 * button says so, and restarts the service on a click (restart.ts).
 */
export type Behind = { running: string; head: string; commits: number };

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

/** Null when the server runs the checkout's HEAD, or when HEAD is not ahead of
 *  it (another branch, a reset): a restart would not bring it newer work. */
export function behindHead(checkout: string, running: string | null | undefined): Behind | null {
  if (!running) return null;
  const head = git(checkout, "rev-parse", "HEAD");
  if (!head.ok || head.out === running) return null;
  if (!git(checkout, "merge-base", "--is-ancestor", running, head.out).ok) return null;
  const n = Number(git(checkout, "rev-list", "--count", `${running}..${head.out}`).out);
  return Number.isFinite(n) && n > 0 ? { running, head: head.out, commits: n } : null;
}
