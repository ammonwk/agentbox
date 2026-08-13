import { listSessions } from "./db";
import { getSettings, saveSettings as persistSettings } from "./db";
import { listRepos } from "./db";
import { listPrs } from "./prs";
import { listSkills } from "./skills";
import { buildConductor } from "./conductor";
import { pendingPermissionOf } from "./sessions";
import type { AgentSettings, AppState } from "./types";

export function getAppState(): AppState {
  const sessions = listSessions(false).map((s) => ({
    ...s,
    permission: pendingPermissionOf(s.id),
  }));
  const repos = listRepos();
  const settings = getSettings();

  // Skills and PRs are fast enough to compute on every poll.
  const skills = listSkills();
  const prs = listPrs(repos, sessions);  const conductor = buildConductor(sessions, prs);

  return {
    sessions,
    repos,
    prs,
    skills,
    conductor,
    settings,
    serverTime: Date.now(),
  };
}

export { getSettings, listRepos, persistSettings as saveSettings };
export type { AgentSettings };
