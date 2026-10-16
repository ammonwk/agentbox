/** The Agents page: every superagent shown in the selected project, in the
 *  rail with its picture and what it does, and the open one's Chat, Feed and
 *  Settings (docs/superagents.md). Opening any of it starts nothing; only
 *  sending does. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AppState, Session, SuperagentInfo } from "../../../src/core/types";
import { Button, Empty, ErrorBoundary } from "../components";
import { go, hrefOf, scopeOf, selectScope, type Route } from "../route";
import { useScope } from "../lib/projects";
import { shownStatus, titleOf } from "../lib/board";
import { agentActivity, type AgentOption } from "../lib/agentorder";
import { avatarUrl } from "./AgentAvatar";
import { AgentBrowser, firstActive, landingForAgent, landingForTeam, TEAM_PREFIX, type AgentThread, type TeamRail } from "./AgentBrowser";
import { AgentSpace } from "./AgentSpace";
import { TeamSpace } from "./AgentTeam";
import { TeamAccessContext, useTeam, useTeamAccess, useTeamDirectory } from "../lib/teamagents";
import "./session/session.css";
import "./agents.css";

const LIST_MS = 4_000;

function useSuperagents(): { list: SuperagentInfo[] | null; error: string | null; reload: () => Promise<void> } {
  const [list, setList] = useState<SuperagentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.superagents().then(
        (l) => (setList(l), setError(null)),
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void load();
    const t = setInterval(load, LIST_MS);
    return () => clearInterval(t);
  }, [load]);
  return { list, error, reload: load };
}

/** The sessions that say what an agent is doing: its main, and each session it started (`agentOwner`). */
const sessionsOf = (a: SuperagentInfo, state: AppState) => state.sessions.filter((s) => s.id === a.main || s.agentOwner === a.name);

/** A superagent as the rail shows it. A disabled one is paused, whatever its sessions do: it is listed last. */
function agentOption(a: SuperagentInfo, state: AppState): AgentOption {
  const where = a.projects === null ? "Every project" : a.projects.map((id) => state.repos.find((r) => r.id === id)?.displayName ?? id).join(", ") || "No project";
  const activity = !a.enabled ? "paused" : a.error || a.process?.state === "backoff" ? "approval" : agentActivity(true, sessionsOf(a, state).map(shownStatus));
  return {
    id: a.name,
    name: a.title,
    role: a.description,
    icon: a.icon,
    avatar: avatarUrl(a),
    activity,
    detail: `${where} · ${a.error ? "Manifest error" : !a.enabled ? "Disabled" : a.process ? `Program ${a.process.state}` : a.hasPage ? "Program elsewhere" : "Conversation"}`,
  };
}

/** Its conversations: the main, the earlier mains (read-only), and the work
 *  sessions it started. One the board does not hold now is listed by its id. */
function threadsOf(a: SuperagentInfo, state: AppState): AgentThread[] {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const live = (s: Session) => s.status !== "closed" && s.status !== "stopped";
  const row = (id: string, kind: AgentThread["kind"]): AgentThread => {
    const s = byId.get(id);
    if (!s) return { id, title: `Conversation ${id}`, status: "closed", at: 0, kind, active: kind === "main" };
    return { id, title: titleOf(s), status: shownStatus(s), at: s.lastActivityAt, kind, active: kind === "main" || (kind === "work" && live(s)) };
  };
  const earlier = new Set(a.previous);
  return [
    ...(a.main ? [row(a.main, "main")] : []),
    ...state.sessions.filter((s) => s.agentOwner === a.name && s.id !== a.main && !earlier.has(s.id)).map((s) => row(s.id, "work")),
    ...a.previous.filter((id) => id !== a.main).map((id) => row(id, "earlier")),
  ];
}

export function Agents({ state, route }: { state: AppState; route: Extract<Route, { page: "agents" }> }) {
  const team = useTeamAccess();
  return (
    <TeamAccessContext.Provider value={team}>
      <AgentsPage state={state} route={route} />
    </TeamAccessContext.Provider>
  );
}

/** The workspace's shared agents that another machine hosts, for the rail;
 *  null when the cloud is not set up here or nobody is signed in. */
function useTeamRail(): TeamRail | null {
  const team = useTeam();
  const dir = useTeamDirectory(team.human, team.workspace);
  const rows = useMemo(() => (dir.data ?? []).filter((i) => !i.here), [dir.data]);
  return team.human && team.workspace ? { rows, error: dir.error, loaded: dir.data !== null } : null;
}

