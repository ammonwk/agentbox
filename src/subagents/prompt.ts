import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The subagent contract, beside this file and resolved from it rather than
 *  the cwd — the MCP server is started from wherever its client happens to be.
 *  Content, edited more often than code, so it is a file and not a literal. */
export const SUBAGENT_PROMPT = fileURLToPath(new URL("./prompt.md", import.meta.url));

/**
 * The contract handed to an MCP subagent: that its final message is its whole
 * return value, and that it is standing in the caller's real working tree.
 *
 * Deliberately throws. A missing file means a broken install, and the failure
 * mode of tolerating it is silent: the agent runs with no contract at all and
 * misbehaves in ways nobody traces back to here.
 */
export function readSubagentPrompt(): string {
  try {
    return readFileSync(SUBAGENT_PROMPT, "utf8").trim();
  } catch (err) {
    throw new Error(`agentbox subagent prompt missing: ${SUBAGENT_PROMPT} (${(err as Error).message})`);
  }
}
