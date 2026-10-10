import type { Card } from "../../../src/core/types";

/**
 * The order of the stack. What asks something of you comes before everything
 * that only reports, whatever its age: decisions with a default and a time
 * first, the soonest (or longest passed) on top, then the other decisions,
 * newest first, then the decisions you kept for later, longest kept first.
 * Under all of those, what happened: newest first, then the ones kept for later.
 */
export function stackOf(cards: readonly Card[]): Card[] {
  const newest = (a: Card, b: Card) => b.createdAt - a.createdAt;
  const kept = (a: Card, b: Card) => (a.laterAt ?? 0) - (b.laterAt ?? 0);
  const of = (asks: boolean, state: Card["state"]) => cards.filter((c) => (c.kind === "decision") === asks && c.state === state);
  const due = (c: Card) => c.default !== null && c.defaultAt !== null;
  const open = of(true, "open");
  return [
    ...open.filter(due).sort((a, b) => a.defaultAt! - b.defaultAt!),
    ...open.filter((c) => !due(c)).sort(newest),
    ...of(true, "later").sort(kept),
    ...of(false, "open").sort(newest),
    ...of(false, "later").sort(kept),
  ];
}
