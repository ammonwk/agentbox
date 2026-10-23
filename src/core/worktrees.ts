import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { getSessionRecord, listRepos } from "./db";
import {
  type Dirt,
  branchAt,
  commitsHeldOnlyHere,
  createWorktree,
  diskBytesOf,
  dirtOf,
  headMovedAt,
  listWorktreesOf,
  mapPool,
  refExists,
  removeWorktreeAt,
  repoCheckoutPath,
  SCAN_CONCURRENCY,
} from "./git";
import { branchStatesOf, type PrState } from "./prs";
import { worktreeRoot } from "./paths";
import { setUpWorktree } from "./setup";
import type { ReclaimResult, Session, WorktreeInfo, WorktreeScan, WorktreeVerdict } from "./types";

/**
 * Disk reclaim for worktrees.
 *
 * Closing a session no longer removes its checkout — the branch is what makes a
 * session resumable, and destroying a gigabyte of disk was too blunt a price
 * for "take this off my board". The disk still has to come back somehow, so it
 * comes back here: a deliberate, explicitly-invoked sweep the human reads
 * before running, and, where the human turned it on, the same safe set removed
 * every night (nightly.ts).
 *
 * The scope is every worktree of every registered repo, not only the ones
 * agentbox cut. A repo agentbox knows about is a repo whose `git worktree list`
 * it can read, and hand-made worktrees occupy exactly the same disk. They are
 * labelled `foreign` so the UI can scope them out, never silently swept.
 */

/**
 * Make sure `dir` is there, cutting again the worktree it lies in when it was
 * removed: the reclaim takes a stopped session's clean checkout on the
 * premise that its branch keeps the commits, and this is the other half of
 * that premise. A directory under the worktree root is named for the session
 * that cut it (`createWorktree`), so that session's branch, in whichever
 * registered repo has it, is what it is cut from again, set up as a new
 * worktree is. Throws, saying why, when there is nothing to cut it from: a
 * directory agentbox did not cut, or a detached checkout with no branch.
 */
export function ensureCheckout(dir: string): void {
  if (existsSync(dir)) return;
  const gone = `the directory is gone: ${dir}`;
  const name = isOurs(dir) ? relative(worktreeRoot(), dir).split("/")[0] : "";
  if (!name) throw new Error(gone);
  const branch = (getSessionRecord(name)?.facts as { gitBranch?: string | null } | null)?.gitBranch;
  if (!branch || branch === "HEAD") throw new Error(`${gone}, and it was on no branch it could be cut again from`);
  const repos = listRepos().filter((r) => existsSync(repoCheckoutPath(r)) && refExists(repoCheckoutPath(r), `refs/heads/${branch}`));
  if (repos.length !== 1) {
    throw new Error(`${gone}, and ${repos.length ? `${repos.length} registered repos have` : "no registered repo has"} its branch ${branch} to cut it again from`);
  }
  try {
    const { path } = createWorktree(repos[0]!, name, branch, branch);
    setUpWorktree(repos[0]!, path, name);
  } catch (e) {
    throw new Error(`${gone}, and cutting it again from ${branch} failed: ${(e as Error).message}`);
  }
  if (!existsSync(dir)) throw new Error(`${gone}: cut again from ${branch}, which does not have it`);
  console.log(`agentbox: cut ${join(worktreeRoot(), name)} again from ${branch}`);
}

/** Whether a session still needs its checkout where it is. A parked one is
 *  only waiting for its next message, which resumes it there, and one with a
 *  wait armed is waiting on the world (an `until` command runs in its
 *  directory): either is as much in use as a running one. */
export function holdsCheckout(s: Session): boolean {
  return s.host !== "none" || s.parkedAt !== null || s.waits.length > 0;
}

/** Where a scan is allowed to look. */
export type WorktreeScope = "agentbox" | "all";

