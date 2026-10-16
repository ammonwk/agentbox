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
    if (!id) continue; // no `about`: an idle agent has no session either, and must not match
    const s = state.sessions.find((s) => s.id === id);
    if (s) return projectOfSession(state.repos, s) === project;
  }
  return false;
}

/** The state as the project sees it: its sessions, its cards, and the
 *  schedules on its repo or in its checkout. What belongs to no project is
 *  seen only from All projects. */
export function scopedState(state: AppState, project: string | null): AppState {
  if (!project) return state;
  return {
    ...state,
    sessions: state.sessions.filter((s) => projectOfSession(state.repos, s) === project),
    cards: state.cards.filter((c) => cardInProject(state, c, project)),
    schedules: state.schedules.filter((s) => s.spec.repoId === project || (!s.spec.repoId && s.spec.cwd && repoOfSession(state.repos, { repoRoot: null, cwd: s.spec.cwd })?.id === project)),
  };
}

/** A session's project: the one its superagent shows in, when it shows in
 *  exactly one (`Session.agentProject`, set by the server), else its checkout's. */
export function projectOfSession(repos: readonly Repo[], s: Parameters<typeof sessionProject>[1] & { agentProject?: string | null }): string | null {
  return s.agentProject !== undefined ? s.agentProject : sessionProject(repos, s);
}
