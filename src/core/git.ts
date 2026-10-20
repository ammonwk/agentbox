import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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

/**
 * `run`, without blocking the event loop, so callers can have several in
 * flight.
 *
 * Everything else in this file is `spawnSync`, which is right for the one-shot
 * questions the rest of agentbox asks. The worktree scan is the exception: it
 * asks the same question of a hundred and fifty directories, and those are
 * independent I/O-bound subprocesses. Run serially they took 45 seconds.
 */
export async function runAsync(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<CmdResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    // Same reason as `run`: a missing binary throws rather than exiting non-zero.
    return { code: MISSING_BINARY, stdout: "", stderr: `${cmd[0]}: ${(err as Error).message}` };
  }
}

/**
 * How many subprocesses the scan keeps in flight.
 *
 * The work is waiting on the disk, not on a core, so this is well above the CPU
 * count on purpose. Past roughly this point the disk is saturated and the only
 * thing more concurrency buys is process table pressure.
 */
export const SCAN_CONCURRENCY = 16;

/** `items.map(fn)` with at most `limit` running at once. Results keep input
 *  order regardless of what finishes first. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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
function ensureRepoClone(repo: Repo): { path: string; fullName: string | null } {
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
  fromBranch?: string,
  /** The PR `fromBranch` is the head of: fetched as `pull/N/head` when the
   *  branch itself is not on origin (a PR from a fork). */
  pr?: number
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
      const pull = run(["git", "fetch", "origin", `pull/${pr ?? fromBranch}/head:refs/heads/${fromBranch}`], repoPath);
      if (pull.code !== 0) {
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

/**
 * A checkout of `branch` to run a session in: the worktree that already has
 * it checked out — the main checkout included — or else a new one at
 * worktreeRoot/<id>. `created` says which, because only a worktree agentbox
 * cut belongs to the session (and may be reclaimed with it); someone else's
 * is only borrowed.
 */
export function worktreeForBranch(repo: Repo, id: string, branch: string, pr?: number): { path: string; created: boolean } {
  const { path: repoPath } = ensureRepoClone(repo);
  run(["git", "worktree", "prune"], repoPath);
  const existing = listWorktreesOf(repoPath).find((w) => w.branch === branch && existsSync(w.path));
  if (existing) return { path: existing.path, created: false };
  return { path: createWorktree(repo, id, branch, branch, pr).path, created: true };
}

/**
 * A checkout of `ref` (a branch, a tag or a commit) as origin has it now, at
 * worktreeRoot/<id>, with a detached HEAD: for a session that reads the code
 * at that point and makes no branch of its own (a start's `repo` and `ref`). The ref is fetched first, so where it is cut does not depend on
 * how stale this machine's clone is; offline, a ref the clone already has is
 * used as it is. `sha` is the commit it was cut at.
 */
export function detachedWorktree(repo: Repo, id: string, ref: string): { path: string; sha: string } {
  if (!/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-") || ref.includes("..")) throw new Error(`not a ref: ${ref}`);
  const { path: repoPath } = ensureRepoClone(repo);
  mkdirSync(worktreeRoot(), { recursive: true });
  const abs = join(worktreeRoot(), id);
  run(["git", "worktree", "prune"], repoPath);
  if (existsSync(abs) && readdirSync(abs).length > 0) throw new Error(`worktree path is already occupied: ${abs}`);
  const fetched = run(["git", "fetch", "--quiet", "origin", ref], repoPath);
  let sha = fetched.code === 0 ? run(["git", "rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"], repoPath).stdout.trim() : "";
  if (!sha) sha = run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath).stdout.trim();
  if (!sha) throw new Error(`"${ref}" is not on origin or in this repo${fetched.code !== 0 ? ` (fetch: ${firstLine(fetched.stderr) || `exit ${fetched.code}`})` : ""}`);
  const r = run(["git", "worktree", "add", "--detach", abs, sha], repoPath);
  if (r.code !== 0) throw new Error(`worktree add failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return { path: abs, sha };
}

/**
 * Remove a worktree cut by `detachedWorktree` once its session is done with
 * it, when nothing would be lost: its HEAD is detached, nothing in it is
 * uncommitted, and HEAD has not moved since it was cut (its reflog has the
 * one entry `worktree add` wrote), so it holds no commit of its own. Anything
 * else is left for the reclaim (src/core/worktrees.ts) to judge. Says
 * whether it went.
 */
export function removeDetachedWorktree(worktreePath: string): boolean {
  if (!existsSync(worktreePath) || !isGitRepo(worktreePath)) return false;
  if (run(["git", "symbolic-ref", "--quiet", "HEAD"], worktreePath).code === 0) return false;
  const status = run(["git", "status", "--porcelain"], worktreePath);
  if (status.code !== 0 || status.stdout.trim()) return false;
  const moves = run(["git", "reflog", "show", "--format=%H", "HEAD"], worktreePath);
  if (moves.code !== 0 || moves.stdout.trim().split("\n").length !== 1) return false;
  const common = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath).stdout.trim();
  if (!common) return false;
  removeWorktreeAt(dirname(common), worktreePath);
  return !existsSync(worktreePath);
}

/**
 * Drop a worktree directory, keeping its branch.
 *
 * The branch is deliberately left alone. It is the only durable record of what
 * a session did, and `createWorktree` rebuilds a checkout from it on demand —
 * so removing the directory costs nothing but disk, while `git branch -D`
 * alongside it would turn "reclaimed" into "unresumable".
 */
export function removeWorktreeAt(repoPath: string, worktreePath: string): CmdResult {
  const r = run(["git", "worktree", "remove", "--force", worktreePath], repoPath);
  // `worktree remove` refuses a path git has already forgotten (a directory
  // left behind by an interrupted removal, say). Prune and take the directory
  // itself, or the entry is undeletable through this path forever.
  if (r.code !== 0 && existsSync(worktreePath)) {
    run(["git", "worktree", "prune"], repoPath);
    rmSync(worktreePath, { recursive: true, force: true });
  }
  return r;
}

/**
 * `removeWorktreeAt` for a sweep nobody is waiting on: off the event loop, and
 * at idle CPU and disk priority, so deleting a gigabyte of `node_modules` only
 * takes what the agents are not using.
 */
export async function removeWorktreeIdly(repoPath: string, worktreePath: string): Promise<CmdResult> {
  const idle = ["nice", "-n", "19", "ionice", "-c", "3"];
  const r = await runAsync([...idle, "git", "worktree", "remove", "--force", worktreePath], repoPath);
  if (r.code !== 0 && existsSync(worktreePath)) {
    await runAsync(["git", "worktree", "prune"], repoPath);
    await runAsync([...idle, "rm", "-rf", "--", worktreePath]);
  }
  return r;
}

/** When HEAD last moved here (a commit, a checkout, a reset), epoch ms. Null
 *  when it cannot be read. Read from the reflog's last entry, not from any
 *  file's mtime: a `git status` rewrites the index and a `git gc` rewrites
 *  every worktree's reflog, and neither is somebody working here. */
export async function headMovedAt(worktreePath: string): Promise<number | null> {
  const r = await runAsync(["git", "log", "-g", "-1", "--format=%gd", "--date=unix", "HEAD"], worktreePath);
  const at = Number(/@\{(\d+)\}/.exec(r.stdout)?.[1]);
  if (r.code === 0 && Number.isFinite(at) && at > 0) return at * 1000;
  // No reflog (a fresh `worktree add --detach` has one; a pruned one may not).
  const dir = await runAsync(["git", "rev-parse", "--absolute-git-dir"], worktreePath);
  if (dir.code !== 0) return null;
  try {
    return statSync(join(dir.stdout.trim(), "HEAD")).mtimeMs;
  } catch {
    return null;
  }
}

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  /** Short branch name, or null when the checkout is detached. */
  branch: string | null;
  head: string | null;
  /** The repo's own checkout. Never removable — `git worktree remove` refuses
   *  it, and it is where the human works. */
  isMain: boolean;
  locked: boolean;
}

/**
 * Every worktree git knows about for this repo, the main checkout included.
 *
 * The main checkout is first in porcelain output and is flagged rather than
 * dropped: callers need to *show* it (it is usually the biggest directory on
 * disk) while never offering to delete it.
 */
export function listWorktreesOf(repoPath: string): WorktreeEntry[] {
  const r = run(["git", "worktree", "list", "--porcelain"], repoPath);
  if (r.code !== 0) return [];

  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | null = null;
  const flush = () => {
    if (cur?.path) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? null,
        head: cur.head ?? null,
        isMain: out.length === 0,
        locked: cur.locked ?? false,
      });
    }
    cur = null;
  };

  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (t.startsWith("worktree ")) {
      flush();
      cur = { path: t.slice("worktree ".length) };
    } else if (!cur) {
      continue;
    } else if (t.startsWith("HEAD ")) {
      cur.head = t.slice("HEAD ".length);
    } else if (t.startsWith("branch ")) {
      cur.branch = t.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (t === "locked" || t.startsWith("locked ")) {
      cur.locked = true;
    }
  }
  flush();
  return out;
}

/**
 * The checkout `dir` is in, as git finds it, read off the disk: the nearest
 * `.git` up is its top — a directory for a main checkout, a file (`gitdir:
 * …`) for a linked worktree or submodule — and `gitDir` is where its HEAD
 * is. A directory without a HEAD is not a repository, and git looks on up; a
 * worktree whose git dir was deleted is none.
 */
export function checkoutAt(dir: string): { top: string; gitDir: string } | null {
  for (let top = resolve(dir); ; top = dirname(top)) {
    const dotGit = join(top, ".git");
    let st;
    try {
      st = statSync(dotGit);
    } catch {
      if (dirname(top) === top) return null;
      continue;
    }
    if (st.isDirectory()) {
      if (existsSync(join(dotGit, "HEAD"))) return { top, gitDir: dotGit };
      if (dirname(top) === top) return null;
      continue;
    }
    let gitdir: string | undefined;
    try {
      gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    } catch {
      return null;
    }
    if (!gitdir) return null;
    const gd = resolve(top, gitdir);
    return existsSync(join(gd, "HEAD")) ? { top, gitDir: gd } : null;
  }
}

/** The branch the checkout `dir` is in is on, read off its HEAD; null when
 *  detached or not a repository. Two small reads, no process. */
export function branchOnDisk(dir: string): string | null {
  const c = checkoutAt(dir);
  if (!c) return null;
  try {
    return /^ref: refs\/heads\/(.+?)\s*$/m.exec(readFileSync(join(c.gitDir, "HEAD"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The repository a directory belongs to: for a linked worktree, the main
 *  checkout it was made from, so worktree sessions group, filter and name
 *  under their repo rather than under their worktree directory. */
const roots = new Map<string, string | null>();
export function repoRootOf(cwd: string): string | null {
  if (!cwd) return null;
  if (roots.has(cwd)) return roots.get(cwd)!;
  let root = existsSync(cwd) ? mainRootOf(cwd) : null;
  // A worktree's `.git` file holds physical paths, while the main checkout may
  // have been registered through a symlink (macOS `/var` is `/private/var`).
  // Without this, such a session's worktree maps to no repository at all.
  if (root) { try { root = realpathSync(root); } catch { /* removed meanwhile */ } }
  roots.set(cwd, root);
  return root;
}

/**
 * `git rev-parse --show-toplevel --git-common-dir`, read off the disk rather
 * than run: the first pass asked it of every session's cwd, a process each,
 * seconds of a restart. A linked worktree or submodule's git dir names the
 * common one in `commondir`; a common dir not named .git (bare repo,
 * --separate-git-dir, a submodule's) has no main checkout to point at, and
 * the top itself is the answer.
 */
function mainRootOf(dir: string): string | null {
  const c = checkoutAt(dir);
  if (!c) return null;
  if (c.gitDir === join(c.top, ".git")) return c.top;
  let common = c.gitDir;
  try {
    common = resolve(c.gitDir, readFileSync(join(c.gitDir, "commondir"), "utf8").trim());
  } catch {
    /* no commondir: the git dir is its own */
  }
  return basename(common) === ".git" ? dirname(common) : c.top;
}

/** The branch a checkout is on, or null when detached or unreadable. */
export async function branchAt(worktreePath: string): Promise<string | null> {
  const r = await runAsync(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  const name = r.stdout.trim();
  return r.code === 0 && name && name !== "HEAD" ? name : null;
}

/** What is uncommitted in a worktree: `minor` is untracked files and deleted
 *  tracked ones (an agent's probe scripts and notes, a half-emptied checkout),
 *  `major` an edit to a tracked file, anything staged, or a merge in progress. */
export interface Dirt {
  level: "none" | "minor" | "major";
  /** When the newest uncommitted file was written, epoch ms. */
  newestAt: number | null;
}

export async function dirtOf(worktreePath: string): Promise<Dirt> {
  const r = await runAsync(["git", "status", "--porcelain", "-z"], worktreePath);
  // A worktree we cannot read is treated as edited: the reclaim must never
  // take "the command failed" for "there is nothing here".
  if (r.code !== 0) return { level: "major", newestAt: null };
  const entries = r.stdout.split("\0");
  let minor = false;
  let major = false;
  let newestAt: number | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    // A rename or copy is followed by the path it came from.
    if (code[0] === "R" || code[0] === "C") i++;
    if (code === " D") {
      minor = true;
      continue;
    }
    if (code === "??") minor = true;
    else major = true;
    try {
      newestAt = Math.max(newestAt ?? 0, statSync(join(worktreePath, entry.slice(3))).mtimeMs);
    } catch {
      // gone between the status and the stat
    }
  }
  return { level: major ? "major" : minor ? "minor" : "none", newestAt };
}

/** Commits on HEAD that no branch and no remote has: what removing a detached
 *  worktree, or one whose repo is gone, would leave unreachable. -1 where git
 *  cannot say, which callers must not read as "nothing is held here". */
export async function commitsHeldOnlyHere(worktreePath: string): Promise<number> {
  const r = await runAsync(["git", "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"], worktreePath);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) ? n : -1;
}

/**
 * Bytes on disk under a path.
 *
 * One `du` per path, run concurrently by the caller. A single `du` over every
 * path at once looks cheaper — one process instead of a hundred — but it walks
 * the directories one after another, and the walk is the cost. Measured over
 * 29 GB of worktrees: batched into one process, 13s; a process each at 16 in
 * flight, 2.5s.
 *
 * An unreadable directory reports 0 rather than failing the scan.
 */
export async function diskBytesOf(path: string): Promise<number> {
  const r = await runAsync(["du", "-sk", path]);
  const kb = Number(r.stdout.split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// ------------------------------------------------------------- github

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
