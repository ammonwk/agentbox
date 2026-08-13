import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, resolveDefaultBranch, run, slugFromRemoteUrl } from "../git";
import { worktreeRoot } from "../paths";
import { useTempHome } from "./tmp-home";
import type { Repo } from "../types";

describe("slugFromRemoteUrl", () => {
  test("recognises every shape of GitHub remote", () => {
    const cases: [string, string][] = [
      ["https://github.com/owner/repo.git", "owner/repo"],
      ["https://github.com/owner/repo", "owner/repo"],
      ["https://github.com/owner/repo/", "owner/repo"],
      ["https://user@github.com/owner/repo.git", "owner/repo"],
      ["https://www.github.com/owner/repo", "owner/repo"],
      ["git@github.com:owner/repo.git", "owner/repo"],
      ["git@github.com:owner/repo", "owner/repo"],
      ["ssh://git@github.com/owner/repo.git", "owner/repo"],
      ["ssh://git@github.com:22/owner/repo.git", "owner/repo"],
      ["git://github.com/owner/repo.git", "owner/repo"],
      // A name that itself contains dots — the old regex stopped at the first one.
      ["git@github.com:owner/my.repo.name.git", "owner/my.repo.name"],
      ["https://github.com/owner/dot.name", "owner/dot.name"],
    ];
    for (const [url, slug] of cases) expect([url, slugFromRemoteUrl(url)]).toEqual([url, slug]);
  });

  test("a non-GitHub remote is null, honestly", () => {
    for (const url of [
      "git@gitlab.com:owner/repo.git",
      "https://bitbucket.org/owner/repo.git",
      "https://github.example.com/owner/repo.git",
      "https://notgithub.com/owner/repo",
      "/srv/git/repo.git",
      "../sibling-repo",
      "",
    ]) {
      expect([url, slugFromRemoteUrl(url)]).toEqual([url, null]);
    }
  });

  test("a GitHub URL that is not a repo is null", () => {
    expect(slugFromRemoteUrl("https://github.com/owner")).toBeNull();
    expect(slugFromRemoteUrl("https://github.com/owner/repo/extra")).toBeNull();
  });
});

describe("worktrees", () => {
  let root: string;
  let repo: string;
  // These tests really do call `git worktree add`, which writes under
  // `worktreeRoot()`. Without a temp home that is the developer's live agentbox
  // data directory — the bug this suite used to have.
  let home: ReturnType<typeof useTempHome>;

  function git(args: string[], cwd = repo) {
    const r = run(["git", ...args], cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  }

  function record(): Repo {
    return { id: "r", ref: repo, kind: "local", displayName: "repo", fullName: null, defaultBranch: "main", addedAt: 0 };
  }

  beforeAll(() => {
    home = useTempHome();
    root = mkdtempSync(join(tmpdir(), "agentbox-git-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    // Leave HEAD somewhere other than the default branch: the old code cut new
    // worktrees from HEAD, so this is the condition that made it wrong.
    git(["checkout", "-q", "-b", "some-side-branch"]);
    writeFileSync(join(repo, "side.txt"), "side\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "side work"]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    // Removes the worktrees too — they live under the temp home, which is the
    // whole point of using one.
    home.restore();
  });

  test("resolveDefaultBranch falls back to the checked-out branch with no remote", () => {
    // No origin at all: the honest answer is the branch that exists.
    expect(resolveDefaultBranch(repo)).toBe("main");
  });

  test("worktrees land under the overridden AGENTBOX_HOME, not the real one", () => {
    // The regression guard for the bug this suite caused: paths.ts used to bind
    // AGENTBOX_HOME at import, so this override did nothing and `git worktree
    // add` ran against the developer's live data directory.
    const id = `home-${Date.now()}`;
    const { path } = createWorktree(record(), id, "vk/ab-home");
    expect(worktreeRoot().startsWith(home.home)).toBe(true);
    expect(path.startsWith(home.home)).toBe(true);
  });

  test("a new worktree is cut from the default branch, not from HEAD", () => {
    const id = `cut-${Date.now()}`;
    const { path } = createWorktree(record(), id, "vk/ab-cut");
    // HEAD in the source checkout is `some-side-branch`, which has side.txt.
    expect(existsSync(join(path, "a.txt"))).toBe(true);
    expect(existsSync(join(path, "side.txt"))).toBe(false);
  });

  test("an existing branch is checked out rather than recreated", () => {
    const id = `existing-${Date.now()}`;
    run(["git", "branch", "vk/ab-existing", "some-side-branch"], repo);
    const { path } = createWorktree(record(), id, "vk/ab-existing");
    // Reusing the branch must not reset it onto the default branch.
    expect(existsSync(join(path, "side.txt"))).toBe(true);
  });

  test("a branch already checked out elsewhere fails with a message naming where", () => {
    const first = `taken-a-${Date.now()}`;
    createWorktree(record(), first, "vk/ab-taken");
    const second = `taken-b-${Date.now()}`;
    expect(() => createWorktree(record(), second, "vk/ab-taken")).toThrow(/already checked out at/);
  });

  test("re-creating the same session's worktree reuses it", () => {
    const id = `reuse-${Date.now()}`;
    const a = createWorktree(record(), id, "vk/ab-reuse");
    const b = createWorktree(record(), id, "vk/ab-reuse");
    expect(b.path).toBe(a.path);
  });

  test("continuing an unknown branch says so instead of inventing one", () => {
    const id = `missing-${Date.now()}`;
    expect(() => createWorktree(record(), id, "unused", "no-such-branch")).toThrow(
      /not in this repo or on its remote/
    );
  });
});
