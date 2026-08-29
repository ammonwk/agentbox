import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedIn, looksLikeSkillFile, skillMdPath } from "../guard";

/**
 * The containment rule is the whole point of the skill body endpoints: without
 * it a caller-supplied path is an arbitrary-file-read/write primitive. The
 * first version of the equivalent Switchyard route happily returned
 * `~/.claude/.credentials.json`.
 */
describe("containedIn", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agentbox-guard-"));
    mkdirSync(join(root, "skills", "s1"), { recursive: true });
    writeFileSync(join(root, "skills", "s1", "SKILL.md"), "body");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const roots = () => [join(root, "skills")];

  test("accepts a path inside a root", () => {
    expect(containedIn(join(root, "skills", "s1", "SKILL.md"), roots())).toBe(
      join(root, "skills", "s1", "SKILL.md")
    );
  });

  test("rejects a path outside every root", () => {
    expect(containedIn(join(root, "skills", "..", "secret.txt"), roots())).toBeNull();
  });

  test("rejects a path that merely shares a prefix with a root", () => {
    // `/a/skills-evil` is not inside `/a/skills` — the trailing-separator
    // comparison is what catches this.
    const evil = join(root, "skills-evil", "x");
    mkdirSync(join(root, "skills-evil"), { recursive: true });
    writeFileSync(evil, "x");
    expect(containedIn(evil, roots())).toBeNull();
  });

  test("rejects a null byte", () => {
    expect(containedIn(`${root}\0skills`, roots())).toBeNull();
  });

  test("a missing target falls back to lexical resolution, still confined", () => {
    // The write path resolves a file that does not exist yet.
    const newFile = join(root, "skills", "fresh", "SKILL.md");
    expect(containedIn(newFile, roots())).toBe(newFile);
  });
});

describe("looksLikeSkillFile", () => {
  test("accepts the supported skill file extensions", () => {
    for (const f of ["SKILL.md", "helper.ts", "data.json", "notes.txt", "run.sh"]) {
      expect(looksLikeSkillFile(f)).toBe(true);
    }
  });

  test("rejects dotfiles and anything else a user may have dropped in", () => {
    expect(looksLikeSkillFile(".env")).toBe(false);
    expect(looksLikeSkillFile("SKILL.md.bak")).toBe(false);
    expect(looksLikeSkillFile("no-extension")).toBe(false);
  });

  test("rejects traversal", () => {
    expect(looksLikeSkillFile("../SKILL.md")).toBe(false);
  });
});

describe("skillMdPath", () => {
  test("joins SKILL.md onto the skill directory", () => {
    expect(skillMdPath("/a/b/s1")).toBe(join("/a/b/s1", "SKILL.md"));
  });
});
