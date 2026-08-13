import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SkillInfo } from "./types";

/** Where we look for skills, in display order (most "global" first). */
const SKILL_ROOTS: { source: SkillInfo["source"]; dir: string }[] = [
  { source: "global", dir: join(homedir(), ".claude", "skills") },
  { source: "agents", dir: join(homedir(), ".agents", "skills") },
  { source: "project", dir: join(process.cwd(), ".claude", "skills") },
];

/** Parse the leading YAML frontmatter block of a SKILL.md. Only the two scalar
 *  keys we display are read; the body is not, because nothing renders it. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm: { name?: string; description?: string } = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) fm[kv[1] as "name" | "description"] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

export interface SkillScan {
  skills: SkillInfo[];
  warnings: string[];
}

/**
 * Every SKILL.md under the known roots.
 *
 * This walks the filesystem and reads every file it finds, so like `listPrs`
 * it belongs to the cold refresh only — it was previously recomputed on every
 * 400ms broadcast.
 */
export function listSkills(): SkillScan {
  const skills: SkillInfo[] = [];
  const warnings: string[] = [];
  for (const { source, dir } of SKILL_ROOTS) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`Could not read skills in ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const file = join(skillDir, "SKILL.md");
      if (!existsSync(file)) continue;
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (e) {
        warnings.push(`Could not read ${file}: ${(e as Error).message}`);
        continue;
      }
      const fm = parseFrontmatter(raw);
      skills.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? "",
        source,
        path: skillDir,
      });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}
