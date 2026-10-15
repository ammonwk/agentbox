/** Which registered repository a session belongs to, for the board's project
 *  switcher. A navigation association only, never an authorization decision:
 *  selecting a project starts, stops and grants nothing. */
import type { Repo, Session } from "./types";

/** An explicit session → project (repo id, or null for none) association a
 *  caller knows and the checkout cannot say. None is passed today. */
export type ProjectBindings = ReadonlyMap<string, string | null>;

/**
 * The project of a session: an explicit binding wins; otherwise the
 * registered repo whose canonical checkout root the session's repo root (a
 * worktree's is its main checkout) is or is under. The longest root wins, so
 * a nested repository beats its parent; a worktree's `repoRoot` must equal a
 * checkout exactly, so only a session with no repo root prefix-matches.
 */
export function sessionProject(repos: readonly Repo[], s: Pick<Session, "id" | "repoRoot" | "cwd">, bound?: ProjectBindings): string | null {
  if (bound?.has(s.id)) return bound.get(s.id) ?? null;
  const root = s.repoRoot ?? s.cwd;
  return [...repos].sort((a, b) => (b.checkoutRoot ?? b.ref).length - (a.checkoutRoot ?? a.ref).length).find((r) => {
    const path = r.checkoutRoot ?? r.ref;
    return root === path || (!s.repoRoot && path.startsWith("/") && root.startsWith(`${path}/`));
  })?.id ?? null;
}
