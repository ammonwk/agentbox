/** The calling session's own model, so a subagent can run on it.
 *
 * agentbox writes this into the environment of every session it starts. The
 * subagent MCP is a child of the CLI, which is a child of the session, so it
 * inherits it; a session started by hand has none, and the backends keep
 * their own defaults.
 *
 * The model is the parent's, not a choice the caller makes: a caller naming
 * a model would name one it knows ("sonnet"), which a CLI can accept at
 * launch and fail on at the first prompt. The parent knows what it runs on.
 */

/** The environment variable the fleet writes into a session. */
export const PARENT_ENV = "AGENTBOX_SUBAGENT_PARENT";

export interface ParentModel {
  /** The CLI the session runs on: "omp", "claude", "devin"… */
  provider: string;
  /** The model the session runs on. */
  model: string;
  /** The effort it runs at, where the CLI names one. */
  effort?: string | null;
  /** The model the omp backend runs on, when it can run the parent's. */
  omp?: string | null;
  /** The model the devin backend runs on, when it can run the parent's. */
  devin?: string | null;
}

/** A model family as devin's catalog names it: the family, and the variants
 *  (effort tiers) it runs at. */
export interface ModelFamily {
  uid: string;
  variants: string[];
}

export function encodeParent(parent: ParentModel): string {
  return JSON.stringify(parent);
}

export function decodeParent(raw: string | undefined | null): ParentModel | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ParentModel>;
    if (!v || typeof v.model !== "string" || !v.model) return null;
    return {
      provider: typeof v.provider === "string" ? v.provider : "",
      model: v.model,
      effort: typeof v.effort === "string" ? v.effort : null,
      omp: typeof v.omp === "string" ? v.omp : null,
      devin: typeof v.devin === "string" ? v.devin : null,
    };
  } catch {
    return null;
  }
}

/** What a model id and a family id have in common: lower case, no
 *  separators. "claude-opus-5-5" and "claude-opus-5.5" are one family. */
const key = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The same model, in devin's catalog, at the same effort.
 *
 * devin sells Claude's and GPT's models under its own names — one variant
 * per effort — so a session on "claude-opus-5-5" at high effort has a
 * devin variant "claude-opus-5-5-high" that is the same model. Null when
 * devin does not sell it: the backend then runs its own default, and says
 * so.
 */
export function devinVariant(model: string, effort: string | null | undefined, families: ModelFamily[] | null): string | null {
  if (!families) return null;
  const family = families.find((f) => key(f.uid) === key(model));
  if (!family) return null;
  // The tier a variant names: what follows its family.
  const tier = (variant: string): string => {
    const v = key(variant);
    const u = key(family.uid);
    return v.startsWith(u) ? v.slice(u.length) : "";
  };
  // codex's "minimal" is devin's "none"; the other names are the same.
  const wanted = effort ? (effort === "minimal" ? "none" : key(effort)) : "";
  const exact = family.variants.find((v) => tier(v) === wanted);
  if (exact) return exact;
  const middle = family.variants.find((v) => tier(v) === "medium");
  return middle ?? family.variants[0] ?? null;
}

/** The model each backend runs on, given the session that called.
 *
 * The session's own CLI runs the session's own model by name. Another CLI
 * can run the same model only where it sells it, which devin does for
 * Claude's and GPT's models: it names them by family and effort, so the
 * parent's model is looked up in its catalog.
 */
export function parentModels(
  provider: string,
  model: string,
  effort: string | null | undefined,
  families: ModelFamily[] | null,
): { omp: string | null; devin: string | null } {
  return {
    omp: provider === "omp" ? model : null,
    devin: provider === "devin" ? model : devinVariant(model, effort, families),
  };
}

/** The backend that will run the parent's model: the session's own CLI when
 *  it can, and otherwise the one that can run the same model elsewhere.
 *  omp when neither can, which is what the backends have always done. */
export function parentProvider(parent: ParentModel | null): "omp" | "devin" {
  if (parent?.omp) return "omp";
  if (parent?.devin) return "devin";
  return "omp";
}
