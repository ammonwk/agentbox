/** Copies this machine's local agents into a workspace as shared agents. */
import { AGENT_TEMPLATES, AgentDefinition, type SharedAgent } from "../../../src/cloud/agents";
import type { LocalAgent } from "../../../src/core/agents/conversation";
import type { Repo } from "../../../src/core/types";

export interface Move {
  local: LocalAgent;
  name: string;
  definition: AgentDefinition;
}

const key = (name: string, repos: string[]) => `${name.trim().toLowerCase()} ${[...repos].sort().join(",")}`;

/** The local agents that the workspace does not have yet. Jupiter stays out:
 *  the workspace makes its own creator for each repository. An agent with no
 *  project stays out when a project copy of it exists. */
export function pendingMoves(locals: LocalAgent[], repos: Repo[], shared: SharedAgent[]): Move[] {
  const fullName = (id: string | null | undefined) => {
    const r = id ? repos.find((x) => x.id === id) : undefined;
    return r?.fullName ?? (r?.kind === "github" ? r.ref : undefined);
  };
  const have = new Set(shared.map((a) => key(a.name, a.definition.repos)));
  const inProject = new Set(locals.filter((l) => l.project).map((l) => l.name.trim().toLowerCase()));
  const out: Move[] = [];
  // Enabled first, so an enabled copy wins over a paused one with the same name and repository.
  for (const l of [...locals].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
    if (l.capability === "creator" || l.unavailable) continue;
    const project = l.project ?? l.repo;
    if (!project && inProject.has(l.name.trim().toLowerCase())) continue;
    const repo = fullName(project);
    if (project && !repo) continue;
    const repos = repo ? [repo.toLowerCase()] : [];
    if (have.has(key(l.name, repos))) continue;
    have.add(key(l.name, repos));
    const template = AGENT_TEMPLATES.find((t) => l.id === `local-${t.id}` || l.id.startsWith(`local-${t.id}-project-`));
    const instructions = [l.instructions.trim(), l.automation?.trim() ? `When to start: ${l.automation.trim()}` : ""].filter(Boolean).join("\n\n");
    const definition = AgentDefinition.parse({
      ...(template?.definition ?? {}),
      role: (l.role || template?.definition.role || l.name).slice(0, 120),
      instructions: instructions.slice(0, 24000),
      repos,
    });
    out.push({ local: l, name: l.name.slice(0, 80), definition });
  }
  return out;
}
