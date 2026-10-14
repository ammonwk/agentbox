/** Navigation only. Cloud membership, execution grants and outbound consent
 * remain enforced by their existing service boundaries. */
import { createContext, useContext, useSyncExternalStore } from "react";
import type { AppState, Card, Repo } from "../../../src/core/types";
import type { LocalAgent } from "../../../src/core/agents/conversation";
import { onGo, scopeOf, selectScope } from "../route";
import { repoOfSession } from "./newsession";

export function useScope() {
  useSyncExternalStore((fn) => {
    const off = onGo(fn);
    addEventListener("hashchange", fn);
    addEventListener("popstate", fn);
    return () => { off(); removeEventListener("hashchange", fn); removeEventListener("popstate", fn); };
  }, () => location.hash);
  const scope = scopeOf();
  return { project: scope.get("project") || null, workspace: scope.get("workspace") || "", select: selectScope };
}
export const ProjectContext = createContext<{ repos: Repo[]; agents: LocalAgent[] }>({ repos: [], agents: [] });
export const useProjectData = () => useContext(ProjectContext);

import { sessionProject } from "../../../src/core/projects";
export { sessionProject };
function cardInProject(state: AppState, agents: LocalAgent[], c: Card, project: string): boolean {
  if (c.pr) {
    const slug = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:[/?#]|$)/i.exec(c.pr)?.[1]?.toLowerCase();
    // A concrete PR association wins; a source session may be coordinating other projects.
    if (slug) return state.repos.some((r) => r.id === project && (r.fullName ?? (r.kind === "github" ? r.ref : "")).toLowerCase() === slug);
  }
  for (const id of [c.about, c.sessionId]) {
    const s = state.sessions.find((s) => s.id === id);
    if (s) return sessionProject(state.repos, agents, s) === project;
    const a = agents.find((a) => a.session === id || a.previous.includes(id ?? ""));
    if (a) return (a.session === id ? a.repo : a.sessionProjects?.[id!] ?? a.project ?? null) === project;
  }
  return false;
}
export function scopedState(state: AppState, project: string | null, agents: LocalAgent[]): AppState {
  if (!project) return state;
  return { ...state,
    sessions: state.sessions.filter((s) => sessionProject(state.repos, agents, s) === project),
    cards: state.cards.filter((c) => cardInProject(state, agents, c, project)),
    schedules: state.schedules.filter((s) => s.spec.repoId === project || (!s.spec.repoId && s.spec.cwd && repoOfSession(state.repos, { repoRoot: null, cwd: s.spec.cwd })?.id === project)),
  };
}
