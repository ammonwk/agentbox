import { describe, expect, test } from "bun:test";
import { statedUntil, statedWaitMs } from "../retrywait";

const MIN = 60_000;

describe("statedWaitMs", () => {
  test("reads devin's free-model rate limit", () => {
    const msg = "Reached free model rate limit. Please switch to a different model. Your limit will reset in 1 hour 17 minutes.";
    expect(statedWaitMs(msg)).toBe(77 * MIN);
    expect(statedWaitMs("Your limit will reset in 1 hour 1 minute. (trace ID: eaf1)")).toBe(61 * MIN);
    expect(statedWaitMs("Your limit will reset in 55 minutes.")).toBe(55 * MIN);
  });

  test("reads it wrapped across screen lines, taking the last error shown", () => {
    const screen = [
      "  Reached free model rate limit. Please switch to a different model. Your limit will reset in 1 hour",
      "  7 minutes. (trace ID: 0f3af690dd431f275a0116633722a4a6). Send a message to retry",
      "> [agentbox: your turn stopped on an error; this message retries it.]",
      "  Reached free model rate limit. Please switch to a different model. Your limit will reset in 55",
      "  minutes. (trace ID: 07b9869481f542cd5864f18bb9d42b53). Send a message to retry",
    ].join("\n");
    expect(statedWaitMs(screen)).toBe(55 * MIN);
  });

  test("reads the other common phrasings", () => {
    expect(statedWaitMs("Rate limited. Try again in 30s")).toBe(30_000);
    expect(statedWaitMs("retry after 2 minutes")).toBe(2 * MIN);
    expect(statedWaitMs("resets in 2h 30m")).toBe(150 * MIN);
    expect(statedWaitMs("try again in 1 hour and 5 minutes")).toBe(65 * MIN);
  });

  test("reads a provider's retry header echoed into its 429", () => {
    // OpenCode Go's free model on 2026-10-21: hits hours apart, one reset at 18:00 MDT.
    const detail = (ms: number) =>
      `opencode-go/minimax-m3.1-flash-free: 429 Upstream request failed: Rate limit exceeded. Please try again later. retry-after-ms=${ms}`;
    expect(statedWaitMs(detail(8060000))).toBe(8_060_000);
    const reset = Date.parse("2026-10-22T00:00:00Z");
    expect(Math.abs(1792614630178 + statedWaitMs(detail(12570000))! - reset)).toBeLessThan(1_000);
    expect(Math.abs(1792626423168 + statedWaitMs(detail(777000))! - reset)).toBeLessThan(1_000);
    expect(statedWaitMs("429 Too Many Requests (retry-after: 300)")).toBe(300_000);
  });

  test("is null when no wait is named", () => {
    expect(statedWaitMs("Something went wrong. Send a message to retry")).toBeNull();
    expect(statedWaitMs("Connection lost, retrying...")).toBeNull();
    expect(statedWaitMs("retry after 500ms")).toBeNull();
  });
});

describe("statedUntil", () => {
  test("reads a date, or a bare time as the next one after the hit", () => {
    expect(statedUntil("You've hit your usage limit. Try again at Oct 14th, 2026 12:10 AM.", 0)).toBe(new Date(2026, 9, 14, 0, 10).getTime());
    const hit = new Date(2026, 9, 21, 15, 0).getTime();
    expect(statedUntil("Rate limit exceeded; resets at 6:00 PM", hit)).toBe(new Date(2026, 9, 21, 18, 0).getTime());
    expect(statedUntil("Rate limit exceeded; resets at 09:30", hit)).toBe(new Date(2026, 9, 22, 9, 30).getTime());
  });
});
