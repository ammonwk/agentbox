import type { Card } from "agentbox/client";

/** A decision kept for later comes back to the top this long before its default's time. */
export const LATER_RETURNS_MS = 2 * 60 * 60_000;

/** What has waited longest is met first. */
const oldest = (a: Card, b: Card): number => a.createdAt - b.createdAt || a.id - b.id;
/** Each time a card is put off it goes behind those already put off. */
const longestKept = (a: Card, b: Card): number => (a.laterAt ?? 0) - (b.laterAt ?? 0) || oldest(a, b);
const asks = (c: Card): boolean => c.kind === "decision";

/**
 * The order of the stack. Everything that asks something of you comes before
 * everything that only reports, whatever its age, even when you have put it
 * off: decisions with a default and a time first, the soonest (or longest
 * passed) on top, then the other decisions, oldest first, then the decisions
 * kept for later. Then what happened, oldest first, then the reports kept for
 * later. A decision kept for later comes back up among the first once its
 * default's time is within `LATER_RETURNS_MS` or has passed; kept again after
 * that, it stays with the kept.
 */
export function stackOf(cards: readonly Card[], now: number = Date.now()): Card[] {
  const of = (asking: boolean, state: Card["state"]) => cards.filter((c) => asks(c) === asking && c.state === state);
  const due = (c: Card) => c.default !== null && c.defaultAt !== null;
  const returnsAt = (c: Card) => c.defaultAt! - LATER_RETURNS_MS;
  const returned = (c: Card) => due(c) && returnsAt(c) <= now && (c.laterAt ?? 0) < returnsAt(c);
  const open = [...of(true, "open"), ...of(true, "later").filter(returned)];
  return [
    ...open.filter(due).sort((a, b) => a.defaultAt! - b.defaultAt!),
    ...open.filter((c) => !due(c)).sort(oldest),
    ...of(true, "later").filter((c) => !returned(c)).sort(longestKept),
    ...of(false, "open").sort(oldest),
    ...of(false, "later").sort(longestKept),
  ];
}

/** The Later list, in the stack's order. */
export function laterOf(cards: readonly Card[]): Card[] {
  return stackOf(cards).filter((c) => c.state === "later");
}
