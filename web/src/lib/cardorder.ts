import type { Card } from "../../../src/core/types";

/** A decision kept for later comes back to the top this long before its default's time. */
export const LATER_RETURNS_MS = 2 * 60 * 60_000;

/**
 * The order of the stack. What asks something of you and has not been put
 * off comes before everything that only reports, whatever its age: decisions
 * with a default and a time first, the soonest (or longest passed) on top,
 * then the other decisions, newest first. Then what happened, newest first.
 * Later means later: a decision kept for later goes under all of those, so
 * the reports beneath it can be reached, and is met again when the stack
 * comes round to it — or at the top once its default's time is within
 * `LATER_RETURNS_MS` or has passed. Last, the reports kept for later.
 */
export function stackOf(cards: readonly Card[], now: number = Date.now()): Card[] {
  const newest = (a: Card, b: Card) => b.createdAt - a.createdAt;
  const kept = (a: Card, b: Card) => (a.laterAt ?? 0) - (b.laterAt ?? 0);
  const of = (asks: boolean, state: Card["state"]) => cards.filter((c) => (c.kind === "decision") === asks && c.state === state);
  const due = (c: Card) => c.default !== null && c.defaultAt !== null;
  const pressing = (c: Card) => due(c) && c.defaultAt! - now <= LATER_RETURNS_MS;
  const open = [...of(true, "open"), ...of(true, "later").filter(pressing)];
  return [
    ...open.filter(due).sort((a, b) => a.defaultAt! - b.defaultAt!),
    ...open.filter((c) => !due(c)).sort(newest),
    ...of(false, "open").sort(newest),
    ...of(true, "later").filter((c) => !pressing(c)).sort(kept),
    ...of(false, "later").sort(kept),
  ];
}
