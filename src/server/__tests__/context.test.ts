import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../../core/types";
import { RULES_MAX_BYTES, readRules } from "../../core/rules";
import { contextDocPath, writeContextDoc } from "../context";

/**
 * The id → path mapping is the only thing standing between a browser and
 * `writeFileSync`: the Context page sends an id, never a path. A regression
 * here is an arbitrary-file write on a loopback-trusted server, so it is
 * pinned rather than trusted to the review.
 */
const repo = (id: string, ref: string, kind: "local" | "github" = "local"): Repo => ({
  id,
  ref,
  kind,
  displayName: id,
  fullName: `you/${id}`,
  defaultBranch: "main",
  addedAt: 0,
  worktreeDefault: null,
  setup: { copy: [], run: "" },
});

const repos = [repo("one", "/repos/one"), repo("two", "you/two", "github")];

test("a context id names a file agentbox manages, at the scope it says", () => {
  expect(contextDocPath("rules:global", repos)).toEndWith("/rules.md");
  expect(contextDocPath("rules:repo:one", repos)).toEndWith("/rules/one.md");
  expect(contextDocPath("instructions:repo:one:AGENTS.md", repos)).toBe("/repos/one/AGENTS.md");
  expect(contextDocPath("instructions:repo:one:CLAUDE.md", repos)).toBe("/repos/one/CLAUDE.md");
  expect(contextDocPath("instructions:global:claude", repos)).toEndWith("/.claude/CLAUDE.md");
});

test("an id that names no such file resolves to nothing, so the write is refused", () => {
  // A registered repo is required: an id may not invent one.
  expect(contextDocPath("rules:repo:nope", repos)).toBeNull();
  // Only the catalogued names, never a path of the caller's choosing.
  expect(contextDocPath("instructions:repo:one:../../.env", repos)).toBeNull();
  expect(contextDocPath("instructions:global:devin", repos)).toBeNull();
  expect(contextDocPath("/etc/passwd", repos)).toBeNull();
  expect(contextDocPath("", repos)).toBeNull();
  expect(contextDocPath("rules:global\u0000", repos)).toBeNull();
});

const dir = mkdtempSync(join(tmpdir(), "ab-rules-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a rules file over the cap is cut at a whole line and says so", () => {
  writeFileSync(join(dir, "small.md"), "one\ntwo\n");
  expect(readRules(join(dir, "small.md"))).toBe("one\ntwo");

  writeFileSync(join(dir, "big.md"), `${"x".repeat(100)}\n`.repeat(200));
  const cut = readRules(join(dir, "big.md"));
  expect(cut.length).toBeLessThan(RULES_MAX_BYTES + 200);
  expect(cut).toEndWith(`[The rest of this file was not read: it is over ${RULES_MAX_BYTES / 1024} KB.]`);
  // Whole lines only: no half line reaches a prompt.
  expect(cut.split("\n").at(-3)).toBe("x".repeat(100));

  expect(readRules(join(dir, "missing.md"))).toBe("");
});

test("a save writes the catalogued file, making the rules directory if it is new", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-context-home-"));
  const was = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  try {
    const checkout = join(home, "checkout");
    mkdirSync(checkout);
    const here = [repo("one", checkout)];

    const rules = writeContextDoc("rules:repo:one", "keep it short\n", here);
    expect(rules?.path).toBe(join(home, "rules", "one.md"));
    expect(readFileSync(rules!.path, "utf8")).toBe("keep it short\n");
    // What a session would be given from it.
    expect(rules!.injected).toBe("keep it short");

    const file = writeContextDoc("instructions:repo:one:CLAUDE.md", "# hi\n", here);
    expect(file?.path).toBe(join(checkout, "CLAUDE.md"));
    expect(readFileSync(file!.path, "utf8")).toBe("# hi\n");

    // A doc id that names nothing writes nothing.
    expect(writeContextDoc("rules:repo:nope", "x", here)).toBeNull();
  } finally {
    if (was === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = was;
    rmSync(home, { recursive: true, force: true });
  }
});
