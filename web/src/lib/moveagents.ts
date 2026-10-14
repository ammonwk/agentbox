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

/** A host counts as connected when it reported in the last two minutes. */
export function hostConnected(a: SharedAgent, hosts: { id: string; last_seen_at: string | null; revoked_at: string | null }[], now = Date.now()): boolean {
  const h = hosts.find((x) => x.id === a.execution_installation_id);
  return !!h && !h.revoked_at && !!h.last_seen_at && now - Date.parse(h.last_seen_at) < 120_000;
}

/** This machine's copy of a shared agent: the same name on the same repository. */
export function localTwin(a: SharedAgent, locals: LocalAgent[], repos: Repo[]): LocalAgent | undefined {
  const want = [...a.definition.repos].sort().join(",");
  const repoOf = (l: LocalAgent) => {
    const r = repos.find((x) => x.id === (l.project ?? l.repo));
    return (r?.fullName ?? (r?.kind === "github" ? r.ref : "") ?? "").toLowerCase();
  };
  return locals
    .filter((l) => !l.unavailable && l.name.trim().toLowerCase() === a.name.trim().toLowerCase() && repoOf(l) === want)
    .sort((x, y) => Number(y.enabled) - Number(x.enabled))[0];
}

/** Where a shared agent runs for this browser: on this machine, through its
 *  local copy, or on the workspace's execution host. */
export type Where = "local" | "hosted";
const whereKey = (shared: string) => `agentbox.agents.where.${shared}`;
const TWINS = "agentbox.agents.twins";

export function chosenWhere(shared: string): Where | null {
  try {
    const v = localStorage.getItem(whereKey(shared));
    return v === "local" || v === "hosted" ? v : null;
  } catch {
    return null;
  }
}

export function chooseWhere(shared: string, where: Where): void {
  try {
    localStorage.setItem(whereKey(shared), where);
  } catch {
    // Not remembered: the default (local while the host is offline) applies.
  }
}

/** Local agent id → its shared agent id, so a local agent's page can switch back. */
export function rememberTwins(pairs: Record<string, string>): void {
  try {
    localStorage.setItem(TWINS, JSON.stringify(pairs));
  } catch {
    // The local page then shows no Hosted switch.
  }
}

export function sharedTwinOf(local: string): string | undefined {
  try {
    return (JSON.parse(localStorage.getItem(TWINS) ?? "{}") as Record<string, string>)[local];
  } catch {
    return undefined;
  }
}
