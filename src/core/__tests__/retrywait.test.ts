import { describe, expect, test } from "bun:test";
import { statedWaitMs } from "../retrywait";

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

  test("is null when no wait is named", () => {
    expect(statedWaitMs("Something went wrong. Send a message to retry")).toBeNull();
    expect(statedWaitMs("Connection lost, retrying...")).toBeNull();
    expect(statedWaitMs("retry after 500ms")).toBeNull();
  });
});
