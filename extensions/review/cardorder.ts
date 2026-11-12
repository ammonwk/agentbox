import type { Card } from "agentbox/client";

/** What has waited longest is met first. */
const oldest = (a: Card, b: Card): number => a.createdAt - b.createdAt || a.id - b.id;
/** Each time a card is put off it goes behind those already put off. */
const longestKept = (a: Card, b: Card): number => a.laterAt! - b.laterAt! || oldest(a, b);
const asks = (c: Card): boolean => c.kind === "decision";
const due = (c: Card): boolean => c.default !== null && c.defaultAt !== null;

/**
 * The order of the stack. Every card you have never kept for later comes
 * before every card you have: first decisions with a default and a time, the
 * soonest (or longest passed) on top, then the other decisions, oldest first,
 * then what happened, oldest first. Then the kept ones, decisions before
 * reports, each new "later" behind the ones before it.
 */
export function stackOf(cards: readonly Card[]): Card[] {
  const live = cards.filter((c) => c.state === "open" || c.state === "later");
  const fresh = live.filter((c) => c.laterAt === null);
  const kept = live.filter((c) => c.laterAt !== null);
  return [
    ...fresh.filter((c) => asks(c) && due(c)).sort((a, b) => a.defaultAt! - b.defaultAt!),
    ...fresh.filter((c) => asks(c) && !due(c)).sort(oldest),
    ...fresh.filter((c) => !asks(c)).sort(oldest),
    ...kept.filter(asks).sort(longestKept),
    ...kept.filter((c) => !asks(c)).sort(longestKept),
  ];
}

/** The Later list, in the stack's order. */
export function laterOf(cards: readonly Card[]): Card[] {
  return stackOf(cards).filter((c) => c.state === "later");
}
