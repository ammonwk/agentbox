import { describe, expect, test } from "bun:test";
import { isProviderError } from "../host";

/**
 * The observed shapes, taken from real session logs — omp surfaces the raw
 * provider error as the turn's assistant message, and the turn then ends
 * `end_turn`, so this match is what tells an interrupted run from a finished
 * one.
 */
describe("isProviderError", () => {
  test("matches the provider errors seen in real transcripts", () => {
    expect(isProviderError("rate_limit_exceeded: Provider returned error")).toBe(true);
    expect(isProviderError("429 Provider returned error")).toBe(true);
    expect(isProviderError("429")).toBe(true);
    expect(isProviderError("rate limit exceeded")).toBe(true);
    expect(isProviderError("overloaded_error")).toBe(true);
    expect(isProviderError("503 Service Unavailable")).toBe(true);
    expect(isProviderError("quota exceeded")).toBe(true);
    expect(isProviderError("  Too many requests ")).toBe(true);
    expect(isProviderError("404 Not Found")).toBe(true);
  });

  test("matches a gateway idle timeout, alone and trailing a turn's prose", () => {
    // The web client sees the error as its own assistant event.
    expect(isProviderError("server_error: Upstream idle timeout exceeded")).toBe(true);
    // The host sees the turn's text tail, where omp has appended the failure
    // to what the agent already said — glued on with no separator. Verbatim
    // from a session that lost four turns this way.
    expect(isProviderError(
      "Dispatching now — one `task` per PR, 64 total. Shared method contract in " +
        "`context`; each task carries its PR number, branch, worktree path, and " +
        "observed symptoms.server_error: Upstream idle timeout exceeded",
    )).toBe(true);
  });

  test("matches a trailing error after prose longer than the standalone cap", () => {
    // The prose in front of a trailing error is unbounded, so the 300-char
    // cap that guards the standalone shapes must not apply to it.
    expect(isProviderError(
      "I walked every open PR and grouped them by whether the head commit is ".repeat(8) +
        "server_error: Upstream idle timeout exceeded",
    )).toBe(true);
  });

  test("does not match the agent actually speaking", () => {
    expect(isProviderError(null)).toBe(false);
    expect(isProviderError("")).toBe(false);
    expect(isProviderError("   \n  ")).toBe(false);
    expect(isProviderError("Done — opened PR #4185 and all checks are green.")).toBe(false);
    expect(isProviderError(
      "I fixed the flaky test; the suite passes 4290 assertions now.",
    )).toBe(false);
    // A long text merely mentioning a number or "rate" is prose, not an error.
    expect(isProviderError(
      "The rate limiter allows 429 requests per window; I verified the retry budget " +
        "and the backoff now covers the 5xx band the provider documents, then re-ran " +
        "the mirror tests and updated the client to surface the failure to the caller.",
    )).toBe(false);
    // Prose about an error is not the `<code>: <message>` shape: no colon.
    expect(isProviderError(
      "The stream ended with a server_error and I retried it once before giving up.",
    )).toBe(false);
  });
});
