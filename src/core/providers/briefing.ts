import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../paths";

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
  "Hand work that ends in a pull request, or that waits on CI, to an agentbox session of its own rather than a subagent: start it from the directory it should work in with `agentbox claude --detach '<prompt>'`, which prints its id. It owns the work to the end and you need not wait on it. Keep subagents for work that comes back within minutes: analysis, exploration, reviews.",
].join("\n\n");

/** The user's standing rules, `<agentbox home>/rules.md`: theirs to write,
 *  never the repo's. */
export const rulesPath = (): string => join(agentboxHome(), "rules.md");

/** How much of the rules file is read: it is in every session's prompt, so a
 *  mistake (a log redirected into it, a pasted document) must not be. */
export const RULES_MAX_BYTES = 4096;

/** The rules file's text, cut at the last whole line inside the cap, with a
 *  line saying so when it was cut; "" when there is none. */
export function standingRules(): string {
  let raw: Buffer;
  try {
    raw = readFileSync(rulesPath());
  } catch {
    return "";
  }
  if (raw.length <= RULES_MAX_BYTES) return raw.toString("utf8").trim();
  const head = raw.subarray(0, RULES_MAX_BYTES).toString("utf8");
  const whole = head.slice(0, Math.max(head.lastIndexOf("\n"), 0)).trim();
  return `${whole}\n\n[The rest of this file was not read: it is over ${RULES_MAX_BYTES / 1024} KB.]`.trim();
}

/**
 * The briefing with the user's standing rules after it. Read each time a
 * session is launched or resumed, so an edit reaches the next one started
 * without a restart of the server — and, like any change here, spends the
 * prompt cache of each session resumed after it once.
 */
export function briefing(): string {
  const rules = standingRules();
  return rules ? `${BRIEFING}\n\nThe user's standing rules for every session (${rulesPath()}):\n\n${rules}` : BRIEFING;
}
