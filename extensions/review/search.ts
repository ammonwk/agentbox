import type { Card } from "agentbox/client";

/** A card the search found: whether its title holds every word, and where in the rest a word was found. */
export type Hit = { card: Card; inTitle: boolean; snippet: string | null };

/** Markdown as it reads: link text without its URL, no emphasis or code marks, one line. */
export function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a query, lowercased; empty when there is nothing to search for. */
export function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Everything on a card besides its title that a search reads. */
function bodyOf(c: Card, from: string | undefined): string[] {
  return [c.short, ...c.options, c.recommend ?? "", c.default ?? "", c.answer ?? "", c.closedWhy ?? "", from ?? "", c.pr ?? ""].map(plain).filter(Boolean);
}

/** Some of `text` around the first of `terms` in it, cut at word ends. */
function around(text: string, terms: string[]): string {
  const low = text.toLowerCase();
  const at = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(at) || at < 40) return text;
  const start = text.lastIndexOf(" ", at - 30);
  return `…${text.slice(start < 0 ? 0 : start + 1)}`;
}

/**
 * The cards with every word of the query somewhere in them, those whose
 * title has them all first, each group in the order it came in. A number
 * (or #number) is also a card's id, and that card comes first.
 */
export function search(cards: readonly Card[], query: string, from: (c: Card) => string | undefined): Hit[] {
  const terms = termsOf(query);
  if (!terms.length) return cards.map((card) => ({ card, inTitle: false, snippet: null }));
  const id = /^#?(\d+)$/.exec(query.trim())?.[1];
  const byId: Hit[] = [];
  const titled: Hit[] = [];
  const bodied: Hit[] = [];
  for (const card of cards) {
    if (id && card.id === Number(id)) {
      byId.push({ card, inTitle: false, snippet: null });
      continue;
    }
    const title = plain(card.title).toLowerCase();
    const body = bodyOf(card, from(card));
    const lowBody = body.map((b) => b.toLowerCase());
    if (terms.every((t) => title.includes(t))) {
      titled.push({ card, inTitle: true, snippet: null });
      continue;
    }
    if (!terms.every((t) => title.includes(t) || lowBody.some((b) => b.includes(t)))) continue;
    // The part that holds the most of the words the title lacks.
    const missing = terms.filter((t) => !title.includes(t));
    const best = body.reduce((a, b, i) => (missing.filter((t) => lowBody[i]!.includes(t)).length > missing.filter((t) => a.toLowerCase().includes(t)).length ? b : a), "");
    bodied.push({ card, inTitle: false, snippet: around(best, missing) });
  }
  return [...byId, ...titled, ...bodied];
}

/** `text` cut into runs, those that are one of `terms` marked. */
export function marked(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (!terms.length) return [{ text, hit: false }];
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text
    .split(re)
    .filter(Boolean)
    .map((part) => ({ text: part, hit: terms.includes(part.toLowerCase()) }));
}
