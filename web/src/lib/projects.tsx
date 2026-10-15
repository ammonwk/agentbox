/** The selected project, and the board as seen from it. Navigation only:
 *  what runs, where, and on which account is not touched by any of this. */

import { createContext, useContext, useSyncExternalStore } from "react";
import type { AppState, Card, Repo } from "../../../src/core/types";
import { sessionProject } from "../../../src/core/projects";
import { onGo, scopeOf, selectScope } from "../route";
import { repoOfSession } from "./newsession";

export { sessionProject };

/** The scope in the URL (route.ts), as React state: re-rendered on every way
 *  the URL moves — go(), the back button, a typed hash. */
export function useScope() {
  useSyncExternalStore(
    (fn) => {
      const off = onGo(fn);
      addEventListener("hashchange", fn);
      addEventListener("popstate", fn);
      return () => {
        off();
        removeEventListener("hashchange", fn);
        removeEventListener("popstate", fn);
      };
    },
    () => location.hash,
  );
  const scope = scopeOf();
  return { project: scope.get("project") || null, workspace: scope.get("workspace") || "", select: selectScope };
}

/** The registered repos, for anything below the shell that names a session's project. */
export const ProjectContext = createContext<{ repos: Repo[] }>({ repos: [] });
export const useProjectData = () => useContext(ProjectContext);

/** A card is its PR's repo first — the session that made it may be
 *  coordinating other projects — else its session's project. */
function cardInProject(state: AppState, c: Card, project: string): boolean {
  if (c.pr) {
    const slug = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:[/?#]|$)/i.exec(c.pr)?.[1]?.toLowerCase();
    if (slug) return state.repos.some((r) => r.id === project && (r.fullName ?? (r.kind === "github" ? r.ref : "")).toLowerCase() === slug);
  }
  for (const id of [c.about, c.sessionId]) {
    const s = state.sessions.find((s) => s.id === id);
    if (s) return sessionProject(state.repos, s) === project;
  }
  return false;
}

/** The project's sessions, and the open ones they run under wherever those
 *  are, so a steward or lead in another checkout still holds its children
 *  together instead of leaving them at the root. */
function projectSessions(state: AppState, project: string): AppState["sessions"] {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const keep = new Set<string>();
  for (const s of state.sessions) {
    if (sessionProject(state.repos, s) !== project) continue;
    keep.add(s.id);
    for (let p = byId.get(s.parent ?? ""); p && p.status !== "closed" && !keep.has(p.id); p = byId.get(p.parent ?? "")) keep.add(p.id);
  }
  return state.sessions.filter((s) => keep.has(s.id));
}

/** The state as the project sees it: its sessions and those they run under,
 *  its cards, and the schedules on its repo or in its checkout. What belongs
 *  to no project is otherwise seen only from All projects. */
export function scopedState(state: AppState, project: string | null): AppState {
  if (!project) return state;
  return {
    ...state,
    sessions: projectSessions(state, project),
    cards: state.cards.filter((c) => cardInProject(state, c, project)),
    schedules: state.schedules.filter((s) => s.spec.repoId === project || (!s.spec.repoId && s.spec.cwd && repoOfSession(state.repos, { repoRoot: null, cwd: s.spec.cwd })?.id === project)),
  };
}
