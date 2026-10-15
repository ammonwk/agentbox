/** The Update button appears when the checkout's branch is ahead of the
 *  commit the server runs, and only then. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { behindHead } from "../behind";

let repo: string;
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe" }).stdout.toString().trim();
const commit = (msg: string) => { writeFileSync(join(repo, "f"), msg); git("add", "f"); git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "behind-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("behind by the commits made since the running one; not behind at HEAD, off it, or unknown", () => {
  const running = commit("one");
  expect(behindHead(repo, running)).toBeNull();
  commit("two");
  const head = commit("three");
  expect(behindHead(repo, running)).toEqual({ running, head, commits: 2 });
  expect(behindHead(repo, null)).toBeNull();
  // A running commit that HEAD does not contain: a restart brings nothing newer.
  git("checkout", "-q", "-b", "side", running);
  const side = commit("side");
  git("checkout", "-q", "main");
  expect(behindHead(repo, side)).toBeNull();
});
