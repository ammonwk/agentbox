import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Button, Icon, RelativeTime, Spinner } from "../components";
import { go, hrefOf, parseHash, scopeOf, type Route } from "../route";
import { useIsNarrow } from "./session/useIsNarrow";
import { AgentAvatar } from "./AgentAvatar";
import { halfOf, placeIn, ranksOf, readOrder, saveOrder, stepIn } from "../lib/manualorder";
import { useDismiss } from "./newsession/popover";
import { agentActivity, dropAgent, firstActiveIn, resting, sidebarOrder, type AgentActivity, type AgentOption } from "../lib/agentorder";
import type { TeamInstance } from "../lib/teamagents";

/** Your order of the agents, by workspace and project, and of each agent's
 *  work sessions, by agent (lib/manualorder.ts). Keyed by superagent name. */
const AGENT_ORDER_KEY = "agentbox.agentOrder";
const THREAD_ORDER_KEY = "agentbox.agentSessionOrder";

/** One conversation of a superagent, as its rail lists it: its main, an
 *  earlier main (read-only), or a work session it started (`agentOwner`). */
export type AgentThread = { id: string; title: string; status: string; at: number; kind: "main" | "earlier" | "work"; active: boolean };

function ActivityIcon({ activity }: { activity: AgentActivity }) {
  const label = { working: "Active", approval: "Needs attention", waiting: "Waiting for you", idle: "Inactive", paused: "Paused" }[activity];
  return (
    <span className="rail-state" data-state={activity} role="img" aria-label={label} title={label}>
      {activity === "working" ? <Spinner size={12} /> : activity === "approval" ? <Icon.alert size={13} /> : activity === "waiting" ? <Icon.clock size={13} /> : activity === "paused" ? <Icon.pause size={13} /> : <span className="st-dot st-closed" />}
    </span>
  );
}

const agentScopeKey = () => `${scopeOf().get("workspace") ?? ""}:${scopeOf().get("project") ?? ""}`;
/** Where the agents page opens, from its link or a project tab (lib/agentorder.ts). */
export const firstActive = (options: readonly AgentOption[]) => firstActiveIn(options, readOrder(AGENT_ORDER_KEY, agentScopeKey()));

export function agentRoute(): Extract<Route, { page: "agents" }> {
  const r = parseHash(location.hash);
  return r.page === "agents" ? r : { page: "agents" };
}
/** An agent's Chat with its main conversation. */
export const landingForAgent = (id: string): Route => ({ page: "agents", id, view: "chat" });

/** The route id of a shared instance another machine hosts: its cloud id after `team:`. */
export const TEAM_PREFIX = "team:";
export const teamRouteId = (instance: string) => `${TEAM_PREFIX}${instance}`;
export const landingForTeam = (instance: string): Route => landingForAgent(teamRouteId(instance));

/** The rail's Team group: the workspace's shared instances that this machine does not host. */
export type TeamRail = { rows: TeamInstance[]; error: string | null; loaded: boolean };

/** The agents rail beside the open agent: each agent with its picture and
 *  what it is doing, in your order, and the open one's conversations under it. */
