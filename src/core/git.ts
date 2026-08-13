import { join } from "node:path";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { repoRoot, worktreeRoot } from "./paths";
import type { Repo } from "./types";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command synchronously and capture output.
 *
 * `GIT_TERMINAL_PROMPT=0` is load-bearing: several of the calls below reach a
 * remote (`ls-remote`, `fetch`, `clone`), and against a private repo with no
 * usable credentials git would otherwise block forever on a username prompt
 * that nobody is there to answer — a server process with no terminal. With it,
 * git fails immediately and the caller gets a message it can show.
 */
export function run(cmd: string[], cwd?: string, env?: Record<string, string>): CmdResult {
  try {
    const res = Bun.spawnSync(cmd, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: res.exitCode ?? -1,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  } catch (err) {
    // Bun.spawnSync THROWS on a missing binary rather than returning a non-zero
    // exit — so without this, an absent `gh` propagates an exception out of the
    // cold refresh instead of becoming the warning the UI is supposed to show.
    // 127 is the shell's own "command not found", which every caller here
    // already treats as a failed command.
    return { code: MISSING_BINARY, stdout: "", stderr: `${cmd[0]}: ${(err as Error).message}` };
  }
}

/** Exit code we synthesise when the executable itself is not on PATH. */
export const MISSING_BINARY = 127;

/** First non-empty line of a command's stderr, for error messages. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : "";
}

/** True if the local path is a git work tree (a .git dir or file present). */
export function isGitRepo(path: string): boolean {
  if (!existsSync(path)) return false;
  return existsSync(join(path, ".git"));
}

/** Canonical on-disk checkout path for a repo record. */
export function repoCheckoutPath(repo: Repo): string {
  if (repo.kind === "local") return repo.ref;
  const safe = repo.ref.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(repoRoot(), safe);
}

/**
 * Resolve a repo into a local checkout that worktrees can be carved from.
 * Local repos are used in place; GitHub slugs are cloned under repoRoot.
 * Returns the canonical local repo path.
 */
export function ensureRepoClone(repo: Repo): { path: string; fullName: string | null } {
  if (repo.kind === "local") {
    // A local checkout can still have a GitHub origin, which is what makes its
    // PRs findable. The slug is resolved at registration; re-resolve only if
    // the record predates that.
    return { path: repo.ref, fullName: repo.fullName ?? repoFullNameOf(repo.ref) };
  }
  const dest = repoCheckoutPath(repo);
  if (!existsSync(join(dest, ".git"))) {
    mkdirSync(repoRoot(), { recursive: true });
    const r = run(["git", "clone", "--", `https://github.com/${repo.ref}.git`, dest]);
    if (r.code !== 0) throw new Error(`clone failed: ${firstLine(r.stderr)}`);
  }
  return { path: dest, fullName: repo.fullName ?? repo.ref };
}

// ------------------------------------------------------------- branches

function refExists(repoPath: string, ref: string): boolean {
  return run(["git", "show-ref", "--verify", "--quiet", ref], repoPath).code === 0;
}

/**
 * The branch new worktrees are cut from. Resolved once at registration and
 * stored on the Repo — asking git on every spawn is a round-trip we do not need,
 * and a repo's default branch effectively never changes.
 *
 * `origin/HEAD` is the authoritative answer but is only present when the clone
 * set it up; the fallbacks walk down from there to whatever the repo can tell
 * us, and finally to the branch that is checked out right now (which is the
 * right answer for a local repo with no remote at all).
 */
export function resolveDefaultBranch(repoPath: string): string {
  const symbolic = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
  if (symbolic.code === 0) {
    const name = symbolic.stdout.trim().replace(/^origin\//, "");
    if (name) return name;
  }
  // origin exists but HEAD was never recorded locally (a --depth or -b clone).
  // Ask the remote once; this is registration-time, so a network call is fine.
  if (run(["git", "remote", "get-url", "origin"], repoPath).code === 0) {
    const remote = run(["git", "ls-remote", "--symref", "origin", "HEAD"], repoPath);
    const m = remote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    if (m) return m[1];
  }
  for (const candidate of ["main", "master"]) {
    if (refExists(repoPath, `refs/heads/${candidate}`)) return candidate;
  }
  const head = run(["git", "branch", "--show-current"], repoPath).stdout.trim();
  if (head) return head;
  // A repo with no commits has no branch to report; `main` is git's own default.
  return "main";
}

/**
 * The ref a new worktree should be cut from, preferring the remote's view of the
 * default branch over a possibly stale local copy. Returns null when neither
 * exists, in which case the caller cuts from HEAD.
 */
function startPointFor(repoPath: string, defaultBranch: string): string | null {
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  if (refExists(repoPath, remoteRef)) {
    // Best-effort refresh so the worktree is not cut from a week-old fetch.
    // Offline is a normal state here, so a failure just means we use what we have.
    run(["git", "fetch", "--quiet", "origin", defaultBranch], repoPath);
    return `origin/${defaultBranch}`;
  }
  if (refExists(repoPath, `refs/heads/${defaultBranch}`)) return defaultBranch;
  return null;
}

// ------------------------------------------------------------ worktrees

/** Worktree paths git currently has registered for this repo. */
function registeredWorktrees(repoPath: string): Set<string> {
  const r = run(["git", "worktree", "list", "--porcelain"], repoPath);
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) out.add(line.slice("worktree ".length).trim());
  }
  return out;
}

