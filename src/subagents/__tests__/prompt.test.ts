import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SUBAGENT_PROMPT, readSubagentPrompt } from "../prompt";

/** Resolved from its own module's location, not the cwd, so a move that
 *  forgets to carry the file along fails here rather than at the first spawn. */
describe("the subagent contract", () => {
  test("is found, and says what the report is", () => {
    expect(existsSync(SUBAGENT_PROMPT)).toBe(true);
    const text = readSubagentPrompt();
    expect(text).toContain("Your final message is your entire return value");
    expect(text).toContain("Where you are");
  });
});
