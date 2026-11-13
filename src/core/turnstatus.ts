/** The `STATUS:` line the fleet's rules have every turn end with: `done`,
 *  `waiting on …`, `needs Ammon — …`. Shared by the server (parking a session
 *  that ended done, carding one that ended needing you) and the web (a check
 *  mark on its row, and the line drawn as a quiet footer under the message
 *  rather than as prose). */

/** How much of a session's last message its record keeps, and the longest status block kept whole. */
const TAIL = 300;
const LINE_MAX = 2000;

const STATUS_LINE = /^[*_`]*STATUS:[*_`]*\s*(.*?)[*_`]*$/i;

/** The index of the last line that is a `STATUS:` line, or -1. Not only the
 *  last line: a turn may follow its status with the list it asks about, and
 *  one read as having no status never becomes a card. */
function statusAt(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (STATUS_LINE.test(lines[i]!.trim())) return i;
  return -1;
}

/** What a session's record keeps of its last message: its end, and all of its
 *  status line and what follows it (else its last line). A `STATUS:` line the
 *  cut began before or inside would read as no status at all. */
export function messageTail(text: string): string {
  const t = text.trim();
  if (t.length <= TAIL) return t;
  const lines = t.split("\n");
  const at = statusAt(lines);
  const end = lines.slice(at < 0 ? -1 : at).join("\n");
  return end.length >= TAIL && end.length <= LINE_MAX ? end : `…${t.slice(1 - TAIL)}`;
}

type TurnStatusKind = "done" | "waiting" | "needs" | "other";

export interface TurnStatus {
  kind: TurnStatusKind;
  /** What follows `STATUS:`, markup around the line taken off. */
  text: string;
  /** The message without that line. */
  body: string;
}

/** The status the message's last `STATUS:` line states, bold or code markup
 *  allowed around it; null when it has none. */
export function turnStatus(message: string | null | undefined): TurnStatus | null {
  const lines = (message ?? "").trimEnd().split("\n");
  const at = statusAt(lines);
  if (at < 0) return null;
  const text = STATUS_LINE.exec(lines[at]!.trim())![1]!;
  const kind = /^done\b/i.test(text) ? "done" : /^waiting\b/i.test(text) ? "waiting" : /^needs\b/i.test(text) ? "needs" : "other";
  return { kind, text, body: [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n").trimEnd() };
}

/** Did this turn end `STATUS: done`? */
export const endedDone = (message: string | null | undefined): boolean => turnStatus(message)?.kind === "done";
