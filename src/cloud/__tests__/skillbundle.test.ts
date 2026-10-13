/** Installing a skill revision never destroys an edit made by hand: an
 *  edited file is kept (or, forced, backed up first), and a directory that
 *  did not come from the cloud is refused. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, readSkillDir, SkillBundleError } from "../skillbundle";
import type { SkillRevision } from "../protocol";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const source = { url: "http://127.0.0.1:1", workspaceId: "w", workspaceSlug: "team", skillId: "s1" };

function revision(rev: number, files: Record<string, string>): SkillRevision {
  return {
    skill_id: "s1", workspace_id: "w", rev, description: "", bundle_sha256: `b${rev}`, total_bytes: 0, summary: "",
    created_by: "u", created_by_installation: null, created_at: "",
    files: Object.entries(files).map(([path, content]) => ({ path, content, sha256: sha(content), bytes: content.length })),
  };
}

describe("skill install", () => {
  const base = mkdtempSync(join(tmpdir(), "abskill-"));
  const root = join(base, "skills");
  const dirs = { incomingDir: join(base, "incoming"), backupDir: join(base, "backup") };
  const dir = join(root, "deploy");

  test("keeps an edited file, updates the rest, and forced replacement backs the edit up", () => {
    installSkill({ root, name: "deploy", revision: revision(1, { "SKILL.md": "v1", "notes.md": "n1", "old.md": "o1" }), source, ...dirs });
    writeFileSync(join(dir, "SKILL.md"), "my edit");
    const r2 = installSkill({ root, name: "deploy", revision: revision(2, { "SKILL.md": "v2", "notes.md": "n2" }), source, ...dirs });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("my edit");
    expect(readFileSync(r2.kept[0]!.incoming, "utf8")).toBe("v2");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("n2");
    expect(existsSync(join(dir, "old.md"))).toBe(false);
    // Still edited against rev 2's copy, so a plain reinstall keeps it again.
    installSkill({ root, name: "deploy", revision: revision(2, { "SKILL.md": "v2", "notes.md": "n2" }), source, ...dirs });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("my edit");
    const r3 = installSkill({ root, name: "deploy", revision: revision(3, { "SKILL.md": "v3", "notes.md": "n2" }), source, ...dirs, force: true });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("v3");
    expect(readFileSync(r3.replaced[0]!.backup, "utf8")).toBe("my edit");
  });

  test("refuses a directory that did not come from the cloud, or from another skill", () => {
    mkdirSync(join(root, "mine"), { recursive: true });
    writeFileSync(join(root, "mine", "SKILL.md"), "hand made");
    expect(() => installSkill({ root, name: "mine", revision: revision(1, { "SKILL.md": "x" }), source, ...dirs })).toThrow(SkillBundleError);
    expect(readFileSync(join(root, "mine", "SKILL.md"), "utf8")).toBe("hand made");
    expect(() => installSkill({ root, name: "deploy", revision: revision(4, { "SKILL.md": "x" }), source: { ...source, skillId: "other" }, ...dirs })).toThrow(SkillBundleError);
  });

  test("a damaged bundle writes nothing", () => {
    const bad = revision(1, { "SKILL.md": "ok" });
    bad.files![0]!.content = "tampered";
    expect(() => installSkill({ root, name: "fresh", revision: bad, source, ...dirs })).toThrow(SkillBundleError);
    expect(existsSync(join(root, "fresh"))).toBe(false);
  });

  test("a bundle read back leaves out the manifest and dotfiles", () => {
    writeFileSync(join(dir, ".secret"), "x");
    expect(readSkillDir(dir).map((f) => f.path).sort()).toEqual(["SKILL.md", "notes.md"]);
  });
});