/** Under `worktreeRoot()` means agentbox cut it. */
function isOurs(path: string): boolean {
  const root = worktreeRoot();
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Directories in the worktree root that no registered repo listed. */
function orphanDirs(claimed: Set<string>): string[] {
  const root = worktreeRoot();
  if (!existsSync(root)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .filter((p) => !claimed.has(p));
}

/** What the verdict is decided from. Everything here is already-gathered fact,
 *  so the decision itself is pure and testable without a repo on disk. */
export interface WorktreeFacts {
  isMain: boolean;
  locked: boolean;
  live: boolean;
  dirt: Dirt["level"];
  /** Days since anything happened here: HEAD moved, an uncommitted file was
   *  written, a session in it did something. 0 when that cannot be read. */
  idleDays: number;
  /** Commits HEAD holds that neither a branch nor a remote has. Only a
   *  detached HEAD or an orphan can hold one: a linked worktree's branch lives
   *  in the common repo and survives the checkout's removal. -1 when git
   *  cannot say. */
  heldOnly: number;
  /** HEAD is not on a branch, so nothing but this checkout may keep a commit
   *  alive. */
  detached: boolean;
  pr: PrState;
  /** On disk under the worktree root, but no registered repo lists it. */
  orphan: boolean;
}

/**
 * Decide what may be reclaimed.
 *
 * Time is what widens the safe set. A worktree nothing has touched for
 * `STALE_DAYS` goes whatever is in it, and after `MINOR_DIRT_DAYS` untracked
 * files stop holding one back: left to "dirty means keep", two in five
 * worktrees on this machine were kept forever by an agent's probe scripts and
 * notes, long after their PR merged. Nothing is saved first. What is lost is
 * what nobody came back for, and the session's transcript still has most of it.
 * Anything unreadable, unanswerable or in use lands on the cautious side.
 */
export const STALE_DAYS = 7;
export const MINOR_DIRT_DAYS = 3;

/** Whether what is uncommitted here still holds the worktree back. */
export function dirtBlocks(dirt: Dirt["level"], idleDays: number): boolean {
  if (dirt === "none" || idleDays >= STALE_DAYS) return false;
  return dirt === "major" || idleDays < MINOR_DIRT_DAYS;
}

export function verdictFor(input: WorktreeFacts): WorktreeVerdict {
  // The repo's own checkout. `git worktree remove` refuses it anyway; saying so
  // explicitly means the count the human reads never includes it.
  if (input.isMain) return { safe: false, reason: "main", detail: "the repo's own checkout" };
  if (input.locked) return { safe: false, reason: "locked", detail: "locked by git" };
  if (input.live) {
    return { safe: false, reason: "live", detail: "a running session is using it" };
  }
  const idle = Math.floor(input.idleDays);
  if (input.idleDays >= STALE_DAYS) {
    return { safe: true, reason: "stale", detail: `nothing has touched it for ${idle} days` };
  }
  if (dirtBlocks(input.dirt, input.idleDays)) {
    return {
      safe: false,
      reason: "dirty",
      detail:
        input.dirt === "major"
          ? `uncommitted edits, kept until ${STALE_DAYS} days idle`
          : `untracked files, kept until ${MINOR_DIRT_DAYS} days idle`,
    };
  }

  // A directory under the worktree root that no registered repo claims. Its
  // repo was deregistered or moved, so no session can resume into it —
  // `ensureCheckout` finds no registered repo to cut it again from — and there
  // is no base branch left to compare against either. What it can still hold is
  // commits no branch or remote has, which removing it would leave unreachable.
  if (input.orphan) {
    if (input.heldOnly < 0) {
      return { safe: false, reason: "unknown", detail: "could not tell whether its commits are held elsewhere" };
    }
    if (input.heldOnly > 0) {
      const n = input.heldOnly;
      return { safe: false, reason: "ahead", detail: `${n} commit${n === 1 ? "" : "s"} that nothing else has` };
    }
    return { safe: true, reason: "orphan", detail: "its repo is no longer registered" };
  }

  // A merged or closed PR is the branch's own author saying they are finished
  // with it, and it outranks uncommitted work: whatever is on the branch has
  // either landed or been rejected.
  if (input.pr === "merged") return { safe: true, reason: "merged", detail: "its PR was merged" };
  if (input.pr === "closed") return { safe: true, reason: "closed", detail: "its PR was closed" };
  if (input.pr === "open") {
    return { safe: false, reason: "open-pr", detail: "its PR is still open" };
  }
  // No answer from GitHub: a branch could be an open PR, so leave it alone.
  if (input.pr === "unknown") {
    return { safe: false, reason: "unknown", detail: "GitHub has not said what became of its branch" };
  }

  // A detached HEAD is the one checkout whose removal can orphan a commit: it
  // is on no branch, and `git worktree remove` keeps branches, not this. Ask
  // what no branch or remote already holds, rather than what the base branch
  // lacks — a review checkout sits on the PR's own commits and would otherwise
  // look like unpushed work until it went stale.
  if (input.detached) {
    if (input.heldOnly < 0) {
      return { safe: false, reason: "unknown", detail: "could not tell whether its commits are held elsewhere" };
    }
    if (input.heldOnly > 0) {
      const n = input.heldOnly;
      return { safe: false, reason: "ahead", detail: `${n} commit${n === 1 ? "" : "s"} that no branch or remote has` };
    }
    return { safe: true, reason: "detached", detail: "detached, and every commit is on a branch or remote" };
  }

  // A branch's commits live in the common repo, so removing the checkout
  // leaves them and the branch intact, and a resume cuts the checkout again
  // from it (`ensureCheckout`). Clean is enough.
  return { safe: true, reason: "clean", detail: "clean; its branch keeps the commits" };
}

/** Days since the last sign of life, 0 when there is none to read. A directory
 *  git cannot date (an orphan that is no checkout) goes by its own mtime. */
function idleDays(path: string, headMoved: number | null, dirt: Dirt, sessionAt: number): number {
  let at = Math.max(headMoved ?? 0, dirt.newestAt ?? 0, sessionAt);
  if (!at) {
    try {
      at = statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }
  return Math.max(0, (Date.now() - at) / 86_400_000);
}

/** Asked again just before a removal the scan called safe: whether somebody
 *  has been here since. */
export async function untouchedSince(item: WorktreeInfo, scannedAt: number): Promise<boolean> {
  const [dirt, moved] = await Promise.all([dirtOf(item.path), headMovedAt(item.path)]);
  if (Math.max(moved ?? 0, dirt.newestAt ?? 0) > scannedAt) return false;
  return !dirtBlocks(dirt.level, idleDays(item.path, moved, dirt, 0));
}

/** A worktree found on disk, before anything expensive has been asked about it. */
interface Candidate {
  path: string;
  repoId: string;
  repoName: string;
  /** Base branch to compare against. Empty for an orphan, which has no repo. */
  defaultBranch: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  ours: boolean;
  orphan: boolean;
  missing: boolean;
  live: boolean;
  sessionId: string | null;
  sessionTitle: string | null;
  pr: PrState;
}

/**
 * Walk every registered repo and report what is on disk.
 *
 * Two phases, and the split is the whole performance story. Finding the
 * candidates is cheap — one `git worktree list` per repo, and what became of
 * each branch's PR from the PR copy (prs.ts). Judging them is not: a `git status`, a `git
 * rev-list` and a `du` for each of a hundred and fifty directories. Those are
 * independent and I/O-bound, so phase two runs them `SCAN_CONCURRENCY` at a
 * time. Serially the same work took 45 seconds.
 *
 * Still far too expensive to sit behind a render or a short timer — this is
 * the "Scan" button, and the nightly sweep, which asks for it slowly.
 */
export async function scanWorktrees(
  scope: WorktreeScope = "all",
  sessions: Session[] = [],
  // The nightly sweep sizes only what it removes, a few directories at a time.
  opts: { sizes?: boolean; concurrency?: number } = {},
): Promise<WorktreeScan> {
  const concurrency = opts.concurrency ?? SCAN_CONCURRENCY;
  // Keyed by cwd as well as by worktree: a session started in a worktree
  // agentbox did not cut is still using it.
  const byPath = new Map<string, Session>();
  for (const s of sessions) {
    if (s.cwd) byPath.set(s.cwd, s);
    if (s.worktree) byPath.set(s.worktree, s);
  }
  // Every session that ran here counts, closed ones too: the last thing one did
  // is the last time anybody cared about this checkout.
  const activeAt = new Map<string, number>();
  for (const s of sessions) {
    for (const path of [s.cwd, s.worktree]) {
      if (path) activeAt.set(path, Math.max(activeAt.get(path) ?? 0, s.lastActivityAt));
    }
  }
  const liveOf = (path: string) => {
    const s = byPath.get(path);
    return s ? holdsCheckout(s) : false;
  };

  // ---- phase one: what is out there, and what does GitHub say about it

  const repos = listRepos().filter((r) => existsSync(repoCheckoutPath(r)));
  const perRepo = await mapPool(repos, concurrency, async (repo) => {
    const worktrees = listWorktreesOf(repoCheckoutPath(repo));
    // Only when it has a linked worktree to ask about.
    const asked = repo.fullName !== null && worktrees.some((w) => !w.isMain && w.branch);
    const prs = asked ? branchStatesOf(repo.fullName!) : null;
    return { repo, worktrees, asked, prs };
  });

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let ghAsked = false;
  let ghAnswered = false;

  for (const { repo, worktrees, asked, prs } of perRepo) {
    if (asked) {
      ghAsked = true;
      if (prs) ghAnswered = true;
    }
    for (const wt of worktrees) {
      // A repo registered twice under different refs, or a worktree shared
      // between them, must not be offered for deletion twice.
      if (seen.has(wt.path)) continue;
      seen.add(wt.path);

      const ours = isOurs(wt.path);
      if (scope === "agentbox" && !ours && !wt.isMain) continue;

      const session = byPath.get(wt.path) ?? null;
      candidates.push({
        path: wt.path,
        repoId: repo.id,
        repoName: repo.displayName,
        defaultBranch: repo.defaultBranch,
        branch: wt.branch,
        isMain: wt.isMain,
        locked: wt.locked,
        ours,
        orphan: false,
        missing: !existsSync(wt.path),
        live: liveOf(wt.path),
        sessionId: session?.id ?? null,
        sessionTitle: session?.title ?? null,
        pr:
          wt.isMain || !wt.branch || !repo.fullName
            ? "none"
            : prs === null
              ? "unknown"
              : (prs.get(wt.branch) ?? "none"),
      });
    }
  }

  // Anything under the worktree root that no repo claimed above. These are the
  // leftovers of a deregistered repo or a pruned registration, and they are
  // invisible to `git worktree list` by definition — on this machine they were
  // over half of what agentbox had on disk. A reclaim that could not see them
  // would report success while the bulk of the waste stayed put.
  for (const path of orphanDirs(seen)) {
    const session = byPath.get(path) ?? null;
    candidates.push({
      path,
      repoId: "",
      repoName: session ? "(deregistered repo)" : "(unknown repo)",
      defaultBranch: "",
      branch: null,
      isMain: false,
      locked: false,
      ours: true,
      orphan: true,
      missing: false,
      live: liveOf(path),
      sessionId: session?.id ?? null,
      sessionTitle: session?.title ?? null,
      pr: "none",
    });
  }

  // ---- phase two: the expensive per-directory questions, in parallel

  const items = await mapPool(candidates, concurrency, async (c): Promise<WorktreeInfo> => {
    // A registration whose directory is gone has nothing to shell into, and
    // the main checkout is never a deletion candidate — neither is worth the
    // three subprocesses. Sizing main is still worth it: it is usually the
    // largest thing listed, and hiding that would misreport the disk.
    const inspect = !c.missing && !c.isMain;
    const [dirt, moved, heldOnly, bytes, branch] = await Promise.all([
      inspect ? dirtOf(c.path) : Promise.resolve<Dirt>({ level: "none", newestAt: null }),
      inspect ? headMovedAt(c.path) : Promise.resolve(null),
      // A linked worktree's branch ref outlives its checkout, so only a
      // detached HEAD or an orphan can hold commits removal would orphan.
      !inspect || (!c.orphan && c.branch !== null) ? Promise.resolve(0) : commitsHeldOnlyHere(c.path),
      c.missing || opts.sizes === false ? Promise.resolve(0) : diskBytesOf(c.path),
      c.branch === null && c.orphan ? branchAt(c.path) : Promise.resolve(c.branch),
    ]);

    return {
      path: c.path,
      repoId: c.repoId,
      repoName: c.repoName,
      branch,
      bytes,
      isMain: c.isMain,
      ours: c.ours,
      missing: c.missing,
      sessionId: c.sessionId,
      sessionTitle: c.sessionTitle,
      live: c.live,
      pr: c.pr,
      verdict: verdictFor({
        isMain: c.isMain,
        locked: c.locked,
        live: c.live,
        dirt: dirt.level,
        idleDays: idleDays(c.path, moved, dirt, activeAt.get(c.path) ?? 0),
        heldOnly,
        detached: branch === null,
        pr: c.pr,
        orphan: c.orphan,
      }),
    };
  });

  items.sort((a, b) => b.bytes - a.bytes);
  return {
    scannedAt: Date.now(),
    items,
    // Only worth surfacing when gh was actually needed and never came through:
    // without it every branch reads as `unknown`, so "nothing is safe" is a
    // missing dependency rather than a fact about the disk.
    ghUnavailable: ghAsked && !ghAnswered,
  };
}

/**
 * Remove the given worktrees, keeping their branches.
 *
 * The caller names paths, but the decision is re-made here against a fresh
 * scan. A scan the human read minutes ago is a snapshot: a session may have
 * started since, or a clean worktree may have been written to. Trusting the
 * request would make the confirmation dialog the only thing standing between a
 * stale list and someone's uncommitted work.
 */
export async function reclaimWorktrees(
  paths: string[],
  opts: { force?: boolean; sessions?: Session[] } = {},
): Promise<ReclaimResult> {
  const wanted = new Set(paths);
  // The sessions are what make a worktree `live` and therefore untouchable;
  // a rescan without them would offer a running agent's directory for removal.
  const fresh = await scanWorktrees("all", opts.sessions ?? []);
  const result: ReclaimResult = { removed: [], failed: [], bytesFreed: 0 };

  for (const item of fresh.items) {
    if (!wanted.has(item.path)) continue;

    // `force` is the "nuke everything" path. It overrides dirty and ahead —
    // that is what the human confirmed — but never the two that are not about
    // losing work: the main checkout cannot be removed by git at all, and
    // pulling the directory out from under a running agent breaks the agent.
    const blocked = item.isMain || item.live || item.verdict.reason === "locked";
    if (blocked || (!opts.force && !item.verdict.safe)) {
      result.failed.push({ path: item.path, error: item.verdict.detail });
      continue;
    }

    // An orphan has no repo to run `git worktree remove` from — that is what
    // makes it an orphan. `removeWorktreeAt` falls through to removing the
    // directory itself when git will not take it, so the orphan's own path is
    // a serviceable cwd: git fails there, and the fallback does the work.
    const repoPath = item.repoId ? repoCheckoutPathFor(item.repoId) : item.path;
    if (!repoPath) {
      result.failed.push({ path: item.path, error: "its repo is no longer registered" });
      continue;
    }

    const bytes = item.bytes;
    const r = removeWorktreeAt(repoPath, item.path);
    if (existsSync(item.path)) {
      result.failed.push({
        path: item.path,
        error: r.stderr.split("\n")[0]?.trim() || `git exited with code ${r.code}`,
      });
      continue;
    }
    result.removed.push(item.path);
    result.bytesFreed += bytes;
  }
  return result;
}

export function repoCheckoutPathFor(repoId: string): string | null {
  const repo = listRepos().find((r) => r.id === repoId);
  return repo ? repoCheckoutPath(repo) : null;
}
