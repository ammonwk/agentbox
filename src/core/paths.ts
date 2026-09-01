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

/** Scratch for MCP subagents: one directory per agent, holding the system
 *  prompt file omp is launched with and that agent's transcript. Separate from
 *  `sessions/` because a subagent is not a board session and must never appear
 *  as one. */
export const subagentRoot = (): string => join(agentboxHome(), "subagents");

/**
 * Pre-rendered status lines for calls that are still in flight, one file per
 * blocked tool call, deleted when it answers.
 *
 * A file rather than a socket or a query against the running server, because
 * the only consumer that matters is a shell script re-run every few seconds by
 * a terminal, and it must cost approximately nothing. Reading a file is a bash
 * builtin; anything else is a fork.
 */
export const liveRoot = (): string => join(agentboxHome(), "live");

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

export function subagentDirFor(id: string): string {
  return join(subagentRoot(), id);
}

export function logPathFor(id: string): string {
  return join(logDir(), `${id}.jsonl`);
}

/**
 * Where a session host's stdout and stderr go.
 *
 * Separate from the transcript: this is the host process's own output — a
 * stack trace from a failed launch, omp's stderr — and it is the only place
 * that survives to explain a host that died before it could write an event.
 */
export function hostLogPathFor(id: string): string {
  return join(logDir(), `host-${id}.log`);
}

/**
 * The `agentbox` entry point, resolved from this file rather than from the
 * cwd or PATH. The server spawns it to start hosts, and it has to be the
 * binary of the build that is running, not whichever one a shell would find.
 */
export function agentboxBin(): string {
  return join(packageRoot, "bin", "agentbox");
}
