import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { repoCheckoutPath } from "./git";
import { logDir } from "./paths";
import type { Repo, RepoSetup } from "./types";

/**
 * Setting up a worktree agentbox just cut, per the repo's `RepoSetup`.
 *
 * The copy happens first and in line: it is a handful of `.env`-sized files,
 * and an agent that starts before them runs against no configuration at all.
 * The command (an install, a build) is the slow part, so it runs alongside the
 * agent rather than ahead of it, in a scope of its own so that restarting the
 * server does not kill it half way through `node_modules`. Its output goes to
 * a log whose last line says it is done — the agent is told where.
 */

/** The last line of a finished setup log. */
export const SETUP_DONE = "agentbox: setup exited";

export const setupLog = (sessionId: string): string => join(logDir(), "setup", `${sessionId}.log`);

/** A path to copy, as the repo root sees it: relative, and staying inside. */
function copyPath(raw: string): string | null {
  const p = normalize(raw.trim()).replace(/\/+$/, "");
  if (!p || p === "." || isAbsolute(p) || p === ".." || p.startsWith("../") || p === ".git" || p.startsWith(".git/")) return null;
  return p;
}

/** Check a `RepoSetup` from a request, or say what is wrong with it. */
export function parseSetup(v: unknown): RepoSetup {
  const b = (v ?? {}) as { copy?: unknown; run?: unknown };
  if (!Array.isArray(b.copy) || !b.copy.every((c) => typeof c === "string")) {
    throw new Error("setup.copy must be a list of paths");
  }
  if (typeof b.run !== "string") throw new Error("setup.run must be a string");
  const copy: string[] = [];
  for (const raw of b.copy as string[]) {
    if (!raw.trim()) continue;
    const p = copyPath(raw);
    if (!p) throw new Error(`"${raw}" is not a path inside the repo`);
    if (!copy.includes(p)) copy.push(p);
  }
  return { copy, run: b.run.trim() };
}

/**
 * Give a new worktree what the repo's setup says. Returns the log the command
 * writes to, or null when there is no command. Never throws: a worktree that
 * could not be set up is still a worktree, and the agent can finish the job.
 */
export function setUpWorktree(repo: Repo, worktree: string, sessionId: string): string | null {
  const { copy, run } = repo.setup;
  if (copy.length === 0 && !run) return null;
  const source = repoCheckoutPath(repo);
  const lines: string[] = [];
  for (const rel of copy) {
    const p = copyPath(rel);
    if (!p) continue;
    const from = join(source, p);
    const to = join(worktree, p);
    // Never over what git checked out: the branch's own file is the right one.
    if (!existsSync(from)) lines.push(`not copied, not in ${source}: ${p}`);
    else if (existsSync(to)) lines.push(`not copied, already there: ${p}`);
    else {
      try {
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
        lines.push(`copied ${p}`);
      } catch (e) {
        lines.push(`not copied, ${(e as Error).message}: ${p}`);
      }
    }
  }
  if (!run) return null;

  const log = setupLog(sessionId);
  try {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, [...lines, `$ ${run}`, ""].join("\n"));
    // $1 is the command, $2 the log: nothing the user typed is quoted into a script.
    const script = `sh -c "$1" </dev/null >>"$2" 2>&1; echo "${SETUP_DONE} $?" >>"$2"`;
    const argv = ["sh", "-c", script, "agentbox-setup", run, log];
    const scoped = Bun.which("systemd-run")
      ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", `--unit=agentbox-setup-${sessionId}`, ...argv]
      : argv;
    Bun.spawn(scoped, { cwd: worktree, stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch (e) {
    try {
      writeFileSync(log, [...lines, `$ ${run}`, `could not start: ${(e as Error).message}`, `${SETUP_DONE} 127`, ""].join("\n"));
    } catch {
      /* no log either; the agent is told where to look and finds nothing */
    }
  }
  return log;
}

/** What the agent is told when setup is still running as it starts. */
export function setupNote(run: string, log: string): string {
  return (
    `\n\n---\nagentbox is setting up this worktree alongside you: \`${run}\`, logging to ${log}. ` +
    `It is done when the log's last line reads "${SETUP_DONE} <code>" ` +
    `(\`until grep -q '^${SETUP_DONE}' ${log}; do sleep 5; done\`). ` +
    `Wait for that before running anything that needs it, and don't start a second install of your own.`
  );
}
