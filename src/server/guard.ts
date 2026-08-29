/** Path containment for caller-supplied skill paths.
 *
 * The skill body endpoints take a path from the browser. Without confinement
 * that is an arbitrary-file-read/write primitive — the first version of the
 * equivalent Switchyard route happily returned `~/.claude/.credentials.json`.
 *
 * Two rules, both required:
 *   1. The resolved path must live under a known skill root.
 *   2. It must look like a skill file (SKILL.md or a supporting file).
 */

import { join } from "node:path";
import { skillRoots } from "../core/skills";
import { containedIn } from "../core/place";

// Re-exported rather than defined here: the subagent MCP server needs the same
// containment test for a different reason (keeping an agent's edits inside its
// own working directory) and must not drag the skills subsystem in to get it.
export { containedIn };

/** Every directory a skill may legitimately live in. */
export function skillRootDirs(): string[] {
  return skillRoots().map((r) => r.dir);
}

/**
 * A skill path must be inside a skills root *and* be a SKILL.md or a supporting
 * file. Containment alone would still expose, say, a `.env` a user had dropped
 * into a skill directory.
 */
export function looksLikeSkillFile(path: string): boolean {
  if (/(^|\/)\.\.(\/|$)/.test(path)) return false;
  return /\.(md|txt|json|ya?ml|ts|js|py|sh)$/i.test(path);
}

/** The SKILL.md path for a skill directory — what the body endpoints read. */
export function skillMdPath(dir: string): string {
  return join(dir, "SKILL.md");
}
