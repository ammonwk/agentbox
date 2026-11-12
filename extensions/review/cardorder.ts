import type { Card } from "agentbox/client";

/** What has waited longest is met first. */
const oldest = (a: Card, b: Card): number => a.createdAt - b.createdAt || a.id - b.id;
/** Each time a card is put off it goes behind those already put off. */
const longestKept = (a: Card, b: Card): number => a.laterAt! - b.laterAt! || oldest(a, b);
const asks = (c: Card): boolean => c.kind === "decision";
const due = (c: Card): boolean => c.default !== null && c.defaultAt !== null;

/**
 * The order of the stack. Everything that asks something of you comes before
 * everything that only reports, and within each, every card you have never
 * kept for later comes before every card you have. So: decisions with a
 * default and a time, the soonest (or longest passed) on top, then the other
 * decisions, oldest first, then the decisions kept for later; then what
 * happened, oldest first, then the reports kept for later. Each new "later"
 * goes behind the ones before it.
 */
export function stackOf(cards: readonly Card[]): Card[] {
  const live = cards.filter((c) => c.state === "open" || c.state === "later");
  const fresh = live.filter((c) => c.laterAt === null);
  const kept = live.filter((c) => c.laterAt !== null).sort(longestKept);
  return [
    ...fresh.filter((c) => asks(c) && due(c)).sort((a, b) => a.defaultAt! - b.defaultAt!),
    ...fresh.filter((c) => asks(c) && !due(c)).sort(oldest),
    ...kept.filter(asks),
    ...fresh.filter((c) => !asks(c)).sort(oldest),
    ...kept.filter((c) => !asks(c)),
  ];
}

/** The Later list, in the stack's order. */
export function laterOf(cards: readonly Card[]): Card[] {
  return stackOf(cards).filter((c) => c.state === "later");
}
