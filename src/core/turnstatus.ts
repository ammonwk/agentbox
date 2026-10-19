/** The `STATUS:` line the fleet's rules have every turn end with: `done`,
 *  `waiting on …`, `needs Ammon — …`. Shared by the server (parking a session
 *  that ended done) and the web (a check mark on its row, and the line drawn
 *  as a quiet footer under the message rather than as prose). */

export type TurnStatusKind = "done" | "waiting" | "needs" | "other";

export interface TurnStatus {
  kind: TurnStatusKind;
  /** What follows `STATUS:`, markup around the line taken off. */
  text: string;
  /** The message without that line. */
  body: string;
}

/** The status the message's last non-empty line states, bold or code markup
 *  allowed around it; null when that line is not one. */
export function turnStatus(message: string | null | undefined): TurnStatus | null {
  const lines = (message ?? "").trimEnd().split("\n");
  const m = /^[*_`]*STATUS:[*_`]*\s*(.*?)[*_`]*$/i.exec(lines.at(-1)?.trim() ?? "");
  if (!m) return null;
  const text = m[1]!;
  const kind = /^done\b/i.test(text) ? "done" : /^waiting\b/i.test(text) ? "waiting" : /^needs\b/i.test(text) ? "needs" : "other";
  return { kind, text, body: lines.slice(0, -1).join("\n").trimEnd() };
}

/** Did this turn end `STATUS: done`? */
export const endedDone = (message: string | null | undefined): boolean => turnStatus(message)?.kind === "done";
