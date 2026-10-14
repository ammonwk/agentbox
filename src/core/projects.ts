/** Canonical navigation association, not an authorization decision. */
import type { Repo, Session } from "./types";
import type { LocalAgent } from "./agents/conversation";

export function sessionProject(repos: readonly Repo[], agents: readonly LocalAgent[], s: Pick<Session, "id" | "repoRoot" | "cwd">): string | null {
  for (const a of agents) {
    if (a.session === s.id || a.workSessions?.includes(s.id)) return a.repo;
    if (a.previous.includes(s.id)) return a.sessionProjects?.[s.id] ?? a.project ?? null;
  }
  const root = s.repoRoot ?? s.cwd;
  return [...repos].sort((a, b) => (b.checkoutRoot ?? b.ref).length - (a.checkoutRoot ?? a.ref).length).find((r) => {
    const path = r.checkoutRoot ?? r.ref;
    return root === path || (!s.repoRoot && path.startsWith("/") && root.startsWith(`${path}/`));
  })?.id ?? null;
}
