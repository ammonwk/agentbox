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

/** `server.log`, when the server is started as AGENTS.md says. */
const logDir = (): string => join(agentboxHome(), "logs");

export const worktreeRoot = (): string => join(agentboxHome(), "worktrees");
export const repoRoot = (): string => join(agentboxHome(), "repos");
/** v2's database. v1's `agentbox.db` is left where it is, untouched. */
export const dbPath = (): string => join(agentboxHome(), "box.db");

/** Credential homes for every non-default account, one directory each. */
export const accountsRoot = (): string => join(agentboxHome(), "accounts");
export const accountHomeFor = (id: string): string => join(accountsRoot(), id);

/** The tmux server agentbox runs every session in: `tmux -L <socket>`. Its
 *  own socket, so your personal tmux sessions and ours never mix. */
export const tmuxSocket = (): string => process.env.AGENTBOX_TMUX_SOCKET ?? "agentbox";

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

export function ensureDirs() {
  for (const d of [worktreeRoot(), logDir(), repoRoot(), accountsRoot()]) {
    mkdirSync(d, { recursive: true });
  }
}

/**
 * The `agentbox` entry point, resolved from this file rather than from the
 * cwd or PATH, so it is the binary of the build that is running.
 */
export function agentboxBin(): string {
  return join(packageRoot, "bin", "agentbox");
}