function AgentsPage({ state, route }: { state: AppState; route: Extract<Route, { page: "agents" }> }) {
  const { project } = useScope();
  const teamRail = useTeamRail();
  const { list, error, reload } = useSuperagents();
  const name = route.id ?? null;
  const inProject = (a: SuperagentInfo) => !project || a.projects === null || a.projects.includes(project);
  const shown = useMemo(() => (list ?? []).filter(inProject), [list, project]);
  const options = useMemo(() => shown.map((a) => agentOption(a, state)), [shown, state]);
  const selected = list?.find((a) => a.name === name) ?? null;

  // An old link to a local agent (`#/agents/local-vulcan-project-5d0d…/…`)
  // opens the superagent it became: the server knows each move (canonical()).
  const unknown = list && name && !name.startsWith(TEAM_PREFIX) && !selected ? name : null;
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!unknown) return;
    let live = true;
    api.superagent(unknown).then(
      (a) => {
        if (!live) return;
        if (a.name !== unknown) go({ ...route, id: a.name }, true);
        else setMissing(unknown);
      },
      () => live && setMissing(unknown),
    );
    return () => {
      live = false;
    };
  }, [unknown]);
  const renamed = !!unknown && missing !== unknown;
  // A link with no project (`#/agents/<name>`, from a phone or another page)
  // opens in the agent's first project, not in whichever tab was first.
  useEffect(() => {
    if (!name || renamed || (!list && !error) || scopeOf().has("project")) return;
    selectScope("project", name.startsWith(TEAM_PREFIX) ? null : (selected?.projects?.[0] ?? null), route, true);
  }, [name, renamed, !!list, !!error, selected?.name]);
  // The page itself opens on the first active agent, in your order; with
  // none here, on the first shared one.
  const firstShared = teamRail?.rows[0]?.id ?? null;
  useEffect(() => {
    if (name) return;
    if (options.length) go(landingForAgent(firstActive(options)!.id), true);
    else if (list && firstShared) go(landingForTeam(firstShared), true);
  }, [name, options.length, project, !!list, firstShared]);

  if (error && !list) return <Empty title="Could not load the agents">{error}</Empty>;
  if (!list || renamed) return <Empty title="Loading agents…" />;
  // A shared agent another machine hosts: the same rail, and its team pane.
  if (name?.startsWith(TEAM_PREFIX)) {
    const instance = teamRail?.rows.find((i) => i.id === name.slice(TEAM_PREFIX.length)) ?? null;
    return (
      <div className="agents-page">
        <AgentBrowser id={name} options={options} threads={[]} viewed={null} team={teamRail}>
          <ErrorBoundary resetKey={name} label="This shared agent">
            {instance ? (
              <TeamSpace key={instance.id} instance={instance} />
            ) : !teamRail ? (
              <Empty title="Sign in to see shared agents">
                <p>
                  A shared agent runs on a teammate's machine. Sign in on the <a href={hrefOf({ page: "team" })}>Team page</a> to read it.
                </p>
              </Empty>
            ) : teamRail.error && !teamRail.loaded ? (
              <Empty title="Could not load the shared agents">{teamRail.error}</Empty>
            ) : !teamRail.loaded ? (
              <Empty title="Loading shared agents…" />
            ) : (
              <Empty title="No such shared agent">
                <p>Its host stopped the share, or you cannot see it in this workspace.</p>
              </Empty>
            )}
          </ErrorBoundary>
        </AgentBrowser>
      </div>
    );
  }
  if (!list.length && !teamRail?.rows.length)
    return (
      <Empty title="No agents yet">
        <p>
          An agent is a directory with a <code>superagent.json</code>. Add one with <code>agentbox superagent add &lt;dir&gt;</code>. The examples are in the agentbox
          checkout under <code>superagents/</code>.
        </p>
      </Empty>
    );
  if (name && !selected)
    return (
      <Empty title="No such agent" action={<a className="btn btn-default btn-md" href={hrefOf({ page: "agents" })}>All agents</a>}>
        <p>
          Nothing here has the name <code>{name}</code>. It can be on another machine, or somebody removed it.
        </p>
      </Empty>
    );
  if (selected && !inProject(selected))
    return (
      <Empty title={`${selected.title} is not in this project`}>
        {selected.projects?.length ? (
          <Button onClick={() => selectScope("project", selected.projects![0]!, { page: "agents", id: selected.name })}>Open it in its project</Button>
        ) : (
          <p>
            Its manifest names no project (<code>"projects": []</code>), so no project shows it.
          </p>
        )}
      </Empty>
    );
  if (!selected)
    return (
      <Empty title="No agents in this project">
        <p>
          An agent shows in the projects its manifest names (<code>"projects"</code>), or in every project when it names none.
        </p>
      </Empty>
    );
  const threads = threadsOf(selected, state);
  const viewed = route.thread && threads.some((t) => t.id === route.thread) ? route.thread : selected.main;
  return (
    <div className="agents-page">
      <AgentBrowser id={selected.name} options={options} threads={threads} viewed={viewed} team={teamRail}>
        <ErrorBoundary resetKey={selected.name} label="This agent">
          <AgentSpace key={selected.name} info={selected} state={state} threads={threads} viewed={viewed} reload={reload} />
        </ErrorBoundary>
      </AgentBrowser>
    </div>
  );
}
