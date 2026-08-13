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

interface Frontmatter {
  name?: string;
  description?: string;
}

/** Parse the leading YAML frontmatter block of a SKILL.md. */
function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Frontmatter = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) (fm as Record<string, string>)[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { fm, body: m[2].trim() };
}

export function listSkills(): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const { source, dir } of SKILL_ROOTS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const file = join(skillDir, "SKILL.md");
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf8");
      const { fm, body } = parseFrontmatter(raw);
      out.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? "",
        source,
        path: skillDir,
        body,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
