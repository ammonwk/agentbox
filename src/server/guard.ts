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

import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { skillRoots } from "../core/skills";

/**
 * The real path of `candidate` if it lies inside one of `roots`, else null.
 *
 * Resolved through symlinks on both sides, so a link inside a root that points
 * out of it is refused. A path that does not exist yet falls back to lexical
 * resolution, so writing a new file inside a root still works while `..`
 * traversal is still caught by the prefix test.
 */
export function containedIn(candidate: string, roots: string[]): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  if (candidate.includes("\0")) return null;

  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    real = resolve(candidate);
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) return real;
  }
  return null;
}

/** Every directory a skill may legitimately live in, the local repos' own
 *  skill directories included. */
export function skillRootDirs(repoDirs: string[]): string[] {
  return skillRoots(repoDirs).map((r) => r.dir);
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
