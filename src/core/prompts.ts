/** Prompt composition for omp sessions.
 *
 * omp has no idea it is inside agentbox: it sees a git worktree and a task.
 * Everything an agent needs to know about the harness — that a human is
 * watching and can interrupt, that the worktree is disposable, that "done"
 * means an open PR — has to be handed to it here, because nothing else can
 * supply it.
 *
 * The text itself lives in `prompts/*.md` and is read at composition time.
 * It is content, edited far more often than this file is, and inlining it as
 * string literals would make every wording change a code change.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDirFor } from "./paths";
import type { AgentSettings, Repo, Session } from "./types";

/** `prompts/` at the repo root, resolved from this module rather than cwd —
 *  the server is started from wherever the user happens to be. */
const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/**
 * The advisor config omp discovers by walking up from cwd.
 *
 * **omp v17.2.11 reads BOTH `WATCHDOG.md` and `WATCHDOG.yml`, through two
 * separate loaders. Do not "clean up" this `.yml` on the grounds that the docs
 * mention `.md`.** Both feed the advisor, by different keys:
 *
 *   - `WATCHDOG.md`  → `discoverWatchdogFiles`, wrapped in
 *     `Especially pay attention to: <attention>…</attention>` and passed as
 *     `advisorWatchdogPrompt`. Free-form prose; no schema.
 *   - `WATCHDOG.yml` → `discoverAdvisorConfigs`, parsed as a YAML mapping
 *     against `{instructions?: string, advisors?: array}` and passed as
 *     `advisorSharedInstructions` + `advisorConfigs`.
 *
 * We write the `.yml`, and the reason is evidence rather than preference: its
 * schema check gives a **positive control**. A malformed file logs
 * `Advisor config: invalid schema … instructions must be a string`, so silence
 * on a well-formed one is real proof it was read. The `.md` path validates
 * nothing, so on a machine where the advisor cannot run there is no way to tell
 * "discovered" from "ignored" — and this machine is one of those (no model on
 * the `advisor` role; `--advisor` 401s). Switching to the unverifiable channel
 * to match a doc would trade proof for tidiness.
 *
 * The walk checks `<dir>/WATCHDOG.yml` and `<dir>/.omp/WATCHDOG.yml` at each
 * level and **stops at the git root**, so there is no directory above the
 * worktree that would work — the file genuinely has to go inside it, which is
 * why the exclude below is load-bearing rather than tidiness.
 */
const WATCHDOG_FILE = "WATCHDOG.yml";

/** Where a repo keeps instructions omp would normally discover by itself. */
const REPO_APPEND_SYSTEM = join(".omp", "APPEND_SYSTEM.md");

/**
 * Read one prompt fragment.
 *
 * Deliberately throws. A missing fragment means a broken install, and the
 * failure mode of tolerating it is silent: the session runs with no harness
 * contract at all and misbehaves in ways nobody traces back to here.
 */
function readPrompt(name: string): string {
  const path = join(PROMPTS_DIR, name);
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(
      `agentbox prompt fragment missing: ${path} (${(err as Error).message})`,
    );
  }
}

/** The judge's instructions, with its `{{task}}`/`{{trigger}}`/`{{evidence}}`
 *  placeholders intact — supervisor.ts fills those from live session state. */
export function readJudgePrompt(): string {
  return readPrompt("judge.md");
}

/** `{{key}}` substitution. Unknown placeholders are left alone so a typo in a
 *  prompt file is visible in the output rather than silently blank. */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key]! : whole,
  );
}

/** Read a file, or null when it is absent or unreadable. Used only for
 *  optional overlays, where "not there" and "not readable" both mean the same
 *  thing to the caller: there is nothing to concatenate. */
