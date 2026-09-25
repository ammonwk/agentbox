import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { STEER_EXTENSION } from "../steer-link";
import { SUBAGENT_PROMPT, readSubagentPrompt } from "../prompt";

/** Both are resolved from their own module's location, not the cwd, so a
 *  move that forgets to carry the file along fails here rather than at the
 *  first spawn. */
describe("files resolved by path", () => {
  test("the subagent contract is found and says what the report is", () => {
    expect(existsSync(SUBAGENT_PROMPT)).toBe(true);
    const text = readSubagentPrompt();
    expect(text).toContain("Your final message is your entire return value");
    expect(text).toContain("Where you are");
  });

  test("the steer extension omp is handed exists", () => {
    expect(STEER_EXTENSION.endsWith("/src/omp/steer.ts")).toBe(true);
    expect(existsSync(STEER_EXTENSION)).toBe(true);
  });
});
