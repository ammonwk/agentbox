/** A restart must serve what is committed, and only that: another session's
 *  unfinished edit in the checkout must never reach the server. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareServe, setServesFromCommit, sourceCheckout, syncSnapshot } from "../snapshot";

let root: string, source: string, live: string, previous: string | undefined;
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
const write = (f: string, s: string) => writeFileSync(join(source, f), s);
const commit = (msg: string) => (git("add", "."), git("commit", "-qm", msg), git("rev-parse", "HEAD"));
const builds = () => readFileSync(join(source, "builds.log"), "utf8").trim().split("\n").filter(Boolean).length;

beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  root = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  process.env.AGENTBOX_HOME = join(root, "home");
  source = join(root, "checkout");
  live = join(root, "home", "live");
  mkdirSync(join(source, "web"), { recursive: true });
  mkdirSync(join(source, "bin"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  // A stand-in for vite: writes the page named by web/page.txt to --outDir, and counts its runs.
  write("package.json", JSON.stringify({ scripts: { "web:build": "bun build.ts" } }));
  write("build.ts", `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--outDir") + 1];
appendFileSync(${JSON.stringify(join(root, "checkout", "builds.log"))}, "build\\n");
const page = readFileSync("web/page.txt", "utf8");
if (page.includes("broken")) process.exit(1);
mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.html", page);`);
  write("web/page.txt", "v1");
  write("bin/agentbox", "server v1");
  write(".gitignore", "builds.log\n");
  writeFileSync(join(source, "builds.log"), "");
  commit("v1");
});
afterEach(() => {
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  delete process.env.AGENTBOX_FROM_COMMIT;
  rmSync(root, { recursive: true, force: true });
});

test("the snapshot holds the checkout's HEAD commit, never its uncommitted edits, and builds the UI only when web/ changed", () => {
  const first = syncSnapshot(source, live);
  expect(first).toMatchObject({ dir: live, commit: git("rev-parse", "HEAD"), built: true });
  expect(readFileSync(join(live, "web", "dist", "index.html"), "utf8")).toBe("v1");
  // The snapshot's own CLI acts on the checkout it was made from.
  expect(realpathSync(sourceCheckout(live))).toBe(realpathSync(source));
  expect(sourceCheckout(source)).toBe(source);

  write("bin/agentbox", "someone's unfinished edit");
  write("web/page.txt", "unfinished page");
  expect(syncSnapshot(source, live).built).toBe(false);
  expect(readFileSync(join(live, "bin", "agentbox"), "utf8")).toBe("server v1");
  expect(builds()).toBe(1);

  git("checkout", "--", "web/page.txt");
  write("bin/agentbox", "server v2");
  const v2 = commit("v2");
  expect(syncSnapshot(source, live)).toMatchObject({ commit: v2, built: false });
  expect(readFileSync(join(live, "bin", "agentbox"), "utf8")).toBe("server v2");

  write("web/page.txt", "v3");
  commit("v3");
  expect(syncSnapshot(source, live).built).toBe(true);
  expect(readFileSync(join(live, "web", "dist", "index.html"), "utf8")).toBe("v3");
  expect(builds()).toBe(2);
});

test("a failed UI build keeps the build that was there", () => {
  syncSnapshot(source, live);
  write("web/page.txt", "broken");
  const bad = commit("broken page");
  const lines: string[] = [];
  expect(syncSnapshot(source, live, (l) => lines.push(l))).toMatchObject({ commit: bad, built: false });
  expect(readFileSync(join(live, "web", "dist", "index.html"), "utf8")).toBe("v1");
  expect(lines.join("\n")).toContain("serving the previous build");
});

test("serve runs from the snapshot only when this machine chose it, and from the last good one when a sync fails", () => {
  process.env.AGENTBOX_FROM_COMMIT = "";
  expect(prepareServe(source, () => {})).toBeNull();
  setServesFromCommit(true);
  expect(prepareServe(source, () => {})).toBe(live);
  expect(prepareServe(live, () => {})).toBeNull();
  // A first build that fails leaves nothing to serve: the working tree runs.
  rmSync(live, { recursive: true, force: true });
  git("worktree", "prune");
  write("web/page.txt", "broken");
  commit("broken");
  expect(prepareServe(source, () => {})).toBeNull();
  expect(existsSync(join(live, "web", "dist", "index.html"))).toBe(false);
  process.env.AGENTBOX_FROM_COMMIT = "0";
  expect(prepareServe(source, () => {})).toBeNull();
  setServesFromCommit(false);
});
