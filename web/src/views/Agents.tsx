/** The Agents page: every superagent shown in the selected project, in the
 *  rail with its picture and what it does, and the open one's Chat, Feed and
 *  Settings (docs/superagents.md). Opening any of it starts nothing; only
 *  sending does. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AppState, Session, SuperagentInfo } from "../../../src/core/types";
import { Button, Empty, ErrorBoundary } from "../components";
import { go, hrefOf, selectScope, type Route } from "../route";
import { useScope } from "../lib/projects";
import { shownStatus, titleOf } from "../lib/board";
import { agentActivity, type AgentOption } from "../lib/agentorder";
import { avatarUrl } from "./AgentAvatar";
import { AgentBrowser, firstActive, landingForAgent, type AgentThread } from "./AgentBrowser";
import { AgentSpace } from "./AgentSpace";
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
  const { project } = useScope();
  const { list, error, reload } = useSuperagents();
  const name = route.id ?? null;
  const inProject = (a: SuperagentInfo) => !project || a.projects === null || a.projects.includes(project);
  const shown = useMemo(() => (list ?? []).filter(inProject), [list, project]);
  const options = useMemo(() => shown.map((a) => agentOption(a, state)), [shown, state]);
  const selected = list?.find((a) => a.name === name) ?? null;

  // An old link to a local agent (`#/agents/local-vulcan/…`) opens the superagent it became.
  const renamed = name?.startsWith("local-") && list?.some((a) => a.name === name.slice(6)) ? name.slice(6) : null;
  useEffect(() => {
    if (renamed) go({ ...route, id: renamed }, true);
  }, [renamed]);
  // The page itself opens on the first active agent, in your order.
  useEffect(() => {
    if (!name && options.length) go(landingForAgent(firstActive(options)!.id), true);
  }, [name, options.length, project]);

  if (error && !list) return <Empty title="Could not load the agents">{error}</Empty>;
  if (!list || renamed) return <Empty title="Loading agents…" />;
  if (!list.length)
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
        <Button onClick={() => selectScope("project", selected.projects![0] ?? null, { page: "agents", id: selected.name })}>Open it in its project</Button>
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
      <AgentBrowser id={selected.name} options={options} threads={threads} viewed={viewed}>
        <ErrorBoundary resetKey={selected.name} label="This agent">
          <AgentSpace key={selected.name} info={selected} state={state} threads={threads} viewed={viewed} reload={reload} />
        </ErrorBoundary>
      </AgentBrowser>
    </div>
  );
}
