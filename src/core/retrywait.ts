/**
 * How long an error says to wait before trying again, when it says.
 *
 * A rate limit that names its reset ("Your limit will reset in 1 hour 17
 * minutes") is not worth retrying before then: every early retry is refused
 * the same way, and some CLIs (devin) spend a round of their own retries on
 * each one first. The fleet reads the wait off the error and nudges once it
 * has passed, rather than on its usual few-minute pace.
 */

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

const AMOUNT = String.raw`\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;
const WAIT = new RegExp(
  String.raw`\b(?:resets?|try again|retry|available again|wait)\s+(?:in|after|for)\s+((?:${AMOUNT}[\s,]*(?:and\s+)?)+)`,
  "gi",
);

/** The wait an error names, in ms — "reset in 1 hour 17 minutes", "try again
 *  in 30s", "retry after 2 minutes" — or null when it names none. With
 *  several, the last. */
export function statedWaitMs(text: string): number | null {
  // The last one: a screen can still show an earlier error above it.
  const m = [...text.replace(/\s+/g, " ").matchAll(WAIT)].at(-1);
  if (!m) return null;
  let ms = 0;
  for (const part of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    ms += Number(part[1]) * (UNIT_MS[part[2]![0]!.toLowerCase()] ?? 0);
  }
  return ms > 0 ? ms : null;
}

const AT = /\b(?:try again|resets?|available again|retry)\s+(?:at|on)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}(?::\d{2})? ?(?:[AP]M)?)/gi;

/** The moment an error says to come back at, when it names a date rather
 *  than a wait — codex's "try again at Oct 14th, 2026 12:10 AM", in the
 *  machine's time — or null. With several, the last. */
export function statedUntil(text: string): number | null {
  const m = [...text.replace(/\s+/g, " ").matchAll(AT)].at(-1);
  if (!m) return null;
  const at = Date.parse(m[1]!.replace(/(\d)(?:st|nd|rd|th)/, "$1").replace(/,/g, ""));
  return Number.isFinite(at) ? at : null;
}
