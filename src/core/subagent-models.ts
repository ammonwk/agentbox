/** The model a session's subagents run on.
 *
 * A session that delegates should get the same model back, not one the
 * fleet picked for it: the caller knows what it runs on, and the subagent's
 * CLI can often run that model too. Where it cannot — an omp model on
 * devin's harness — the backend keeps its own default and says which model
 * it will use (src/subagents/parent.ts).
 */

import { devinFamilies, devinFamiliesNow } from "./models";
import { parentModels, type ParentModel } from "../subagents/parent";
import type { ProviderId } from "./types";

/** What a session's subagents run on, for a session on `model`.
 *
 *  The devin catalog is asked only when the session's own CLI is not devin:
 *  devin's models are named by devin, so a session on one of them needs no
 *  lookup. */
export async function parentModelFor(
  provider: ProviderId,
  model: string | null | undefined,
  effort: string | null | undefined,
): Promise<ParentModel | null> {
  if (!model) return null;
  const families = provider === "devin" ? null : await devinFamilies();
  const { omp, devin } = parentModels(provider, model, effort, families);
  return { provider, model, effort: effort ?? null, omp, devin };
}

/** The same, from what is already known: a session that is resumed rather
 *  than started must not wait for the devin catalog to answer. */
export function parentModelNow(
  provider: ProviderId,
  model: string | null | undefined,
  effort: string | null | undefined,
): ParentModel | null {
  if (!model) return null;
  const families = provider === "devin" ? null : devinFamiliesNow();
  const { omp, devin } = parentModels(provider, model, effort, families);
  return { provider, model, effort: effort ?? null, omp, devin };
}
