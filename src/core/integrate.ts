/**
 * `agentbox integrate <branch>`: put a finished branch on the checkout's
 * branch while other sessions have uncommitted edits in that checkout.
 *
 * `git merge`, `cherry-pick` and `stash` refuse or disturb a working tree
 * that others are editing, so this does by hand, in an order that cannot
 * lose an edit, what a careful person did before it:
 *
 *  1. The branch's commits go onto the checkout's HEAD in a scratch worktree
 *     (a fast-forward when HEAD is already under it). A conflict stops here.
 *  2. The typecheck and the tests run there, on the exact commit (`check`),
 *     so nobody's unfinished edit decides the result.
 *  3. Each file the commit changes is worked out in memory: the new version
 *     where the file is clean, a three-way merge with the uncommitted edit
 *     where it is not. Any conflict stops here, with nothing changed.
 *  4. The files are written, then the branch moves, compared against the HEAD
 *     it started from. If someone committed meanwhile, the files go back.
 *  5. The index takes the new commit's version of those files, so the edits
 *     of others stay unstaged and the commit is not shown as undone.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Integrated = { branch: string; from: string; to: string; files: string[]; merged: string[]; fastForward: boolean };

function run(cwd: string, argv: string[], input?: Uint8Array): { code: number; out: Buffer; err: string } {
  const p = Bun.spawnSync(argv, { cwd, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout as Buffer, err: p.stderr.toString().trim() };
}
function git(cwd: string, ...args: string[]): string {
  const r = run(cwd, ["git", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.toString().trim();
}
const ok = (cwd: string, ...args: string[]) => run(cwd, ["git", ...args]).code === 0;
function blob(cwd: string, commit: string, file: string): Buffer | null {
  const r = run(cwd, ["git", "cat-file", "blob", `${commit}:${file}`]);
  return r.code === 0 ? r.out : null;
}
function readWork(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}
const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

/** The checks, run in `dir` on the exact commit. Throws with the tail of what failed. */
export function checkCommit(dir: string, log: (line: string) => void): void {
  for (const step of [["run", "typecheck"], ["test"]]) {
    log(`bun ${step.join(" ")} on the integrated commit`);
    const r = run(dir, [process.execPath, ...step]);
    if (r.code !== 0) {
      const tail = `${r.out.toString()}\n${r.err}`.trim().split("\n").filter((l) => /fail|error|✗/i.test(l)).slice(-15).join("\n");
      throw new Error(`bun ${step.join(" ")} failed on the integrated commit; nothing was changed:\n${tail}`);
    }
  }
}

