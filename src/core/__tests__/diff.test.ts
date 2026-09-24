import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseFor, diffOf } from "../diff";
import { addRepo } from "../db";
import { run } from "../git";
import { useTempHome } from "./tmp-home";
import type { Session, SessionDiff } from "../types";

/**
 * These run against a real git repository. Diff parsing is entirely about what
 * git actually prints — a fixture of hand-written `--numstat` output would only
 * pin our assumption about it.
 */

let root: string;
let repo: string;
let wt: string;
// `diffOf(session)` without an explicit base reaches the repo registry, which
// opens the database under AGENTBOX_HOME. Never the real one.
let home: ReturnType<typeof useTempHome>;

function git(args: string[], cwd = repo) {
  const r = run(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function session(worktree: string | null): Session {
  return {
    id: "s1", provider: "claude", agentSessionId: "a", accountId: null, status: "waiting", host: "none",
    title: "t", label: null, cwd: worktree ?? "/nonexistent", repoRoot: repo, branch: "work", worktree,
    model: "m", firstPrompt: null, lastPrompt: null, lastMessage: null, contextUsed: null, contextLimit: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 }, big: false, claim: 0,
    origin: "agentbox", pid: null, tmux: null, transcriptPath: null, startedAt: 0, lastActivityAt: 0,
    archivedAt: null, prNumber: null,
  };
}

function fileIn(d: SessionDiff, path: string) {
  const f = d.files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in [${d.files.map((x) => x.path).join(", ")}]`);
  return f;
}

beforeAll(() => {
  home = useTempHome();
  root = mkdtempSync(join(tmpdir(), "agentbox-diff-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "doomed.txt"), "bye\n");
  writeFileSync(join(repo, "moved.txt"), "same content stays identical\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  wt = join(root, "wt");
  git(["worktree", "add", "-q", "-b", "work", wt, "main"]);

  // A commit landing on main after the branch was cut: the diff must not report
  // it as something this session deleted.
  writeFileSync(join(repo, "landed-on-main.txt"), "not the agent's doing\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "main moves on"]);

  // The agent's work: an edit, a delete, a rename, an untracked text file and
  // an untracked binary.
  writeFileSync(join(wt, "kept.txt"), "one\ntwo\nthree\nfour\n");
  rmSync(join(wt, "doomed.txt"));
  git(["mv", "moved.txt", "renamed.txt"], wt);
  git(["add", "-A"], wt);
  git(["commit", "-qm", "agent work"], wt);
  writeFileSync(join(wt, "brand-new.txt"), "alpha\nbeta\n");
  writeFileSync(join(wt, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
  mkdirSync(join(wt, "nested"));
  writeFileSync(join(wt, "nested", "deep new file.txt"), "spaces in the name\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  home.restore();
});

describe("diffOf", () => {
  test("a missing worktree is unavailable, not an exception", () => {
    expect(diffOf(session(null), "main").unavailable).toBe(true);
    expect(diffOf(session(join(root, "gone")), "main").unavailable).toBe(true);
  });

  test("a path that exists but is not a git worktree is unavailable", () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(diffOf(session(plain), "main").unavailable).toBe(true);
  });

  test("diffs against the merge base, not the tip of main", () => {
    const d = diffOf(session(wt), "main");
    expect(d.unavailable).toBe(false);
    // landed-on-main.txt exists only on main after the cut. Diffing the tip
    // would render it as a deletion by this session.
    expect(d.files.map((f) => f.path)).not.toContain("landed-on-main.txt");
  });

  test("a modified file carries its counts and its patch", () => {
    const f = fileIn(diffOf(session(wt), "main"), "kept.txt");
    expect(f.status).toBe("modified");
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(0);
    expect(f.patch).toContain("+four");
  });

  test("a deleted file is reported as deleted", () => {
    const f = fileIn(diffOf(session(wt), "main"), "doomed.txt");
    expect(f.status).toBe("deleted");
    expect(f.deletions).toBe(1);
  });

  test("a rename is reported once, under its new path", () => {
    const d = diffOf(session(wt), "main");
    expect(fileIn(d, "renamed.txt").status).toBe("renamed");
    expect(d.files.map((f) => f.path)).not.toContain("moved.txt");
  });

  test("an untracked file is visible — the most common shape of agent work", () => {
    const f = fileIn(diffOf(session(wt), "main"), "brand-new.txt");
    expect(f.status).toBe("untracked");
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(0);
    expect(f.patch).toContain("+alpha");
    expect(f.patch).toContain("+beta");
  });

  test("an untracked path with spaces survives the NUL-delimited parse", () => {
    const f = fileIn(diffOf(session(wt), "main"), "nested/deep new file.txt");
    expect(f.status).toBe("untracked");
    expect(f.additions).toBe(1);
  });

  test("a binary file has no patch and claims no line counts", () => {
    const f = fileIn(diffOf(session(wt), "main"), "logo.png");
    expect(f.patch).toBeNull();
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });

  test("a tracked binary file also reports patch: null", () => {
    const binWt = join(root, "wt-bin");
    git(["worktree", "add", "-q", "-b", "bin-work", binWt, "main"]);
    writeFileSync(join(binWt, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 9]));
    git(["add", "-A"], binWt);
    git(["commit", "-qm", "add binary"], binWt);
    const f = fileIn(diffOf(session(binWt), "main"), "blob.bin");
    expect(f.patch).toBeNull();
    expect(f.additions).toBe(0);
  });

  test("totals are the sum of the files", () => {
    const d = diffOf(session(wt), "main");
    expect(d.additions).toBe(d.files.reduce((n, f) => n + f.additions, 0));
    expect(d.deletions).toBe(d.files.reduce((n, f) => n + f.deletions, 0));
    expect(d.additions).toBeGreaterThan(0);
    expect(d.base).toBe("main");
  });

  test("an enormous file is truncated, and says so", () => {
    const bigWt = join(root, "wt-big");
    git(["worktree", "add", "-q", "-b", "big-work", bigWt, "main"]);
    const line = "x".repeat(200) + "\n";
    writeFileSync(join(bigWt, "huge.txt"), line.repeat(2000)); // ~400 KB
    const f = fileIn(diffOf(session(bigWt), "main"), "huge.txt");
    expect(f.additions).toBe(2000); // the count stays exact
    expect(f.patch).toContain("truncated");
    expect(f.patch!.length).toBeLessThan(200 * 1024);
  });

  test("with no base given, it resolves the session's repo default branch", async () => {
    // The registry is the only thing that knows a session's repo has a default
    // branch other than "main" — which is why resolving it lives here and not
    // in the HTTP route.
    const registered = await addRepo(repo);
    expect(registered.defaultBranch).toBe("main");
    const s = { ...session(wt), repo };
    expect(baseFor(s)).toBe("main");
    expect(diffOf(s).base).toBe("main");
    expect(diffOf(s).files.map((f) => f.path)).toEqual(diffOf(s, "main").files.map((f) => f.path));
  });

  test("an unregistered repo falls back rather than throwing", () => {
    const s = { ...session(wt), repo: "/gone/from/the/registry" };
    expect(baseFor(s)).toBe("main");
    expect(diffOf(s).unavailable).toBe(false);
  });

  test("an unrelated base still produces the whole worktree rather than failing", () => {
    const d = diffOf(session(wt), "no-such-branch");
    expect(d.unavailable).toBe(false);
    expect(d.base).toBe("no-such-branch");
    expect(d.files.length).toBeGreaterThan(0);
  });
});
