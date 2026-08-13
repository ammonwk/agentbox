import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SkillInfo } from "./types";

/**
 * Where we look for skills, in **precedence** order — first root to supply a
 * name wins. Display order is irrelevant; the result is sorted by name.
 *
 * The order is omp's, read out of its bundle rather than chosen by us, because
 * this list answers "what can my agents reach" and the agent is omp: a
 * different order would confidently describe a skill omp will not load. omp
 * registers its `.claude` provider at `priority: 80` and its `.agent`/`.agents`
 * provider at `priority: 70`, and sorts providers *descending* by priority — so
 * `.claude` is consulted first. Project-level beats user-level within a
 * provider, which is why the repo-local root leads.
 */
const SKILL_ROOTS: { source: SkillInfo["source"]; dir: string }[] = [
  { source: "project", dir: join(process.cwd(), ".claude", "skills") },
  { source: "global", dir: join(homedir(), ".claude", "skills") },
  { source: "agents", dir: join(homedir(), ".agents", "skills") },
];

/**
 * Parse the leading YAML frontmatter of a SKILL.md — just the two keys we
 * display; the body is not read, because nothing renders it.
 *
 * Block scalars are the point of this function. A long `description:` is
 * conventionally written folded, and reading only the rest of the key's line
 * captures the *indicator* rather than the value: 9 of 11 skills on this
 * machine rendered a bare `>` or `|` in Settings, with the prose beneath it
 * discarded. A real YAML parser is far more surface than one field needs, so
 * this handles the subset that actually appears and nothing else.
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  // Normalise line endings once, up front. `\r` is a line terminator to a JS
  // regex, so `.` never matches it — a CRLF file's `\r` survived into the
  // block-scalar body and came back out inside the description. Handling it at
  // each match site instead means every future regex here has to remember.
  const m = text.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: { name?: string; description?: string } = {};
  const lines = m[1].split("\n");

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1] as "name" | "description";
    const inline = kv[2];

    // `|`, `>` and their chomping/indentation variants (`|-`, `>+`, `|2`).
    const block = inline.match(/^([|>])([+-]?\d*|\d*[+-]?)$/);
    if (!block) {
      fm[key] = inline.replace(/^["']|["']$/g, "");
      continue;
    }

    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      // A blank line belongs to the block; the block ends at the next line
      // that is not indented past the key.
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      body.push(line);
      i = j;
    }
    const indent = Math.min(
      ...body.filter((l) => l.trim() !== "").map((l) => l.match(/^\s*/)![0].length)
    );
    const dedented = body.map((l) => l.slice(indent)).join("\n").trim();
    // Literal keeps newlines; folded joins them into paragraphs, with a blank
    // line marking a real break.
    fm[key] =
      block[1] === "|"
        ? dedented
        : dedented
            .split(/\n{2,}/)
            .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
            .join("\n\n");
  }
  return fm;
}

/** Exported for tests only — the parser is where the interesting failure was. */
export const parseFrontmatterForTest = parseFrontmatter;

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
      // Deliberately not `entry.isDirectory()`, which is false for a *symlinked*
      // skill directory — and symlinking one root's skill into another is how
      // people share them (`~/.claude/skills/agent-browser` is exactly that).
      // The SKILL.md check below subsumes it: `existsSync` follows the link, and
      // answers false for a plain file and for a dangling link, of which this
      // machine has one.
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
  // One entry per name. The same skill is commonly present under two roots, and
  // listing it twice makes this read as two skills when an agent will only ever
  // resolve one.
  //
  // These are not always copies of each other: on this machine `go-for-it` and
  // `vibed` differ between roots by more than a kilobyte, and `vibed`'s two
  // descriptions describe visibly different behaviour. So the winner is not
  // arbitrary and the precedence has to match omp's, which SKILL_ROOTS now does
  // and cites. The surviving entry keeps its own `source` and `path`, so the UI
  // still says truthfully which copy won.
  const byName = new Map<string, SkillInfo>();
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }

  const unique = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills: unique, warnings };
}
