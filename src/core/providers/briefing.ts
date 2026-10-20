import { repoRulesFor, rulesPath, standingRules } from "../rules";

/**
 * What an agent agentbox launches is told about where it runs, appended to its
 * system prompt: claude and omp by `--append-system-prompt`, codex by
 * `developer_instructions`. Devin has no such flag and is not told.
 *
 * Only what an agent could not guess and would use unprompted belongs here.
 * Every word is in every session's context, and a change to it is a change to
 * the system prompt of every session resumed after, whose prompt cache it
 * spends once.
 *
 * It holds a newline on purpose: omp reads a one-line value as a file path.
 */
const BRIEFING = [
  "You are running in agentbox, whose web UI shows the user your replies as Markdown and displays images in them.",
  "To show the user an image (a screenshot of UI you built or checked, a chart, a diagram, a rendered page), save it as a png, jpeg, gif or webp file and put `![what it shows](/absolute/path.png)` in your reply. Use a new file name for each image: the reply shows whatever the file holds when it is looked at. Do this whenever seeing it would tell the user more than your description of it would.",
  "Sessions and pull requests go one to one. The work you were asked for, you land yourself, through its CI and review: you hold its context, and it is here the user follows it. Work that would be a pull request of its own (something separate that came up, or one of several in a fan-out) goes to a new agentbox session rather than a subagent, since a subagent can only wait on CI by holding your turn open: start it from the directory it should work in with `agentbox claude --detach '<prompt>'`, which prints its id; it owns that PR to the end and you need not wait on it. Keep subagents for work that comes back within minutes and whose result you can act on without opening what it read: a review, a test or log run reduced to its failures, a verdict per independent unit. A question, a diagnosis or a search for patterns you read for yourself, since no summary carries what only one reader holding all of it sees.",
  "To wait on anything outside your own turn (a pull request's checks or its merge, a GitHub Actions run, another session, a condition, a length of time), arm `agentbox wait …` and end your turn or carry on; `agentbox wait` alone lists the forms. You are told here the moment it happens, can no longer happen, cannot be watched any longer, or times out, each saying which, also when this session was parked meanwhile. Start a command that runs longer than a few minutes with `agentbox wait job -- <command>`. A background command, loop, sleep or watcher of your own stops with your process and can end without saying anything, so never wait with one.",
  "Search only the tree that can hold the answer. Never `grep -r` or `find` in `$HOME`, `/`, `/tmp`, `~/.local/share/agentbox`, or `~/Documents`: those are hundreds of GB and millions of files, so a search there runs for minutes on one core. In a repo use `rg` with `-g '!node_modules'`; for a filename, `find` with `-maxdepth`; for conversations, `agentbox grep --all`. `| head` does not stop a search — bound it with `-m1` or a smaller root. Put `</dev/null` on a search whose file list may be empty: `grep` with no files reads stdin and waits forever.",
].join("\n\n");

/** The exact text a session is given, for the Context page: briefing only. */
export const briefingText = (): string => BRIEFING;

/**
 * The briefing with the user's standing rules after it, and then the rules of
 * the repo the session runs in, when it runs in one. Read each time a session
 * is launched or resumed, so an edit reaches the next one started without a
 * restart of the server; `cwd` is what picks the repo (`core/rules.ts`).
 */
export function briefing(cwd?: string): string {
  const parts = [BRIEFING];
  const rules = standingRules();
  if (rules) parts.push(`The user's standing rules for every session (${rulesPath()}):\n\n${rules}`);
  const repo = cwd ? repoRulesFor(cwd) : null;
  if (repo) parts.push(`The user's standing rules for the ${repo.repo.displayName} repo (${repo.path}):\n\n${repo.text}`);
  return parts.join("\n\n");
}
