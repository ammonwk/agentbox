/**
 * The user's standing rules: one file for every session, and one for the
 * sessions that run in a given repo.
 *
 *   <agentbox home>/rules.md            every session
 *   <agentbox home>/rules/<repo id>.md  sessions whose repo this is
 *
 * Theirs to write, never the repo's: nothing inside a checkout is rewritten
 * here. Read at every launch and resume (`providers/briefing.ts`), so an edit
 * reaches the next session without a restart of the server — and, like any
 * change there, spends the prompt cache of each session resumed after it once.
 *
 * The Context page (`/api/context`) is the editor; the files stay the record.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listRepos } from "./db";
import { repoCheckoutPath, repoRootOf } from "./git";
import { agentboxHome } from "./paths";
import type { Repo } from "./types";

/** How much of each rules file is read: it is in every session's prompt, so a
 *  mistake (a log redirected into it, a pasted document) must not be. */
export const RULES_MAX_BYTES = 4096;

export const rulesPath = (): string => join(agentboxHome(), "rules.md");

/** A repo's rules sit beside the global file, named by the repo's id so that
 *  renaming a repo cannot move its rules onto another one. */
export const repoRulesPath = (repoId: string): string => join(agentboxHome(), "rules", `${repoId}.md`);

/**
 * A rules file's text, cut at the last whole line inside the cap, with a line
 * saying so when it was cut; "" when there is none.
 */
export function readRules(path: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return "";
  }
  if (raw.length <= RULES_MAX_BYTES) return raw.toString("utf8").trim();
  const head = raw.subarray(0, RULES_MAX_BYTES).toString("utf8");
  const whole = head.slice(0, Math.max(head.lastIndexOf("\n"), 0)).trim();
  return `${whole}\n\n[The rest of this file was not read: it is over ${RULES_MAX_BYTES / 1024} KB.]`.trim();
}

export function writeRules(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function standingRules(): string {
  return readRules(rulesPath());
}

/** The registered repo `cwd` belongs to, or null for a directory outside every
 *  one of them. A linked worktree answers with the checkout it was cut from,
 *  which is the repository its sessions belong to. */
export function repoForCwd(cwd: string, repos: readonly Repo[] = listRepos()): Repo | null {
  const root = repoRootOf(cwd);
  if (!root) return null;
  for (const repo of repos) {
    const at = repoCheckoutPath(repo);
    if (at === root) return repo;
    try {
      if (realpathSync(at) === root) return repo;
    } catch {
      // a checkout that is gone cannot be the one the session runs in
    }
  }
  return null;
}

/** The repo's own rules for a session running in `cwd`, when it has any. */
export function repoRulesFor(cwd: string, repos: readonly Repo[] = listRepos()): { repo: Repo; path: string; text: string } | null {
  const repo = repoForCwd(cwd, repos);
  if (!repo) return null;
  const path = repoRulesPath(repo.id);
  const text = readRules(path);
  return text ? { repo, path, text } : null;
}
