import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

/** agentbox home — everything lives here so it is trivially movable. */
export const AGENTBOX_HOME =
  process.env.AGENTBOX_HOME ?? join(homedir(), ".local", "share", "agentbox");

export const dataDir = join(AGENTBOX_HOME, "data");
export const worktreeRoot = join(AGENTBOX_HOME, "worktrees");
export const sessionDir = join(AGENTBOX_HOME, "sessions");
export const logDir = join(AGENTBOX_HOME, "logs");
export const repoRoot = join(AGENTBOX_HOME, "repos");
export const dbPath = join(AGENTBOX_HOME, "agentbox.db");
export const webDist = join(process.cwd(), "web", "dist");

export const DEFAULT_PORT = 4479;
export const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";

export function ensureDirs() {
  for (const d of [dataDir, worktreeRoot, sessionDir, logDir, repoRoot]) {
    mkdirSync(d, { recursive: true });
  }
}

export function worktreeFor(id: string): string {
  return join(worktreeRoot, id);
}

export function sessionDirFor(id: string): string {
  return join(sessionDir, id);
}

export function logPathFor(id: string): string {
  return join(logDir, `${id}.jsonl`);
}

export function exists(p: string): boolean {
  return existsSync(p);
}
