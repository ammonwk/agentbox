/** The claim a session makes on its account, from the model it will run.
 *
 * A claim is the weekly points a session is assumed to use until it has
 * spent anything to forecast from (see claims.ts). Where sessions of its
 * model have run before, it is what they went on to use (`Forecaster.claim`);
 * this table is for a model, or a machine, with no such history. One number
 * cannot fit every model: a
 * Devin afternoon on GLM-5.3-Flash barely dents an account that a day of
 * Fable burns a twelfth of. The table below scales the claim by model family
 * and reasoning effort, so the balancer counts a flash-tier session as the
 * rounding error it is and keeps the heavy models off a crowded account.
 *
 * The anchors are burn ratios with one of them measured: a placed Opus
 * session's first stretch of work has averaged 1.2 weekly points here (most
 * use far less, a few many times more), and the rest keep
 * their ratio to it. They are not API prices — subscriptions do not bill per
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
  [/fable|mythos/, 3],
  [/astra/, 2.5],
  [/opus/, 1.2],
  [/(^|[^a-z])sol([^a-z]|$)/, 1],
  [/sonnet/, 0.8],
  [/(^|[^a-z])luna([^a-z]|$)/, 0.4],
  [/haiku/, 0.4],
  [/flash/, 0.4],
  [/glm|deepseek/, 0.8],
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
 * The family a model belongs to, for counting what its sessions have used
 * (forecast.ts): the table's pattern when one matches, else the model's own
 * id without its effort suffix. "default" for a session started without one.
 */
export function familyOf(model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase().replace(EFFORT_SUFFIX, "");
  if (!m) return "default";
  return TABLE.find(([re]) => re.test(m))?.[0].source ?? m;
}

/**
 * The listed claim for a session on `model` at `effort`: the family's points,
 * times effort. Null for a model the table does not know.
 */
export function listedClaim(opts: { model?: string | null; effort?: string | null }): number | null {
  return scaled(opts, (model) => TABLE.find(([re]) => re.test(model))?.[1] ?? null);
}

/**
 * The claim for a session on `model` at `effort` where nothing has been
 * measured: its listed claim, or `claimNormal` for a model the table does
 * not know, times effort.
 */
export function claimFor(
  opts: { model?: string | null; effort?: string | null },
  settings: BalancerSettings,
): number {
  return listedClaim(opts) ?? scaled(opts, () => settings.claimNormal)!;
}

function scaled(opts: { model?: string | null; effort?: string | null }, baseOf: (model: string) => number | null): number | null {
  let model = (opts.model ?? "").toLowerCase();
  let effort = opts.effort ?? null;
  const suffix = EFFORT_SUFFIX.exec(model);
  if (suffix) {
    model = model.slice(0, model.length - suffix[0].length);
    effort ??= suffix[1];
  }
  const base = baseOf(model);
  if (base === null) return null;
  const weight = (effort && EFFORT[effort.toLowerCase()]) || 1;
  return Math.round(base * weight * 100) / 100;
}
