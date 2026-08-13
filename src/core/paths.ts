import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

/**
 * Every path derived from `AGENTBOX_HOME` is resolved at CALL time, not at
 * import time.
 *
 * These used to be `export const`, which read `process.env` once when the
 * module was first imported. Import order then decided where the app wrote: a
 * test setting `AGENTBOX_HOME` — in `beforeAll` or even at its own module scope
 * — was already too late if any earlier file had pulled paths.ts in, and the
 * override silently did nothing. The suite wrote sessions and worktrees into
 * the developer's live `~/.local/share/agentbox` while passing.
 *
 * Reading the env on each call is a string join. It is not worth caching, and a
 * cache would reintroduce exactly the staleness this removes.
 */
export function agentboxHome(): string {
  return process.env.AGENTBOX_HOME ?? join(homedir(), ".local", "share", "agentbox");
}

const dataDir = (): string => join(agentboxHome(), "data");
const logDir = (): string => join(agentboxHome(), "logs");

export const worktreeRoot = (): string => join(agentboxHome(), "worktrees");
export const sessionDir = (): string => join(agentboxHome(), "sessions");
export const repoRoot = (): string => join(agentboxHome(), "repos");
export const dbPath = (): string => join(agentboxHome(), "agentbox.db");

/**
 * The installed package's own root, resolved from this module's location
 * (`<root>/src/core/paths.ts`).
 *
 * `process.cwd()` is not an anchor here: `bin/agentbox` is on PATH and can be
 * run from anywhere, and the previous `join(process.cwd(), "web", "dist")` meant
 * the built UI was only ever found when the server happened to be started from
 * the repo root. This one is not env-derived, so it stays a constant.
 */
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const webDist = join(packageRoot, "web", "dist");

export const DEFAULT_PORT = 4479;
export const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";

export function ensureDirs() {
  for (const d of [dataDir(), worktreeRoot(), sessionDir(), logDir(), repoRoot()]) {
    mkdirSync(d, { recursive: true });
  }
}

export function sessionDirFor(id: string): string {
  return join(sessionDir(), id);
}

export function logPathFor(id: string): string {
  return join(logDir(), `${id}.jsonl`);
}
