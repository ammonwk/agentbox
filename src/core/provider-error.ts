/**
 * Does this text read as a provider error rather than the agent speaking?
 *
 * Shared between the host (which decides whether a cut-short turn gets an
 * automatic "Continue.") and the web client (which decides whether a prompt
 * gets a Retry button), so the two can never disagree about what failed.
 *
 * Two shapes, because the callers hand in two different things. The web client
 * passes a single assistant event, where the error is the whole string. The
 * host passes the turn's text tail, where omp has appended the raw failure to
 * whatever the agent had already said — a turn that narrated a plan for a
 * paragraph and then died reads as
 * `…and observed symptoms.server_error: Upstream idle timeout exceeded`.
 *
 * The original patterns were all `^`-anchored and capped at 300 characters,
 * which only ever matched the first shape. That is why a session could burn
 * seven hours on a gateway's 120-second upstream idle timeout while every
 * turn was recorded as a clean `end_turn`: no auto-continue, no Retry button,
 * no sign anything had gone wrong.
 */

/**
 * How much of the tail to scan for a trailing provider error. The prose in
 * front of it is unbounded, so the overall length cap cannot apply here.
 */
const TAIL_SCAN = 200;

/**
 * omp surfaces a provider failure as `<code>: <message>`, where the code is a
 * snake_case identifier — `server_error`, `rate_limit_exceeded`. Requiring the
 * colon and the suffix keeps prose that merely mentions an error out of the
 * match; allowing a bare `.` in front of it catches the code glued straight
 * onto the end of a sentence, which is how the host actually sees it.
 */
const TRAILING_CODE = /(?:^|[\s.!?)\]])[a-z][a-z0-9_]*_(?:error|exceeded)\s*:\s*\S[^\n]*$/i;

export function isProviderError(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (TRAILING_CODE.test(t.slice(-TAIL_SCAN))) return true;
  // The remaining shapes are the error standing alone as the whole message,
  // so a long text is the agent talking rather than a provider failing.
  if (t.length > 300) return false;
  return (
    /provider returned error/i.test(t) ||
    /^rate[ _-]?limit/i.test(t) ||
    /^(4\d\d|5\d\d)\b/.test(t) ||
    /\b(overloaded_error|quota (exceeded|exhausted)|too many requests)\b/i.test(t)
  );
}