function readOptional(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Directories that might hold the repo's own `.omp/APPEND_SYSTEM.md`.
 *
 * The worktree is the honest answer, but it may not exist yet at spawn time,
 * and a bare-clone-backed repo keeps its checkout elsewhere; fall back to the
 * registered ref when it is a local path.
 */
function repoRootsFor(session: Session, repo: Repo): string[] {
  const roots: string[] = [];
  if (session.worktree) roots.push(session.worktree);
  if (repo.kind === "local" && isAbsolute(repo.ref)) roots.push(repo.ref);
  return roots;
}

function repoAppendSystem(session: Session, repo: Repo): string | null {
  for (const root of repoRootsFor(session, repo)) {
    const text = readOptional(join(root, REPO_APPEND_SYSTEM));
    if (text) return text;
  }
  return null;
}

/** True once the session has been through a turn already — spawned-fresh and
 *  resumed-after-a-halt read very differently to the agent. */
function isResumed(session: Session): boolean {
  return (
    session.status === "flagged" ||
    session.status === "dead" ||
    session.flagReason !== null ||
    session.toolCalls > 0
  );
}

/**
 * Compose the append-system-prompt file for a session and return its absolute
 * path.
 *
 * Two constraints from omp's flag handling, both load-bearing:
 *  - The value must be an absolute path with no newline in it. omp treats a
 *    value containing a newline as literal prompt text, and if it treats the
 *    value as a path and the read *fails*, it silently uses the string itself
 *    as the system prompt. A bad path is therefore not an error — it is a
 *    one-line system prompt. Hence the existence assertion at the end.
 *  - The file must live under AGENTBOX_HOME. A prompt written into the
 *    worktree shows up in the diff and then in the pull request.
 */
export function writeSessionPrompt(
  session: Session,
  repo: Repo,
  settings: AgentSettings,
): string {
  const layers: string[] = [readPrompt("harness.md")];

  const vars = {
    branch: session.branch,
    repo: repo.displayName || repo.ref,
    flagReason:
      session.flagReason ?? "no reason recorded — treat it as unexplained",
  };
  layers.push(
    render(readPrompt(isResumed(session) ? "role-resumed.md" : "role-fresh.md"), vars),
  );

  const overlay = settings.systemPrompt.trim();
  if (overlay) layers.push(`## From this agentbox install\n\n${overlay}`);

  // omp stops discovering .omp/APPEND_SYSTEM.md the moment we pass
  // --append-system-prompt ourselves, so not concatenating it here would
  // silently delete the repo's own instructions.
  const repoOwn = repoAppendSystem(session, repo);
  if (repoOwn) layers.push(`## From this repository (.omp/APPEND_SYSTEM.md)\n\n${repoOwn}`);

  const dir = sessionDirFor(session.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "append-system.md");
  writeFileSync(path, `${layers.join("\n\n---\n\n")}\n`, "utf8");

  if (!existsSync(path)) {
    throw new Error(`agentbox could not write the system prompt to ${path}`);
  }
  return path;
}

/**
 * Where git wants per-checkout excludes for this worktree.
 *
 * A linked worktree's `.git` is a file, not a directory, so
 * `<worktree>/.git/info/exclude` does not exist; git itself is the only thing
 * that reliably knows the answer.
 */
function excludePathFor(worktree: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? resolve(worktree, out) : null;
  } catch {
    // Not a git worktree yet, or no git on PATH. Handled by the caller, which
    // refuses to write WATCHDOG.md at all rather than risk it reaching a diff.
    return null;
  }
}

function ensureExcluded(excludePath: string, pattern: string): boolean {
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = readOptional(excludePath) ?? "";
    if (existing.split("\n").some((line) => line.trim() === pattern)) return true;
    appendFileSync(excludePath, `${existing ? "\n" : ""}${pattern}\n`, "utf8");
    return true;
  } catch {
    // Same as above: if we cannot guarantee the exclude, we do not write the
    // file, so a failure here is not silent — it suppresses the feature.
    return false;
  }
}

/** Embed arbitrary text as a YAML block scalar. `|-` keeps the line breaks and
 *  strips the trailing newline; every line is indented, so nothing in the text
 *  can be read as YAML structure. */
function yamlBlock(key: string, text: string, indent = "  "): string {
  const body = text
    .trimEnd()
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : ""))
    .join("\n");
  return `${key}: |-\n${body}\n`;
}

/**
 * Write the advisor's `WATCHDOG.yml` into the worktree when the advisor is on.
 *
 * This is the one prompt that cannot live under AGENTBOX_HOME — see the note on
 * WATCHDOG_FILE for why no directory above the worktree is discoverable. The
 * exclude entry therefore goes in *before* the file, so there is no window in
 * which it could be committed, and the file is not written at all if the
 * exclude could not be established.
 *
 * Only the top-level `instructions` key is emitted. That is omp's "shared
 * instructions", applied to whichever advisor `--advisor` activates off the
 * `advisor` role; declaring an `advisors:` entry as well would risk running two
 * reviewers over every turn and paying for both.
 */
export function writeWatchdog(session: Session, settings: AgentSettings): void {
  if (!settings.advisor.enabled) return;
  const worktree = session.worktree;
  if (!worktree || !existsSync(worktree)) return;

  const excludePath = excludePathFor(worktree);
  if (!excludePath || !ensureExcluded(excludePath, `/${WATCHDOG_FILE}`)) {
    throw new Error(
      `agentbox refused to write ${WATCHDOG_FILE} into ${worktree}: could not add it to git's exclude list, and an un-excluded file would land in the PR`,
    );
  }

  writeFileSync(
    join(worktree, WATCHDOG_FILE),
    yamlBlock("instructions", readPrompt("watchdog.md")),
    "utf8",
  );
}

/**
 * Frame a supervisor nudge so the agent can weigh it correctly.
 *
 * Without the frame it is indistinguishable from the human typing into the
 * board, and the agent will abandon correct work on the say-so of a model that
 * has seen forty tool calls and none of its reasoning.
 */
export function frameSupervisorMessage(nudge: string): string {
  return render(readPrompt("supervisor-nudge.md"), { nudge: nudge.trim() });
}
