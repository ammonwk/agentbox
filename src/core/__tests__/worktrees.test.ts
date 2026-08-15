import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitsAhead, isDirty, listWorktreesOf, mapPool, removeWorktreeAt } from "../git";
import { verdictFor, type WorktreeFacts } from "../worktrees";

/**
 * The reclaim verdict is the one piece of agentbox that deletes a directory
 * nobody asked it to name, so its safe set is asserted exhaustively rather
 * than sampled. Every test here is a case where saying "safe" destroys work
 * that has no other copy.
 */
describe("verdictFor", () => {
  const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
    isMain: false,
    locked: false,
    live: false,
    dirty: false,
    ahead: 0,
    pr: "none",
    orphan: false,
    ...over,
  });

  test("clean and level with its base is safe", () => {
    expect(verdictFor(facts()).safe).toBe(true);
  });

  test("a merged or closed PR is safe even with commits the base lacks", () => {
    // The commits are on GitHub either way — that is what merged/closed means.
    expect(verdictFor(facts({ pr: "merged", ahead: 12 })).safe).toBe(true);
    expect(verdictFor(facts({ pr: "closed", ahead: 12 })).safe).toBe(true);
  });

  test("the repo's own checkout is never safe", () => {
    // git refuses to remove it anyway; the point is that it never lands in a
    // count the human reads as "this many will go".
    expect(verdictFor(facts({ isMain: true })).safe).toBe(false);
    expect(verdictFor(facts({ isMain: true, pr: "merged" })).safe).toBe(false);
  });

  test("a live session's worktree is never safe, whatever its PR says", () => {
    expect(verdictFor(facts({ live: true, pr: "merged" })).safe).toBe(false);
    expect(verdictFor(facts({ live: true })).reason).toBe("live");
  });

  test("uncommitted work outranks a merged PR", () => {
    // The merge says the *branch* is finished. It says nothing about the files
    // sitting dirty in this directory, which no branch has a copy of.
    const v = verdictFor(facts({ dirty: true, pr: "merged" }));
    expect(v.safe).toBe(false);
    expect(v.reason).toBe("dirty");
  });

  test("an open PR is not safe", () => {
    expect(verdictFor(facts({ pr: "open" })).safe).toBe(false);
  });

  test("commits the base branch does not have are not safe", () => {
    const v = verdictFor(facts({ ahead: 3 }));
    expect(v.safe).toBe(false);
    expect(v.detail).toContain("3 commits");
  });

  test("an unanswerable comparison is not safe", () => {
    // -1 is "we could not tell". Treating that as 0 would delete a branch
    // whose commits exist nowhere else because a git call happened to fail.
    expect(verdictFor(facts({ ahead: -1 })).safe).toBe(false);
    expect(verdictFor(facts({ ahead: -1 })).reason).toBe("unknown");
  });

  test("gh being unreachable never makes a worktree safe", () => {
    // `unknown` must fall through to the commit comparison, not be read as
    // "no PR, therefore finished".
    expect(verdictFor(facts({ pr: "unknown", ahead: 2 })).safe).toBe(false);
    // Clean and level is still safe — that verdict never needed gh.
    expect(verdictFor(facts({ pr: "unknown", ahead: 0 })).safe).toBe(true);
  });

  test("a locked worktree is left alone", () => {
    expect(verdictFor(facts({ locked: true })).safe).toBe(false);
  });

  test("a clean orphan is safe; a dirty one is not", () => {
    // An orphan's repo is deregistered, so no session can resume into it and
    // there is no base branch to compare against — `ahead` is meaningless here
    // and must not be what decides it. Uncommitted files still can be.
    expect(verdictFor(facts({ orphan: true })).safe).toBe(true);
    expect(verdictFor(facts({ orphan: true })).reason).toBe("orphan");
    expect(verdictFor(facts({ orphan: true, dirty: true })).safe).toBe(false);
  });

  test("an orphan a live session is still using is not safe", () => {
    expect(verdictFor(facts({ orphan: true, live: true })).safe).toBe(false);
  });
});

