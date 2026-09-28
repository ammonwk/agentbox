/** The claim a session makes on its account, from the model it will run.
 *
 * A claim is the weekly points a session is assumed to use until it has
 * actually used them (see claims.ts). One number cannot fit every model: a
 * Devin afternoon on GLM-5.3-Flash barely dents an account that a day of
 * Fable burns a twelfth of. The table below scales the claim by model family
 * and reasoning effort, so the balancer counts a flash-tier session as the
 * rounding error it is and keeps the heavy models off a crowded account.
 *
 * The anchors are burn ratios, not API prices — subscriptions do not bill per
 * token — but they follow the published prices where those are known (Fable
 * 2.5× Opus 5.5, Opus 1.5× Sonnet 5, Astra 2.5× Sol, Sol 2.5× Luna, per
 * models.dev) and the user's sense of the rest: a GLM-5.3-Flash session is
 * worth about a seventh of a Fable one. Effort multiplies: low half, high the
 * baseline, max double. Pure — the balancer imports this, so it touches no
 * I/O and reads nothing but its arguments.
 */

import type { BalancerSettings } from "./types";

/** Weekly points a session on each model family claims, at the CLI's default
 *  effort. Matched in order against the lower-cased model string; first hit
 *  wins. */
const TABLE: [RegExp, number][] = [
  [/fable|mythos/, 6],
  [/astra/, 5],
  [/opus/, 2.4],
  [/(^|[^a-z])sol([^a-z]|$)/, 2],
  [/sonnet/, 1.6],
  [/(^|[^a-z])luna([^a-z]|$)/, 0.8],
  [/haiku/, 0.8],
  [/flash/, 0.8],
  [/glm|deepseek/, 1.6],
];

/** Reasoning effort as a share of the default burn: low half, high the
 *  baseline, max double. Levels between the named ones interpolate; nothing
 *  weighs more than max. Devin bakes the level into the model id
 *  (`-low` … `-max`), so the suffix stands in for the effort there. */
const EFFORT: Record<string, number> = {
  low: 0.5,
  medium: 1,
  high: 1,
  xhigh: 1.5,
  max: 2,
  ultra: 2,
};

const EFFORT_SUFFIX = /-(low|medium|xhigh|high|max|ultra)$/;

/**
 * The claim for a session on `model` at `effort`: the family's points, times
 * effort, times the Big ratio (`claimBig` over `claimNormal`) when it is
 * started as a Big session. Anything the table does not know claims
 * `claimNormal`, which is what calibration measures — an unknown model costs
 * what sessions have always cost until it says otherwise.
 */
export function claimFor(
  opts: { model?: string | null; effort?: string | null; big?: boolean },
  settings: BalancerSettings,
): number {
  let model = (opts.model ?? "").toLowerCase();
  let effort = opts.effort ?? null;
  const suffix = EFFORT_SUFFIX.exec(model);
  if (suffix) {
    model = model.slice(0, model.length - suffix[0].length);
    effort ??= suffix[1];
  }
  const base = TABLE.find(([re]) => re.test(model))?.[1] ?? settings.claimNormal;
  const weight = (effort && EFFORT[effort.toLowerCase()]) || 1;
  const big = opts.big && settings.claimNormal > 0 ? settings.claimBig / settings.claimNormal : 1;
  return Math.round(base * weight * big * 100) / 100;
}
