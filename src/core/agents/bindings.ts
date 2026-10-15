/** The explicit session → project associations local agents know and the
 *  checkout cannot say: their conversations, which run in a private
 *  directory, and the work sessions they started. Navigation only. */
import type { ProjectBindings } from "../projects";
import type { LocalAgent } from "./conversation";

export function agentBindings(agents: readonly Pick<LocalAgent, "session" | "workSessions" | "previous" | "sessionProjects" | "project" | "repo">[]): ProjectBindings {
  const out = new Map<string, string | null>();
  for (const a of agents) {
    for (const id of a.previous) if (!out.has(id)) out.set(id, a.sessionProjects?.[id] ?? a.project ?? null);
    for (const id of a.workSessions ?? []) out.set(id, a.repo);
    if (a.session) out.set(a.session, a.repo);
  }
  return out;
}