describe("mapPool", () => {
  test("keeps input order however the work finishes", async () => {
    // Reversed delays: without indexed writes the results come back in
    // completion order, which silently pairs every verdict with the wrong path.
    const out = await mapPool([30, 20, 10, 0], 4, async (ms, i) => {
      await Bun.sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:20", "2:10", "3:0"]);
  });

  test("never exceeds the limit", async () => {
    let now = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++now);
      await Bun.sleep(1);
      now--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("an empty list spawns no workers and resolves", async () => {
    expect(await mapPool([], 8, async () => 1)).toEqual([]);
  });
});

// --------------------------------------------------------------- real git

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let root: string;
let main: string;
let wt: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentbox-wt-"));
  main = join(root, "main");
  mkdirSync(main);
  git(["init", "-q", "-b", "main"], main);
  git(["config", "user.email", "t@t"], main);
  git(["config", "user.name", "t"], main);
  writeFileSync(join(main, "README.md"), "hi\n", "utf8");
  git(["add", "."], main);
  git(["commit", "-qm", "init"], main);
  wt = join(root, "wt");
  git(["worktree", "add", "-q", wt, "-b", "feat/x"], main);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listWorktreesOf", () => {
  test("flags the main checkout and only the main checkout", () => {
    const list = listWorktreesOf(main);
    expect(list.length).toBe(2);
    expect(list[0]!.isMain).toBe(true);
    expect(list[0]!.path).toBe(main);
    expect(list.filter((w) => w.isMain).length).toBe(1);
  });

  test("branch names come back short, not as refs/heads/…", () => {
    const linked = listWorktreesOf(main).find((w) => w.path === wt);
    expect(linked?.branch).toBe("feat/x");
  });

  test("an unreadable repo is an empty list, not a throw", () => {
    expect(listWorktreesOf(join(root, "does-not-exist"))).toEqual([]);
  });
});

describe("isDirty", () => {
  test("false on a clean tree, true once a file is written", async () => {
    expect(await isDirty(wt)).toBe(false);
    writeFileSync(join(wt, "scratch.txt"), "work in progress\n", "utf8");
    // Untracked counts: an agent's most common act is creating a file, and a
    // reclaim that ignored untracked files would delete exactly that.
    expect(await isDirty(wt)).toBe(true);
    rmSync(join(wt, "scratch.txt"));
    expect(await isDirty(wt)).toBe(false);
  });

  test("a path that is not a repo reads as dirty rather than clean", async () => {
    expect(await isDirty(join(root, "nope"))).toBe(true);
  });
});

describe("commitsAhead", () => {
  test("0 on a fresh branch, then counts what the base lacks", async () => {
    expect(await commitsAhead(wt, "main")).toBe(0);
    writeFileSync(join(wt, "a.txt"), "a\n", "utf8");
    git(["add", "."], wt);
    git(["commit", "-qm", "one"], wt);
    expect(await commitsAhead(wt, "main")).toBe(1);
  });

  test("-1 when the base does not exist", async () => {
    expect(await commitsAhead(wt, "no-such-branch")).toBe(-1);
  });
});

describe("removeWorktreeAt", () => {
  test("takes the directory and leaves the branch", () => {
    const doomed = join(root, "doomed");
    git(["worktree", "add", "-q", doomed, "-b", "feat/doomed"], main);
    expect(existsSync(doomed)).toBe(true);

    removeWorktreeAt(main, doomed);

    expect(existsSync(doomed)).toBe(false);
    // The branch is what `restoreWorktree` rebuilds a checkout from, so a
    // reclaim that took it too would quietly turn Resume into a broken button.
    const branches = git(["branch", "--list", "feat/doomed"], main);
    expect(branches.trim()).toContain("feat/doomed");
  });

  test("a directory git has forgotten is still removed", () => {
    // The state an interrupted removal leaves behind: on disk, but no longer a
    // registered worktree. `git worktree remove` refuses these, so without the
    // fallback they would be permanently un-reclaimable.
    const orphan = join(root, "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "junk.txt"), "x", "utf8");

    removeWorktreeAt(main, orphan);
    expect(existsSync(orphan)).toBe(false);
  });
});
