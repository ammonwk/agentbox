import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { repoRoot, worktreeRoot } from "./paths";
import type { Repo } from "./types";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command synchronously and capture output. */
export function run(cmd: string[], cwd?: string, env?: Record<string, string>): CmdResult {
  const res = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: res.exitCode ?? -1,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
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
  return join(repoRoot, safe);
}

/**
 * Resolve a repo into a local checkout that worktrees can be carved from.
 * Local repos are used in place; GitHub slugs are cloned under repoRoot.
 * Returns the canonical local repo path.
 */
export function ensureRepoClone(repo: Repo): { path: string; fullName: string | null } {
  if (repo.kind === "local") {
    return { path: repo.ref, fullName: null };
  }
  const dest = repoCheckoutPath(repo);
  if (!existsSync(join(dest, ".git"))) {
    mkdirSync(repoRoot, { recursive: true });
    const r = run(["git", "clone", "--", `https://github.com/${repo.ref}.git`, dest]);
    if (r.code !== 0) throw new Error(`clone failed: ${r.stderr.trim()}`);
  }
  return { path: dest, fullName: repo.ref };
}

/** Create a worktree at worktreeRoot/<id>.
 *  With `fromBranch`, check out that existing branch; otherwise make a fresh
 *  branch `vk/ab-<id>`. */
export function createWorktree(
  repo: Repo,
  id: string,
  branch: string,
  fromBranch?: string
): { path: string; fullName: string | null } {
  const { path: repoPath, fullName } = ensureRepoClone(repo);
  mkdirSync(worktreeRoot, { recursive: true });
  const abs = join(worktreeRoot, id);
  if (fromBranch) {
    // make sure the branch exists locally before adding the worktree
    const has = run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${fromBranch}`], repoPath);
    if (has.code !== 0) {
      const f = run(["git", "fetch", "origin", `${fromBranch}:refs/heads/${fromBranch}`], repoPath);
      if (f.code !== 0) {
        run(["git", "fetch", "origin", `pull/${fromBranch}:refs/heads/${fromBranch}`], repoPath);
      }
    }
    const r = run(["git", "worktree", "add", abs, fromBranch], repoPath);
    if (r.code !== 0) throw new Error(`worktree add failed: ${r.stderr.trim()}`);
    return { path: abs, fullName };
  }
  const r = run(["git", "worktree", "add", "-b", branch, abs], repoPath);
  if (r.code !== 0) {
    // Branch may already exist from a previous attempt — try without -b.
    const r2 = run(["git", "worktree", "add", branch, abs], repoPath);
    if (r2.code !== 0) throw new Error(`worktree add failed: ${r2.stderr.trim()}`);
  }
  return { path: abs, fullName };
}

export function removeWorktree(repo: Repo, branch: string, id: string) {
  const repoPath = repoCheckoutPath(repo);
  const abs = join(worktreeRoot, id);
  run(["git", "worktree", "remove", "--force", abs], repoPath);
  run(["git", "branch", "-D", branch], repoPath);
}

export function findOpenPr(repoFullName: string, branch: string): { number: number } | null {
  if (!repoFullName) return null;
  const r = run([
    "gh", "pr", "list",
    "--repo", repoFullName,
    "--head", branch,
    "--state", "open",
    "--json", "number",
    "--jq", ".[0].number",
  ]);
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? null : { number: n };
}

export function repoFullNameOf(path: string): string | null {
  const r = run(["git", "remote", "get-url", "origin"], path);
  const url = r.stdout.trim();
  const m = url.match(/github\.com[:\/]([^/]+\/[^/.]+)(\.git)?$/);
  return m ? m[1] : null;
}

export function currentBranch(path: string): string {
  const r = run(["git", "branch", "--show-current"], path);
  return r.stdout.trim();
}
