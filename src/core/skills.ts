import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userHome } from "./paths";
import type { SkillInfo, SkillResult } from "./types";

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
 *
 * Resolved per call rather than at module scope. `process.cwd()` genuinely
 * changes during a process, and freezing it at import pinned the project root
 * to whatever directory the server happened to start in — the same shape as the
 * `paths.ts` bug that had tests writing into the developer's real data.
 */
export interface SkillRoot {
  source: SkillInfo["source"];
  dir: string;
  /** For a repo's own skills, the repo they belong to. */
  repo?: string;
}


/**
 * Every place a skill can live, in the order they shadow each other: a repo's
 * own skills first, then the user-level ones each provider reads. Claude's and
 * the shared `.agents` roots come before codex's and omp's because those two
 * CLIs also read the first two — a skill in both is the same skill.
 *
 * Accounts other than the default share `~/.claude/skills` by symlink (see
 * accounts/homes.ts), so there is exactly one global root per provider no
 * matter how many accounts are logged in.
 */
export function skillRoots(repoDirs: string[] = []): SkillRoot[] {
  return [
    ...repoDirs.map((d) => ({ source: "project" as const, dir: join(d, ".claude", "skills"), repo: d })),
    { source: "project", dir: join(process.cwd(), ".claude", "skills") },
    { source: "global", dir: join(userHome(), ".claude", "skills") },
    { source: "agents", dir: join(userHome(), ".agents", "skills") },
    { source: "codex", dir: join(userHome(), ".codex", "skills") },
    { source: "omp", dir: join(userHome(), ".omp", "agent", "skills") },
  ];
}

/**
 * Parse the leading YAML frontmatter of a SKILL.md — the keys the UI displays
 * or acts on; the body is not read, because nothing renders it.
 *
 * Block scalars are the point of this function. A long `description:` is
 * conventionally written folded, and reading only the rest of the key's line
 * captures the *indicator* rather than the value: 9 of 11 skills on this
 * machine rendered a bare `>` or `|` in Settings, with the prose beneath it
 * discarded. A real YAML parser is far more surface than one field needs, so
 * this handles the subset that actually appears and nothing else.
 */
export function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  allowedTools?: string;
  disableModelInvocation?: string;
} {
  // Normalise line endings once, up front. `\r` is a line terminator to a JS
  // regex, so `.` never matches it — a CRLF file's `\r` survived into the
  // block-scalar body and came back out inside the description. Handling it at
  // each match site instead means every future regex here has to remember.
  const m = text.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: { name?: string; description?: string; allowedTools?: string; disableModelInvocation?: string } = {};
  const lines = m[1].split("\n");

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description|allowed-tools|disable-model-invocation):\s*(.*?)\s*$/);
    if (!kv) continue;
    // Frontmatter keys are hyphenated; the object fields are camelCase.
    const field = { "allowed-tools": "allowedTools", "disable-model-invocation": "disableModelInvocation" }[
      kv[1]
    ] ?? kv[1];
    const key = field as keyof typeof fm;
    const inline = kv[2];

    // `|`, `>` and their chomping/indentation variants (`|-`, `>+`, `|2`).
    const block = inline.match(/^([|>])([+-]?\d*|\d*[+-]?)$/);
    if (!block) {
      fm[key] = unquote(inline);
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

/** A flow scalar's value: a double-quoted one carries backslash escapes
 *  (`\"go for it\"`), which are JSON's; a single-quoted one doubles `'`. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
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
export function listSkills(roots: SkillRoot[] = skillRoots()): SkillScan {
  const skills: SkillInfo[] = [];
  const warnings: string[] = [];
  for (const { source, dir, repo } of roots) {
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
        ...(repo ? { repo } : {}),
        path: skillDir,
        lines: raw.split("\n").length,
        allowedTools: fm.allowedTools,
        // `disable-model-invocation: true` means slash-command only — a
        // meaningful distinction, because those never fire on their own.
        modelInvocable: fm.disableModelInvocation !== "true",
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
  // arbitrary and the precedence has to match omp's, which `skillRoots()` now does
  // and cites. The surviving entry keeps its own `source` and `path`, so the UI
  // still says truthfully which copy won.
  //
  // A repo's own skill shadows a global one only inside that repo, so repo
  // skills are keyed by repo as well — otherwise the first registered repo's
  // `deploy` would hide every other repo's and the global one too.
  const byName = new Map<string, SkillInfo>();
  for (const skill of skills) {
    const key = skill.repo ? `${skill.repo}\0${skill.name}` : skill.name;
    if (!byName.has(key)) byName.set(key, skill);
  }

  const unique = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills: unique, warnings };
}

// ─── Read / write / promote / demote ────────────────────────────────────────

/** The skill directory a name resolves to in the global root. */
/**
 * A skill name is one path segment. It arrives from the browser (demote) or
 * from a SKILL.md someone else wrote (promote), and joining an unchecked
 * `../../Documents` onto the skills root is how v1's demote could be asked to
 * delete a home directory.
 */
export function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

function globalSkillDir(name: string): string {
  if (!validSkillName(name)) throw new Error(`not a valid skill name: ${JSON.stringify(name)}`);
  return join(userHome(), ".claude", "skills", name);
}

/** Read a skill file. The caller confines the path before it reaches us. */
export function readSkillBody(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function writeSkillBody(path: string, body: string): boolean {
  try {
    writeFileSync(path, body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a project skill to the global directory.
 *
 * Copy, never move. The repo's copy stays where it is so that teammates and CI
 * keep working, and so an over-eager promotion is a no-op to undo rather than a
 * commit to revert. Refuses to clobber an existing global skill of the same name.
 */
export function promoteSkill(skill: SkillInfo): SkillResult {
  if (!validSkillName(skill.name)) {
    return { ok: false, from: skill.path, to: "", error: `not a valid skill name: ${JSON.stringify(skill.name)}` };
  }
  const destDir = globalSkillDir(skill.name);
  const result: SkillResult = { ok: false, from: skill.path, to: destDir };
  if (existsSync(destDir)) {
    return { ...result, error: `a global skill named "${skill.name}" already exists` };
  }
  try {
    copyDir(skill.path, destDir);
    return { ...result, ok: true };
  } catch (e) {
    return { ...result, error: e instanceof Error ? e.message : String(e) };
  }
}

export function demoteSkill(name: string): SkillResult {
  if (!validSkillName(name)) return { ok: false, from: "", to: "", error: `not a valid skill name: ${JSON.stringify(name)}` };
  const dir = globalSkillDir(name);
  const result: SkillResult = { ok: false, from: dir, to: "" };
  if (!existsSync(dir)) return { ...result, error: "not found" };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ...result, ok: true };
  } catch (e) {
    return { ...result, error: e instanceof Error ? e.message : String(e) };
  }
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) {
      // Skip scratch output — a skill's working files are not part of the skill.
      if (e.name === "scratchpad" || e.name === "node_modules") continue;
      copyDir(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
}