export function integrate(opts: { checkout: string; branch: string; check: boolean; log?: (line: string) => void }): Integrated {
  const log = opts.log ?? (() => {});
  const c = git(opts.checkout, "rev-parse", "--show-toplevel");
  const ref = run(c, ["git", "symbolic-ref", "-q", "HEAD"]).out.toString().trim();
  if (!ref) throw new Error(`${c} has a detached HEAD; integrate moves a branch`);
  if (!ok(c, "diff", "--cached", "--quiet")) throw new Error(`${c} has staged changes; integrate leaves the index to whoever staged them`);
  const from = git(c, "rev-parse", "HEAD");
  const tip = git(c, "rev-parse", "--verify", `${opts.branch}^{commit}`);
  if (ok(c, "merge-base", "--is-ancestor", tip, from)) throw new Error(`${opts.branch} is already in ${ref.replace("refs/heads/", "")}`);
  const fastForward = ok(c, "merge-base", "--is-ancestor", from, tip);
  if (!fastForward && git(c, "rev-list", "--merges", `${from}..${tip}`)) throw new Error(`${opts.branch} has merge commits; rebase it onto ${ref.replace("refs/heads/", "")} first`);

  const scratch = mkdtempSync(join(tmpdir(), "agentbox-integrate-"));
  const dir = join(scratch, "tree");
  let to: string;
  try {
    git(c, "worktree", "add", "--quiet", "--detach", dir, fastForward ? tip : from);
    if (!fastForward) {
      const picked = run(dir, ["git", "-c", "core.editor=true", "cherry-pick", `${from}..${tip}`]);
      if (picked.code !== 0) {
        const conflicts = run(dir, ["git", "diff", "--name-only", "--diff-filter=U"]).out.toString().trim();
        run(dir, ["git", "cherry-pick", "--abort"]);
        throw new Error(`${opts.branch} does not apply onto ${from.slice(0, 8)}${conflicts ? `; conflicts in: ${conflicts.split("\n").join(", ")}` : `: ${picked.err}`}. Rebase it first.`);
      }
    }
    to = git(dir, "rev-parse", "HEAD");
    if (opts.check) {
      if (existsSync(join(c, "node_modules")) && !existsSync(join(dir, "node_modules"))) symlinkSync(join(c, "node_modules"), join(dir, "node_modules"));
      checkCommit(dir, log);
    }
  } finally {
    run(c, ["git", "worktree", "remove", "--force", dir]);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 3. Every result in memory before anything is written.
  const files = git(c, "diff", "--no-renames", "--name-only", "-z", from, to).split("\0").filter(Boolean);
  type Plan = { file: string; work: Buffer | null; result: Buffer | null; mode: string | null };
  const plans: Plan[] = [], merged: string[] = [], conflicts: string[] = [];
  const mergeDir = mkdtempSync(join(tmpdir(), "agentbox-merge-"));
  try {
    for (const file of files) {
      const base = blob(c, from, file), next = blob(c, to, file), work = readWork(join(c, file));
      const mode = next === null ? null : git(c, "ls-tree", to, "--", file).split(/\s/)[0]!;
      if (same(work, base) || same(work, next)) {
        plans.push({ file, work, result: next, mode });
        continue;
      }
      if (work === null || base === null || next === null) {
        conflicts.push(`${file} (${work === null ? "deleted here" : next === null ? "deleted by the branch" : "added by both"})`);
        continue;
      }
      const [w, b, n] = ["work", "base", "next"].map((k) => join(mergeDir, k));
      writeFileSync(w!, work); writeFileSync(b!, base); writeFileSync(n!, next);
      const r = run(c, ["git", "merge-file", "-p", "-L", "uncommitted", "-L", "base", "-L", opts.branch, w!, b!, n!]);
      if (r.code !== 0) conflicts.push(file);
      else {
        plans.push({ file, work, result: r.out, mode });
        merged.push(file);
      }
    }
  } finally {
    rmSync(mergeDir, { recursive: true, force: true });
  }
  if (conflicts.length) throw new Error(`the branch and uncommitted edits in ${c} conflict; nothing was changed:\n  ${conflicts.join("\n  ")}`);

  // 4. Nobody moved while that was worked out; then write, then move the branch.
  if (git(c, "rev-parse", "HEAD") !== from) throw new Error(`${ref} moved while integrating; run it again`);
  for (const p of plans) if (!same(readWork(join(c, p.file)), p.work)) throw new Error(`${p.file} changed while integrating; run it again`);
  const put = (file: string, body: Buffer | null, mode: string | null) => {
    const path = join(c, file);
    if (body === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    if (mode) chmodSync(path, mode === "100755" ? 0o755 : 0o644);
  };
  const done: Plan[] = [];
  try {
    for (const p of plans) {
      put(p.file, p.result, p.mode);
      done.push(p);
    }
    git(c, "update-ref", "-m", `agentbox integrate ${opts.branch}`, ref, to, from);
  } catch (e) {
    for (const p of done) put(p.file, p.work, null);
    throw new Error(`could not move ${ref}; every file is as it was: ${(e as Error).message}`);
  }
  // 5. The index follows the commit for these files only.
  const reset = run(c, ["git", "reset", "-q", to, "--pathspec-from-file=-", "--pathspec-file-nul"], new TextEncoder().encode(files.join("\0")));
  if (reset.code !== 0) log(`${ref} moved, but the index of ${files.length} file(s) did not follow (run: git reset -q ${to.slice(0, 8)} -- <files>): ${reset.err}`);
  return { branch: opts.branch, from, to, files, merged, fastForward };
}
