/** An agent's loop runs at its times into whichever conversation is current,
 *  waits for a turn to end, and lets its check skip a time. */
import { expect, test } from "bun:test";
import { advance, loopText, makeLoop } from "./loop";

const NOW = new Date(2026, 9, 14, 16, 20).getTime();
const HOUR = 3_600_000;

test("a loop is a recurring rule with its next time; anything else is refused", () => {
  const loop = makeLoop({ when: "every hour", prompt: "Check the PRs." }, NOW);
  expect(loop.rule.kind).toBe("every");
  expect(loop.nextAt! - NOW).toBeGreaterThan(0);
  expect(loop.nextAt! - NOW).toBeLessThanOrEqual(HOUR);
  expect(() => makeLoop({ when: "in 4 hours", prompt: "x" }, NOW)).toThrow(/repeats at a time/);
  expect(() => makeLoop({ when: "every hour", prompt: "" }, NOW)).toThrow();
});

test("a time that comes is due until it runs, and missed times fold into it", () => {
  const loop = makeLoop({ when: "every hour", prompt: "p" }, NOW);
  expect(advance(loop, NOW)).toBe(loop);
  const first = advance(loop, loop.nextAt! + 1000);
  expect(first.due).toBe(loop.nextAt);
  expect(first.nextAt!).toBeGreaterThan(loop.nextAt! + 1000);
  const later = advance(first, first.nextAt! + 3 * HOUR);
  expect(later.due).toBe(loop.nextAt);
  expect(later.nextAt!).toBeGreaterThan(first.nextAt! + 3 * HOUR);
});

test("the agent is told the check's output before its prompt", () => {
  const loop = makeLoop({ when: "every hour", check: "gh pr list", prompt: "Hand ready PRs to Terminus." }, NOW);
  expect(loopText(loop, "#9220 ready\n")).toBe("Your loop (every hour). Its check said:\n\n#9220 ready\n\nHand ready PRs to Terminus.");
  expect(loopText(loop, "")).toBe("Your loop (every hour):\n\nHand ready PRs to Terminus.");
});
