import type { Card } from "agentbox/client";

/** A decision kept for later comes back to the top this long before its default's time. */
export const LATER_RETURNS_MS = 2 * 60 * 60_000;

/** Oldest first, in every group: what has waited longest is met first. */
const oldest = (a: Card, b: Card): number => a.createdAt - b.createdAt || a.id - b.id;
const asks = (c: Card): boolean => c.kind === "decision";

/**
 * The order of the stack. What asks something of you and has not been put
 * off comes before everything that only reports, whatever its age: decisions
 * with a default and a time first, the soonest (or longest passed) on top,
 * then the other decisions, oldest first. Then what happened, oldest first.
 * Later means later: a decision kept for later goes under all of those, so
 * the reports beneath it can be reached, and is met again when the stack
 * comes round to it — or at the top once its default's time is within
 * `LATER_RETURNS_MS` or has passed. Last, the reports kept for later.
 */
export function stackOf(cards: readonly Card[], now: number = Date.now()): Card[] {
  const of = (asking: boolean, state: Card["state"]) => cards.filter((c) => asks(c) === asking && c.state === state);
  const due = (c: Card) => c.default !== null && c.defaultAt !== null;
  const pressing = (c: Card) => due(c) && c.defaultAt! - now <= LATER_RETURNS_MS;
  const open = [...of(true, "open"), ...of(true, "later").filter(pressing)];
  return [
    ...open.filter(due).sort((a, b) => a.defaultAt! - b.defaultAt!),
    ...open.filter((c) => !due(c)).sort(oldest),
    ...of(false, "open").sort(oldest),
    ...of(true, "later").filter((c) => !pressing(c)).sort(oldest),
    ...of(false, "later").sort(oldest),
  ];
}

/** The Later list, in the stack's order: what asks before what reports, each oldest first. */
export function laterOf(cards: readonly Card[]): Card[] {
  return cards.filter((c) => c.state === "later").sort((a, b) => Number(asks(b)) - Number(asks(a)) || oldest(a, b));
}
