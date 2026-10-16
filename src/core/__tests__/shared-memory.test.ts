import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resyncShared } from "../accounts/homes";

const dir = mkdtempSync(join(tmpdir(), "agentbox-memory-"));
const saved = process.env.HOME;
const shared = join(dir, "home", ".claude");
const home = join(dir, "acct1");

function put(root: string, slug: string, files: Record<string, string>): void {
  const m = join(root, "projects", slug, "memory");
  mkdirSync(m, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(m, name), body);
}

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  put(shared, "-repo", { "MEMORY.md": "- [A](a.md) — a\n", "a.md": "shared a" });
  put(home, "-repo", { "MEMORY.md": "# Memory\n- [A](a.md) — a\n- [B](b.md) — b\n", "a.md": "account a", "b.md": "b" });
  put(home, "-other", { "MEMORY.md": "- [C](c.md) — c\n", "c.md": "c" });
  mkdirSync(join(home, "projects", "-repo", "t.jsonl"), { recursive: true });
});

afterAll(() => {
  process.env.HOME = saved;
  rmSync(dir, { recursive: true, force: true });
});

test("every account reads and writes the default home's memory, keeping what it had", () => {
  const made = resyncShared({ provider: "claude", home, isDefault: false });
  expect(made).toContain("projects/-repo/memory");
  expect(made).toContain("projects/-other/memory");

  for (const slug of ["-repo", "-other"]) {
    const link = join(home, "projects", slug, "memory");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(shared, "projects", slug, "memory")));
  }
  const repo = join(shared, "projects", "-repo", "memory");
  expect(readFileSync(join(repo, "a.md"), "utf8")).toBe("shared a");
  expect(readFileSync(join(repo, "a-acct1.md"), "utf8")).toBe("account a");
  expect(readFileSync(join(repo, "b.md"), "utf8")).toBe("b");
  expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe("- [A](a.md) — a\n- [A](a-acct1.md) — a\n- [B](b.md) — b\n");
  expect(readFileSync(join(shared, "projects", "-other", "memory", "c.md"), "utf8")).toBe("c");
  expect(readdirSync(join(home, "projects", "-repo")).sort()).toEqual(["memory", "t.jsonl"]);

  writeFileSync(join(home, "projects", "-repo", "memory", "d.md"), "d");
  expect(existsSync(join(repo, "d.md"))).toBe(true);
  expect(resyncShared({ provider: "claude", home, isDefault: false }).filter((m) => m.startsWith("projects/"))).toEqual([]);
});

test("a project with no memory anywhere gets no directory in the account", () => {
  mkdirSync(join(shared, "projects", "-empty", "memory"), { recursive: true });
  resyncShared({ provider: "claude", home, isDefault: false });
  expect(existsSync(join(home, "projects", "-empty"))).toBe(false);
});
