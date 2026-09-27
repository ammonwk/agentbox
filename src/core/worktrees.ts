import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { listRepos } from "./db";
import {
  branchAt,
  commitsAhead,
  diskBytesOf,
  isDirty,
  listWorktreesOf,
  mapPool,
  removeWorktreeAt,
  repoCheckoutPath,
  SCAN_CONCURRENCY,
} from "./git";
import { branchStatesOf, type PrState } from "./prs";
import { worktreeRoot } from "./paths";
import type { ReclaimResult, Session, WorktreeInfo, WorktreeScan, WorktreeVerdict } from "./types";

/**
 * Disk reclaim for worktrees.
 *
 * Closing a session no longer removes its checkout — the branch is what makes a
 * session resumable, and destroying a gigabyte of disk was too blunt a price
 * for "take this off my board". The disk still has to come back somehow, so it
 * comes back here: a deliberate, explicitly-invoked sweep the human reads
 * before running.
 *
 * The scope is every worktree of every registered repo, not only the ones
 * agentbox cut. A repo agentbox knows about is a repo whose `git worktree list`
 * it can read, and hand-made worktrees occupy exactly the same disk. They are
 * labelled `foreign` so the UI can scope them out, never silently swept.
 */

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
  dirty: boolean;
  /** Commits HEAD has that the base branch does not. -1 when unanswerable. */
  ahead: number;
  pr: PrState;
  /** On disk under the worktree root, but no registered repo lists it. */
  orphan: boolean;
}

/**
 * Decide what may be reclaimed.
 *
 * The safe set is deliberately narrow, because the failure it guards against is
 * unrecoverable and the failure it causes by being too cautious is a directory
 * that stays on disk. Anything unreadable, unanswerable or in use lands on the
 * cautious side.
 */
export function verdictFor(input: WorktreeFacts): WorktreeVerdict {
  // The repo's own checkout. `git worktree remove` refuses it anyway; saying so
  // explicitly means the count the human reads never includes it.
  if (input.isMain) return { safe: false, reason: "main", detail: "the repo's own checkout" };
  if (input.locked) return { safe: false, reason: "locked", detail: "locked by git" };
  if (input.live) {
    return { safe: false, reason: "live", detail: "a running session is using it" };
  }
  if (input.dirty) {
    return { safe: false, reason: "dirty", detail: "uncommitted or untracked changes" };
  }

  // A directory under the worktree root that no registered repo claims. Its
  // repo was deregistered or moved, so no session can resume into it —
  // `restoreWorktree` refuses outright without a registered repo — and there is
  // no base branch left to compare against either. Once it is clean there is
  // nothing here a branch does not already have, and nothing that will ever
  // read it again.
  if (input.orphan) {
    return { safe: true, reason: "orphan", detail: "its repo is no longer registered" };
  }

  // A merged or closed PR is the branch's own author saying they are finished
  // with it, and it outranks unpushed commits: whatever is on the branch has
  // either landed or been rejected.
  if (input.pr === "merged") return { safe: true, reason: "merged", detail: "its PR was merged" };
  if (input.pr === "closed") return { safe: true, reason: "closed", detail: "its PR was closed" };
  if (input.pr === "open") {
    return { safe: false, reason: "open-pr", detail: "its PR is still open" };
  }

  if (input.ahead < 0) {
    return { safe: false, reason: "unknown", detail: "could not be compared to its base branch" };
  }
  if (input.ahead > 0) {
    const n = input.ahead;
    return {
      safe: false,
      reason: "ahead",
      detail: `${n} commit${n === 1 ? "" : "s"} not on the base branch`,
    };
  }
  return { safe: true, reason: "clean", detail: "clean, and nothing its base branch does not have" };
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
 * Still far too expensive to sit behind a render or a timer — this is the
 * "Scan" button and nothing else.
 */
export async function scanWorktrees(scope: WorktreeScope = "all", sessions: Session[] = []): Promise<WorktreeScan> {
  // Keyed by cwd as well as by worktree: a session started in a worktree
  // agentbox did not cut is still using it.
  const byPath = new Map<string, Session>();
  for (const s of sessions) {
    if (s.cwd) byPath.set(s.cwd, s);
    if (s.worktree) byPath.set(s.worktree, s);
  }
  const liveOf = (path: string) => {
    const s = byPath.get(path);
    // A parked session is only waiting for its next message, which resumes
    // it here: its worktree is as much in use as a running one's.
    return s ? s.host !== "none" || s.parkedAt !== null : false;
  };

  // ---- phase one: what is out there, and what does GitHub say about it

  const repos = listRepos().filter((r) => existsSync(repoCheckoutPath(r)));
  const perRepo = await mapPool(repos, SCAN_CONCURRENCY, async (repo) => {
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

  const items = await mapPool(candidates, SCAN_CONCURRENCY, async (c): Promise<WorktreeInfo> => {
    // A registration whose directory is gone has nothing to shell into, and
    // the main checkout is never a deletion candidate — neither is worth the
    // three subprocesses. Sizing main is still worth it: it is usually the
    // largest thing listed, and hiding that would misreport the disk.
    const inspect = !c.missing && !c.isMain;
    const [dirty, ahead, bytes, branch] = await Promise.all([
      inspect ? isDirty(c.path) : Promise.resolve(false),
      inspect && c.defaultBranch ? commitsAhead(c.path, c.defaultBranch) : Promise.resolve(0),
      c.missing ? Promise.resolve(0) : diskBytesOf(c.path),
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
        dirty,
        ahead,
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

function repoCheckoutPathFor(repoId: string): string | null {
  const repo = listRepos().find((r) => r.id === repoId);
  return repo ? repoCheckoutPath(repo) : null;
}