/**
 * Create a worktree at worktreeRoot/<id>.
 *
 * With `fromBranch`, check out that existing branch. Otherwise create `branch`,
 * cut from the repo's default branch rather than whatever HEAD happens to be —
 * HEAD is wherever the human last left the checkout, which is not a base anyone
 * asked for.
 */
export function createWorktree(
  repo: Repo,
  id: string,
  branch: string,
  fromBranch?: string
): { path: string; fullName: string | null } {
  const { path: repoPath, fullName } = ensureRepoClone(repo);
  mkdirSync(worktreeRoot(), { recursive: true });
  const abs = join(worktreeRoot(), id);

  // Clear registrations whose directory a previous run deleted; without this,
  // git refuses the path as "already registered" for a worktree that is gone.
  run(["git", "worktree", "prune"], repoPath);

  if (existsSync(abs)) {
    if (registeredWorktrees(repoPath).has(abs) && isGitRepo(abs)) {
      // A retried spawn for the same session id: the worktree we would have
      // created already exists and belongs to this repo. Reuse it.
      return { path: abs, fullName };
    }
    if (readdirSync(abs).length > 0) {
      throw new Error(`worktree path is already occupied and is not a checkout of this repo: ${abs}`);
    }
    // An empty leftover directory is harmless; git will populate it.
  }

  const target = fromBranch ?? branch;
  const targetExists = refExists(repoPath, `refs/heads/${target}`);

  if (fromBranch && !targetExists) {
    // Branch we were asked to continue only exists on the remote (or is a PR ref).
    const fetched = run(["git", "fetch", "origin", `${fromBranch}:refs/heads/${fromBranch}`], repoPath);
    if (fetched.code !== 0) {
      const pr = run(["git", "fetch", "origin", `pull/${fromBranch}/head:refs/heads/${fromBranch}`], repoPath);
      if (pr.code !== 0) {
        throw new Error(`branch "${fromBranch}" is not in this repo or on its remote`);
      }
    }
  }

  const checkedOutElsewhere = (): string | null => {
    const r = run(["git", "worktree", "list", "--porcelain"], repoPath);
    if (r.code !== 0) return null;
    let path: string | null = null;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      if (line.trim() === `branch refs/heads/${target}`) return path;
    }
    return null;
  };

  const existing = checkedOutElsewhere();
  if (existing && existing !== abs) {
    throw new Error(`branch "${target}" is already checked out at ${existing}`);
  }

  let cmd: string[];
  if (fromBranch || targetExists) {
    // Reusing an existing branch: never pass -b, and never pass a start point —
    // that would silently reset the branch someone else's work is on.
    cmd = ["git", "worktree", "add", abs, target];
  } else {
    const start = startPointFor(repoPath, repo.defaultBranch);
    cmd = start
      ? ["git", "worktree", "add", "-b", branch, abs, start]
      : ["git", "worktree", "add", "-b", branch, abs];
  }

  const r = run(cmd, repoPath);
  if (r.code !== 0) throw new Error(`worktree add failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return { path: abs, fullName };
}

export function removeWorktree(repo: Repo, branch: string, id: string) {
  const repoPath = repoCheckoutPath(repo);
  const abs = join(worktreeRoot(), id);
  run(["git", "worktree", "remove", "--force", abs], repoPath);
  run(["git", "branch", "-D", branch], repoPath);
}

// ------------------------------------------------------------- github

/**
 * "Is there an open PR for this branch?" — with a third answer.
 *
 * `parseInt` on gh's output collapses "no PR exists" and "gh is not installed"
 * into the same null, which is how a missing dependency turns into a session
 * that quietly never reaches `done`.
 */
export type PrLookup =
  | { ok: true; number: number | null }
  | { ok: false; error: string };

export function findOpenPr(repoFullName: string, branch: string): PrLookup {
  if (!repoFullName) return { ok: false, error: "no GitHub repo is associated with this session" };
  if (!branch) return { ok: false, error: "session has no branch to look up" };
  const r = run([
    "gh", "pr", "list",
    "--repo", repoFullName,
    "--head", branch,
    "--state", "open",
    "--json", "number",
  ]);
  if (r.code !== 0) {
    return { ok: false, error: ghErrorMessage(r) };
  }
  let rows: { number?: unknown }[];
  try {
    rows = JSON.parse(r.stdout) as { number?: unknown }[];
  } catch {
    return { ok: false, error: `could not read gh output: ${r.stdout.slice(0, 120)}` };
  }
  const first = rows[0]?.number;
  return { ok: true, number: typeof first === "number" ? first : null };
}

/** Turn a failed `gh` invocation into something a human can act on. */
export function ghErrorMessage(r: CmdResult): string {
  const err = firstLine(r.stderr);
  if (r.code === MISSING_BINARY || /ENOENT|not found in \$PATH|command not found/i.test(err)) {
    return "`gh` is not installed — install the GitHub CLI to see pull requests";
  }
  if (/auth login|not logged into|authentication|gh auth/i.test(err)) {
    return "`gh` is not authenticated — run `gh auth login`";
  }
  return err || `gh exited with code ${r.code}`;
}

interface Remote {
  host: string;
  path: string;
}

/**
 * Split a git remote URL into host + path. Handles the three shapes git accepts:
 * `scheme://[user@]host[:port]/path`, scp-style `[user@]host:path`, and a bare
 * local path (which has no host and is therefore not a GitHub remote).
 */
function parseRemote(url: string): Remote | null {
  const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (scheme) return { host: scheme[1], path: scheme[2] };
  const scp = url.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/);
  if (scp) return { host: scp[1], path: scp[2] };
  return null;
}

/**
 * The `owner/name` slug for a checkout's origin, or null when origin is not a
 * GitHub remote. Null is a real answer here — a GitLab or bare-path remote has
 * no slug — so callers must not read it as "lookup failed".
 */
export function repoFullNameOf(path: string): string | null {
  const r = run(["git", "remote", "get-url", "origin"], path);
  if (r.code !== 0) return null;
  return slugFromRemoteUrl(r.stdout.trim());
}

/** Exported for tests: the pure half of `repoFullNameOf`. */
export function slugFromRemoteUrl(url: string): string | null {
  if (!url) return null;
  const remote = parseRemote(url);
  if (!remote) return null;
  if (!/^(www\.)?github\.com$/i.test(remote.host)) return null;
  const segments = remote.path.replace(/\/+$/, "").split("/");
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  const repo = name.replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

export function currentBranch(path: string): string {
  const r = run(["git", "branch", "--show-current"], path);
  return r.stdout.trim();
}
