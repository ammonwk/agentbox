/** Token → "cost-equivalent" dollars.
 *
 * Subscriptions do not bill per token, so these are not costs. They are a
 * common unit for splitting an account's observed usage increase across the
 * sessions that caused it: a session that read a million cached tokens on
 * Haiku did not use the same share as one that wrote a million output tokens
 * on Fable. Only the ratios matter, and only between sessions on one account,
 * so approximate prices are fine — but they are the published API prices
 * (per million tokens, first-party, as of 2026-06) rather than guesses.
 */

import type { TokenTotals } from "./types";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. */
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead = input * 0.1, cacheWrite = input * 1.25): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

/** Matched in order against a lower-cased model string; first hit wins. */
const TABLE: [RegExp, Price][] = [
  [/fable|mythos/, p(10, 50, 0.25)],
  [/opus-?5[-.]5|opus 5\.5/, p(4, 20, 0.2)],
  [/opus/, p(5, 25)],
  [/sonnet-?5|sonnet 5/, p(2, 10)],
  [/sonnet/, p(3, 15)],
  [/haiku/, p(1, 5)],
  // OpenAI's GPT-5 family, for codex. Same caveat: ratios within one account.
  [/gpt-5.*mini/, p(0.25, 2, 0.025, 0.25)],
  [/gpt|codex|o\d/, p(1.25, 10, 0.125, 1.25)],
];

/** Anything unrecognised (open models via omp, devin's own) weighs like a
 *  mid-tier model, so it still gets a share rather than none. */
const FALLBACK = p(1.25, 10, 0.125, 1.25);

export function priceOf(model: string | null | undefined): Price {
  const m = (model ?? "").toLowerCase();
  for (const [re, price] of TABLE) if (re.test(m)) return price;
  return FALLBACK;
}

/** Cost-equivalent of a batch of tokens on one model. */
export function costEquiv(
  model: string | null | undefined,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const price = priceOf(model);
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * price.cacheRead +
      t.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 };
}

/** Add one message's usage (on `model`) to running totals, in place. */
export function addUsage(
  totals: TokenTotals,
  model: string | null | undefined,
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  totals.input += u.input;
  totals.output += u.output;
  totals.cacheRead += u.cacheRead;
  totals.cacheWrite += u.cacheWrite;
  totals.costEquiv += costEquiv(model, u);
}