export function AgentBrowser({
  id,
  options,
  threads,
  viewed,
  team = null,
  children,
}: {
  id: string;
  options: AgentOption[];
  threads: AgentThread[];
  viewed: string | null;
  team?: TeamRail | null;
  children: ReactNode;
}) {
  const route = agentRoute();
  const narrow = useIsNarrow();
  const [expanded, setExpanded] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const rail = useRef<HTMLElement>(null),
    hadDetail = useRef(route.view !== "sessions");
  useEffect(() => setExpanded(true), [id, route.thread, route.view]);
  useEffect(() => setShowInactive(false), [id]);
  useEffect(() => {
    // AgentSpace remounts when choosing another agent. Keep keyboard focus in the list.
    if (document.activeElement === document.body) rail.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus();
  }, [id]);
  useEffect(() => {
    if (hadDetail.current && route.view === "sessions") (rail.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? rail.current?.querySelector<HTMLElement>('[data-selected="true"]'))?.focus();
    hadDetail.current = route.view !== "sessions";
  }, [route.view]);
  const choose = (agent: string) => {
    setExpanded(true);
    go(landingForAgent(agent));
  };
  const main = threads.find((t) => t.kind === "main");
  const others = threads.filter((t) => t.kind !== "main");
  const inactive = others.filter((t) => !t.active);
  const activeCount = others.length - inactive.length;
  // Your order: the agents you placed first, then the rest as they come; an
  // agent's work sessions stay active first, and within that one you have
  // not placed comes first, the newest on top.
  const agentScope = agentScopeKey();
  const [agentOrder, setAgentOrder] = useState(() => ({ scope: agentScope, ids: readOrder(AGENT_ORDER_KEY, agentScope) }));
  const agentIds = useMemo(() => (agentOrder.scope === agentScope ? agentOrder.ids : readOrder(AGENT_ORDER_KEY, agentScope)), [agentOrder, agentScope]);
  const [threadOrder, setThreadOrder] = useState(() => ({ scope: id, ids: readOrder(THREAD_ORDER_KEY, id) }));
  const threadIds = useMemo(() => (threadOrder.scope === id ? threadOrder.ids : readOrder(THREAD_ORDER_KEY, id)), [threadOrder, id]);
  const threadRanks = ranksOf(threadIds);
  const agents = sidebarOrder(options, agentIds);
  const ordered = others
    .filter((t) => t.active || showInactive)
    .sort((a, b) => Number(b.active) - Number(a.active) || (threadRanks.get(a.id) ?? -1) - (threadRanks.get(b.id) ?? -1) || b.at - a.at);
  // The rows beside each other, which Alt+↑/↓ and the menu move among: the
  // active agents and the paused ones, and each agent's active work and the rest.
  const siblingsOf = (row: Row): string[] =>
    row.kind === "agent"
      ? agents.filter((a) => resting(a) === resting(agents.find((x) => x.id === row.id)!)).map((a) => a.id)
      : ordered.filter((t) => t.active === ordered.find((x) => x.id === row.id)?.active).map((t) => t.id);
  const place = (row: Row, next: string[] | null) => {
    if (!next) return false;
    if (row.kind === "agent") {
      const kept = next.filter((x) => options.some((a) => a.id === x));
      saveOrder(AGENT_ORDER_KEY, agentScope, kept);
      setAgentOrder({ scope: agentScope, ids: kept });
    } else {
      // Sessions not on the board now keep their places.
      saveOrder(THREAD_ORDER_KEY, id, next);
      setThreadOrder({ scope: id, ids: next });
    }
    return true;
  };
  const step = (row: Row, by: -1 | 1) => place(row, stepIn(row.kind === "agent" ? agentIds : threadIds, siblingsOf(row), row.id, by));
  const canStep = (row: Row, by: -1 | 1) => {
    const sib = siblingsOf(row),
      i = sib.indexOf(row.id);
    return i !== -1 && sib[i + by] !== undefined;
  };
  const [drag, setDrag] = useState<Row | null>(null);
  const [over, setOver] = useState<{ id: string; at: "before" | "after" } | null>(null);
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null);
  // Dragging a row to a new place: before or after the row it is dropped on,
  // by which half. A work session goes among those beside it; an agent can be
  // dropped on any agent, and the line shows where it will be drawn.
  const dropOn = (row: Row, e: DragEvent<HTMLElement>) => {
    if (!drag || drag.id === row.id || drag.kind !== row.kind) return null;
    if (drag.kind === "agent") return dropAgent(options, agentIds, drag.id, row.id, halfOf(e));
    if (!siblingsOf(drag).includes(row.id)) return null;
    const at = halfOf(e);
    return { ids: placeIn(threadIds, siblingsOf(drag), drag.id, row.id, at), line: { id: row.id, at } };
  };
  const dnd = (row: Row) => ({
    draggable: true,
    "data-drop": over?.id === row.id ? over.at : undefined,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/x-agentbox-order", row.id);
      setDrag(row);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const drop = dropOn(row, e);
      if (!drop) return setOver(null);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(drop.line);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const drop = dropOn(row, e);
      if (drag && drop) place(drag, drop.ids);
      setDrag(null);
      setOver(null);
    },
    // Right-click, or a long press on a phone: move it up or down.
    onContextMenu: (e: MouseEvent) => {
      if (!canStep(row, -1) && !canStep(row, 1)) return;
      e.preventDefault();
      setMenu({ row, x: e.clientX, y: e.clientY });
    },
  });
  const onChat = !route.view || route.view === "chat" || route.view === "sessions";
  const threadRow = (t: AgentThread, draggable: boolean) => (
    <li key={t.id}>
      <a
        {...(draggable ? dnd({ kind: "thread", id: t.id }) : {})}
        className="rail-row"
        data-nav-item
        data-nav-id={`agent-session-${t.id}`}
        data-id={t.id}
        data-status={t.status}
        data-kind={t.kind}
        aria-current={viewed === t.id && onChat ? "page" : undefined}
        href={hrefOf({ page: "agents", id, view: "chat", ...(t.kind === "main" ? {} : { thread: t.id }) })}
        title={`${t.title} · ${t.status}${t.kind === "earlier" ? " · Read-only" : ""}`}
      >
        <span className="rail-title">{t.kind === "main" ? "Main conversation" : t.title}</span>
        <span className="rail-when">{t.at > 0 && <RelativeTime ts={t.at} short />}</span>
        <ActivityIcon activity={agentActivity(true, [t.status])} />
      </a>
    </li>
  );
  return (
    <div className="sv agent-browser" data-rail={narrow && route.view === "sessions" ? "full" : "on"} data-detail={route.view !== "sessions"}>
      <nav
        ref={rail}
        className="rail agent-tree"
        aria-label="Agents and their sessions"
        data-nav-region="list"
        onKeyDown={(e) => {
          const el = e.target as HTMLElement;
          // Alt+↑ and Alt+↓ move the focused row among those beside it, as a drag does.
          if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && el.matches("[data-nav-item]")) {
            const row: Row | null = el.dataset.agent ? { kind: "agent", id: el.dataset.agent } : el.dataset.id && el.dataset.kind !== "main" ? { kind: "thread", id: el.dataset.id } : null;
            if (!row || !step(row, e.key === "ArrowUp" ? -1 : 1)) return;
            e.preventDefault();
            e.stopPropagation();
            // The row is drawn again in its new place; keep the focus on it.
            const navId = el.dataset.navId;
            requestAnimationFrame(() => rail.current?.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(navId ?? "")}"]`)?.focus());
            return;
          }
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
          if (!el.matches("[data-nav-item]")) return;
          const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]")],
            at = rows.indexOf(el);
          if (e.key === "ArrowDown") (rows[at + 1] ?? el).focus();
          else if (e.key === "ArrowUp") (rows[at - 1] ?? el).focus();
          else if (e.key === "Home") rows[0]?.focus();
          else if (e.key === "End") rows.at(-1)?.focus();
          else if (el.dataset.agent && e.key === "Enter") choose(el.dataset.agent);
          else if (el.dataset.agent && e.key === "ArrowRight") {
            if (el.dataset.agent !== id) choose(el.dataset.agent);
            else if (!expanded) setExpanded(true);
            else rail.current?.querySelector<HTMLElement>(".agent-threads [data-nav-item]")?.focus();
          } else if (e.key === "ArrowLeft") {
            if (!el.dataset.agent) rail.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus();
            else if (el.dataset.agent === id && expanded) setExpanded(false);
            else return; // The shell moves from a collapsed agent to app navigation.
          } else return; // The shell opens session links and focuses their conversation.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="agent-tree-head">
          <h2>Agents</h2>
        </div>
        <div className="rail-scroll">
          <ul className="agent-tree-list">
            {agents.map((a) => {
              const open = a.id === id && expanded;
              const hasThreads = a.id === id && threads.length > 0;
              return (
                <li key={a.id}>
                  <button
                    {...dnd({ kind: "agent", id: a.id })}
                    className="rail-row agent-tree-row"
                    data-agent={a.id}
                    data-selected={a.id === id}
                    data-nav-item
                    data-nav-id={`agent-${a.id}`}
                    aria-expanded={hasThreads ? open : undefined}
                    aria-controls={open && hasThreads ? `agent-sessions-${a.id}` : undefined}
                    onClick={() => choose(a.id)}
                    title={`${a.name} · ${a.role}\n${a.detail}`}
                  >
                    <span className="agent-role-icon">
                      <AgentAvatar role={a.role} icon={a.icon} src={a.avatar} size={22} />
                    </span>
                    <span className="rail-title agent-tree-name">{a.name}</span>
                    {a.id === id && activeCount > 0 && (
                      <span className="agent-tree-count" aria-label={`${activeCount} active work session${activeCount === 1 ? "" : "s"}`}>
                        {activeCount}
                      </span>
                    )}
                    <ActivityIcon activity={a.activity} />
                  </button>
                  {open && hasThreads && (
                    <ul className="agent-threads" id={`agent-sessions-${a.id}`} aria-label={`${a.name} sessions`}>
                      {main && threadRow(main, false)}
                      {ordered.map((t) => threadRow(t, true))}
                      {inactive.length > 0 && (
                        <li>
                          <Button variant="ghost" size="sm" aria-expanded={showInactive} onClick={() => setShowInactive((v) => !v)}>
                            {showInactive ? "Hide" : "Show"} inactive sessions ({inactive.length})
                          </Button>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {team && (team.rows.length > 0 || team.error) && (
            <section className="agent-team-group" aria-labelledby="agent-team-head">
              <div className="agent-tree-head">
                <h2 id="agent-team-head">Team</h2>
              </div>
              {team.error && <p className="hint agent-team-error">{team.error}</p>}
              <ul className="agent-tree-list">
                {team.rows.map((t) => {
                  const rid = teamRouteId(t.id);
                  const host = t.host.name ?? "a teammate's machine";
                  return (
                    <li key={t.id}>
                      <a
                        className="rail-row agent-tree-row agent-team-row"
                        data-team={t.id}
                        data-selected={rid === id}
                        data-nav-item
                        data-nav-id={`agent-team-${t.id}`}
                        aria-current={rid === id ? "page" : undefined}
                        href={hrefOf(landingForTeam(t.id))}
                        title={`${t.title} · ${t.description}\nOn ${host}, shared by ${t.shared_by.display_name || t.shared_by.email}`}
                      >
                        <span className="agent-role-icon">
                          <AgentAvatar role={t.description} size={22} />
                        </span>
                        <span className="rail-text">
                          <span className="rail-title agent-tree-name">{t.title}</span>
                          <span className="agent-team-host">
                            {host} · {t.host.live ? "online" : "offline"}
                          </span>
                        </span>
                        <span className="rail-state" role="img" aria-label={t.host.live ? "Host online" : "Host offline"} title={t.host.live ? "Host online" : "Host offline"}>
                          <span className={`st-dot ${t.host.live ? "agent-team-live" : "st-closed"}`} />
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
        {menu &&<MoveMenu x={menu.x} y={menu.y} canStep={(by) => canStep(menu.row, by)} onStep={(by) => step(menu.row, by)} onDone={() => setMenu(null)} />}
      </nav>
      <div className="sv-main" data-nav-region="detail" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

type Row = { kind: "agent" | "thread"; id: string };

/** A row's right-click or long-press menu: move it up or down among those beside it. */
function MoveMenu({ x, y, canStep, onStep, onDone }: { x: number; y: number; canStep: (by: -1 | 1) => boolean; onStep: (by: -1 | 1) => void; onDone: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(true, onDone, [wrap]);
  // Kept on screen, as the session list's menu is.
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    wrap.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return (
    <div ref={wrap} className="rail-menu rail-rowmenu" role="menu" style={{ position: "fixed", ...at }}>
      {([-1, 1] as const).filter(canStep).map((by) => (
        <button
          key={by}
          type="button"
          role="menuitem"
          title={by === -1 ? "Alt+↑" : "Alt+↓"}
          onClick={() => {
            onStep(by);
            onDone();
          }}
        >
          <span className="rail-menu-check">{by === -1 ? <Icon.chevronUp size={12} /> : <Icon.chevronDown size={12} />}</span>
          {by === -1 ? "Move up" : "Move down"}
        </button>
      ))}
    </div>
  );
}
