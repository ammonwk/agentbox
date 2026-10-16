/** Integrating a branch into a checkout that others are editing must never
 *  lose, stage or commit one of their edits, and must change nothing when it
 *  cannot finish. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrate } from "../integrate";

let repo: string;
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trimEnd();
};
const lines = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i] ?? `line ${i}`).join("\n") + "\n";
const read = (f: string) => readFileSync(join(repo, f), "utf8");
const write = (f: string, s: string) => writeFileSync(join(repo, f), s);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "integrate-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  write("a.ts", lines(20));
  write("b.ts", lines(5));
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "fix");
  write("a.ts", lines(20, { 2: "fixed 2" }));
  write("c.ts", "new\n");
  git("add", ".");
  git("commit", "-qm", "fix");
  git("checkout", "-q", "main");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("a branch goes in around another session's uncommitted edit of the same file, which stays unstaged", () => {
  write("a.ts", lines(20, { 17: "someone else's edit" }));
  write("b.ts", lines(5, { 0: "untouched by the branch" }));
  const r = integrate({ checkout: repo, branch: "fix", check: false });
  expect(r.fastForward).toBe(true);
  expect(git("rev-parse", "main")).toBe(git("rev-parse", "fix"));
  expect(read("a.ts")).toBe(lines(20, { 2: "fixed 2", 17: "someone else's edit" }));
  expect(read("c.ts")).toBe("new\n");
  expect(read("b.ts")).toBe(lines(5, { 0: "untouched by the branch" }));
  expect(r.merged).toEqual(["a.ts"]);
  // Nothing staged; the others' edits are plain modifications against the new HEAD.
  expect(git("diff", "--cached", "--name-only")).toBe("");
  expect(git("status", "--porcelain").split("\n").sort()).toEqual([" M a.ts", " M b.ts"]);
  expect(git("diff", "HEAD", "--", "a.ts")).toContain("+someone else's edit");
  expect(git("diff", "HEAD", "--", "a.ts")).not.toContain("fixed 2");
});

test("a branch behind main is replayed onto it", () => {
  write("b.ts", lines(5, { 4: "main moved" }));
  git("commit", "-qam", "main moves");
  const r = integrate({ checkout: repo, branch: "fix", check: false });
  expect(r.fastForward).toBe(false);
  expect(git("log", "--format=%s", "-3", "main").split("\n")).toEqual(["fix", "main moves", "base"]);
  expect(read("a.ts")).toContain("fixed 2");
  expect(read("b.ts")).toContain("main moved");
  expect(git("status", "--porcelain")).toBe("");
});

test("a conflict with an uncommitted edit changes nothing", () => {
  write("a.ts", lines(20, { 2: "their own line 2" }));
  const head = git("rev-parse", "main");
  expect(() => integrate({ checkout: repo, branch: "fix", check: false })).toThrow(/conflict.*\n.*a\.ts/);
  expect(git("rev-parse", "main")).toBe(head);
  expect(read("a.ts")).toBe(lines(20, { 2: "their own line 2" }));
  expect(existsSync(join(repo, "c.ts"))).toBe(false);
});

test("a branch that does not apply onto main changes nothing", () => {
  write("a.ts", lines(20, { 2: "main's line 2" }));
  git("commit", "-qam", "main moves");
  const head = git("rev-parse", "main");
  expect(() => integrate({ checkout: repo, branch: "fix", check: false })).toThrow(/does not apply.*a\.ts/);
  expect(git("rev-parse", "main")).toBe(head);
  expect(git("status", "--porcelain")).toBe("");
  expect(git("worktree", "list").split("\n")).toHaveLength(1);
});

test("staged changes, a branch already in, and a detached HEAD are refused", () => {
  write("b.ts", "staged\n");
  git("add", "b.ts");
  expect(() => integrate({ checkout: repo, branch: "fix", check: false })).toThrow(/staged/);
  git("reset", "-q");
  expect(() => integrate({ checkout: repo, branch: "main", check: false })).toThrow(/already in/);
  git("checkout", "-q", "--detach");
  expect(() => integrate({ checkout: repo, branch: "fix", check: false })).toThrow(/detached/);
});
