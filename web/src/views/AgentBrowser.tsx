import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import type { AgentThread } from "../../../src/cloud/agent-conversation";
import { Button, Icon, RelativeTime, Spinner } from "../components";
import { go, hrefOf, parseHash, scopeOf } from "../route";
import { useIsNarrow } from "./session/useIsNarrow";
import { AgentAvatar } from "./AgentAvatar";
import { halfOf, placeIn, ranksOf, readOrder, saveOrder, stepIn } from "../lib/manualorder";
import { useDismiss } from "./newsession/popover";
/** Your order of the agents, by workspace and project, and of each agent's
 *  work sessions, by agent (lib/manualorder.ts). */
const AGENT_ORDER_KEY = "agentbox.agentOrder";
const THREAD_ORDER_KEY = "agentbox.agentSessionOrder";
type AgentActivity = "working" | "approval" | "waiting" | "idle" | "paused";
export type AgentOption = { id: string; name: string; detail: string; role: string; creator?: boolean; avatar?: string | null; activity: AgentActivity };
export const agentName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
export function agentActivity(enabled: boolean, statuses: readonly string[]): AgentActivity {
  if (statuses.includes("paused")) return "paused";
  if (statuses.some((s) => s === "blocked" || s === "uncertain")) return "approval";
  if (statuses.some((s) => ["running", "retrying", "starting", "queued"].includes(s))) return "working";
  if (!enabled) return "paused";
  return statuses.includes("waiting") ? "waiting" : "idle";
}
function ActivityIcon({ activity }: { activity: AgentActivity }) {
  const label = { working: "Active", approval: "Needs attention", waiting: "Waiting for you", idle: "Inactive", paused: "Paused" }[activity];
  return <span className="rail-state" data-state={activity} role="img" aria-label={label} title={label}>
    {activity === "working" ? <Spinner size={12} /> : activity === "approval" ? <Icon.alert size={13} /> : activity === "waiting" ? <Icon.clock size={13} /> : activity === "paused" ? <Icon.pause size={13} /> : <span className="st-dot st-closed" />}
  </span>;
}

export function agentRoute() { const r = parseHash(location.hash); return r.page === "agents" ? r : { page: "agents" as const }; }
export function landingForAgent(id: string) {
  return { page: "agents" as const, id, view: "chat" as const, thread: "new" };
}
export function rememberAgent(id?: string) {
  const key = `agentbox.selectedAgent:${scopeOf().get("workspace") ?? ""}:${scopeOf().get("project") ?? ""}`;
  try { if (id) localStorage.setItem(key, id); return localStorage.getItem(key); } catch { return null; }
}
export function AgentBrowser({ id, options, threads, more, loadMore, error, children, onCreate, ongoing, loading }: {
  id: string; options: AgentOption[]; threads: AgentThread[]; more: boolean;
  onCreate?: () => void; ongoing?: string | null; loading: boolean;
  loadMore: () => void; error: string | null; children: ReactNode;
}) {
  const route = agentRoute();
  const narrow = useIsNarrow();
  const [expanded, setExpanded] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    setShowLoading(false);
    if (!loading) return;
    const timer = setTimeout(() => setShowLoading(true), 800);
    return () => clearTimeout(timer);
  }, [id, loading]);
  const [showClosed, setShowClosed] = useState(false);
  const rail = useRef<HTMLElement>(null), hadDetail = useRef(route.view !== "sessions");
  useEffect(() => { rememberAgent(id); }, [id]);
  useEffect(() => { setExpanded(true); }, [id, route.thread, route.view]);
  useEffect(() => { setShowClosed(false); }, [id]);
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
  const work = threads.filter((t) => t.kind !== "conversation" && t.id !== ongoing);
  const closed = work.filter((t) => t.status === "closed");
  const activeCount = work.length - closed.length;
  // Your order: the agents you placed first, then the rest as they come; an
  // agent's work sessions stay active first, and within that one you have
  // not placed comes first, the newest on top.
  const agentScope = `${scopeOf().get("workspace") ?? ""}:${scopeOf().get("project") ?? ""}`;
  const [agentOrder, setAgentOrder] = useState(() => ({ scope: agentScope, ids: readOrder(AGENT_ORDER_KEY, agentScope) }));
  const agentIds = useMemo(() => (agentOrder.scope === agentScope ? agentOrder.ids : readOrder(AGENT_ORDER_KEY, agentScope)), [agentOrder, agentScope]);
  const [threadOrder, setThreadOrder] = useState(() => ({ scope: id, ids: readOrder(THREAD_ORDER_KEY, id) }));
  const threadIds = useMemo(() => (threadOrder.scope === id ? threadOrder.ids : readOrder(THREAD_ORDER_KEY, id)), [threadOrder, id]);
  const agentRanks = ranksOf(agentIds), threadRanks = ranksOf(threadIds);
  const agents = [...options].sort((a, b) => (agentRanks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (agentRanks.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const ordered = work.filter((t) => t.status !== "closed" || showClosed)
    .sort((a, b) => Number(b.active) - Number(a.active) || (threadRanks.get(a.id) ?? -1) - (threadRanks.get(b.id) ?? -1) || b.at - a.at);
  const creator = options.find((a) => a.creator);
  // The rows beside each other: the agents, and each agent's active work and the rest.
  const siblingsOf = (row: Row): string[] => row.kind === "agent"
    ? agents.map((a) => a.id)
    : ordered.filter((t) => t.active === ordered.find((x) => x.id === row.id)?.active).map((t) => t.id);
  const place = (row: Row, next: string[] | null) => {
    if (!next) return false;
    if (row.kind === "agent") {
      const kept = next.filter((x) => options.some((a) => a.id === x));
      saveOrder(AGENT_ORDER_KEY, agentScope, kept);
      setAgentOrder({ scope: agentScope, ids: kept });
    } else {
      // Sessions not loaded yet keep their places.
      saveOrder(THREAD_ORDER_KEY, id, next);
      setThreadOrder({ scope: id, ids: next });
    }
    return true;
  };
  const step = (row: Row, by: -1 | 1) => place(row, stepIn(row.kind === "agent" ? agentIds : threadIds, siblingsOf(row), row.id, by));
  const canStep = (row: Row, by: -1 | 1) => { const sib = siblingsOf(row), i = sib.indexOf(row.id); return i !== -1 && sib[i + by] !== undefined; };
  // Dragging a row to a new place among those beside it: before or after the
  // row it is dropped on, by which half.
  const [drag, setDrag] = useState<Row | null>(null);
  const [over, setOver] = useState<{ id: string; at: "before" | "after" } | null>(null);
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null);
  const dnd = (row: Row) => ({
    draggable: true,
    "data-drop": over?.id === row.id ? over.at : undefined,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/x-agentbox-order", row.id);
      setDrag(row);
    },
    onDragEnd: () => { setDrag(null); setOver(null); },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.id === row.id || drag.kind !== row.kind || !siblingsOf(drag).includes(row.id)) return setOver(null);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver({ id: row.id, at: halfOf(e) });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (drag && drag.id !== row.id && drag.kind === row.kind && siblingsOf(drag).includes(row.id)) {
        place(drag, placeIn(drag.kind === "agent" ? agentIds : threadIds, siblingsOf(drag), drag.id, row.id, halfOf(e)));
      }
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
  return <div className="sv agent-browser" data-rail={narrow && route.view === "sessions" ? "full" : "on"} data-detail={route.view !== "sessions"}>
    <nav ref={rail} className="rail agent-tree" aria-label="Agent sessions" data-nav-region="list" onKeyDown={(e) => {
      const el = e.target as HTMLElement;
      // Alt+↑ and Alt+↓ move the focused row among those beside it, as a drag does.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && el.matches("[data-nav-item]")) {
        const row: Row | null = el.dataset.agent ? { kind: "agent", id: el.dataset.agent } : el.dataset.id ? { kind: "thread", id: el.dataset.id } : null;
        if (!row || !step(row, e.key === "ArrowUp" ? -1 : 1)) return;
        e.preventDefault(); e.stopPropagation();
        // The row is drawn again in its new place; keep the focus on it.
        const navId = el.dataset.navId;
        requestAnimationFrame(() => rail.current?.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(navId ?? "")}"]`)?.focus());
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
      if (!el.matches("[data-nav-item]")) return;
      const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]")], at = rows.indexOf(el);
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
      e.preventDefault(); e.stopPropagation();
    }}>
      <div className="agent-tree-head">
        <h2>Agents</h2>
        {(onCreate || creator) && <Button variant="ghost" size="sm" icon={Icon.plus} aria-label="New agent" title="New agent" onClick={() => { if (onCreate) onCreate(); else if (creator) go(landingForAgent(creator.id)); }} />}
        {onCreate && <a className="agent-manage" href={hrefOf({ page: "agents", id: "manage" })} aria-label="Manage shared agents" title="Manage shared agents"><Icon.settings size={16} /></a>}
      </div>
      <div className="rail-scroll">
        <ul className="agent-tree-list">
          {agents.map((a) => {
            const open = a.id === id && expanded;
            const name = agentName(a.name);
            return <li key={a.id}>
              <button {...dnd({ kind: "agent", id: a.id })} className="rail-row agent-tree-row" data-agent={a.id} data-selected={a.id === id} data-nav-item data-nav-id={`agent-${a.id}`} aria-expanded={a.id === id && ordered.length ? open : undefined} aria-controls={open && ordered.length ? `agent-sessions-${a.id}` : undefined} onClick={() => choose(a.id)} title={`${name} · ${a.role}\n${a.detail}`}>
                <span className="rail-title agent-tree-name">{name}</span>
                {a.id === id && activeCount > 0 && <span className="agent-tree-count" aria-label={`${activeCount}${more ? " or more" : ""} work sessions`}>{activeCount}{more ? "+" : ""}</span>}
                <ActivityIcon activity={a.activity} />
                <span className="agent-role-icon" role="img" aria-label={a.role} title={a.role}><AgentAvatar role={a.role} creator={a.creator} src={a.avatar} size={22} /></span>
              </button>
              {open && (work.length > 0 || showLoading || error || more) && <ul className="agent-threads" id={`agent-sessions-${a.id}`} aria-label={`${name} work sessions`}>
                {ordered.map((t) => <li key={t.id}><a {...dnd({ kind: "thread", id: t.id })} className="rail-row" data-nav-item data-nav-id={`agent-session-${t.id}`} data-id={t.id} data-status={t.status} aria-current={route.thread === t.id && (!route.view || route.view === "chat" || route.view === "sessions") ? "page" : undefined} href={hrefOf({ page: "agents", id, view: "chat", thread: t.id })} title={`${t.title} · ${t.status}${t.writable ? "" : " · Read-only"}`}>
                  <span className="rail-title">{t.title}</span><span className="rail-when">{t.at > 0 && <RelativeTime ts={t.at} short />}</span>
                  <ActivityIcon activity={agentActivity(true, [t.status])} />
                </a></li>)}
                {closed.length > 0 && <li><Button variant="ghost" size="sm" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>{showClosed ? "Hide" : "Show"} closed sessions ({closed.length})</Button></li>}
                {loading && showLoading && !threads.length && <li className="agent-tree-message" role="status">Loading sessions…</li>}
                {error && <li className="agent-tree-message error" role="alert">{error}</li>}
                {more && <li><Button variant="ghost" size="sm" onClick={loadMore}>Load more sessions</Button></li>}
              </ul>}
            </li>;
          })}
        </ul>
      </div>
      {menu && <MoveMenu x={menu.x} y={menu.y} canStep={(by) => canStep(menu.row, by)} onStep={(by) => step(menu.row, by)} onDone={() => setMenu(null)} />}
    </nav>
    <div className="sv-main" data-nav-region="detail" tabIndex={-1}>{children}</div>
  </div>;
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
  useEffect(() => { wrap.current?.querySelector<HTMLElement>("button")?.focus(); }, []);
  return <div ref={wrap} className="rail-menu rail-rowmenu" role="menu" style={{ position: "fixed", ...at }}>
    {([-1, 1] as const).filter(canStep).map((by) => (
      <button key={by} type="button" role="menuitem" title={by === -1 ? "Alt+↑" : "Alt+↓"} onClick={() => { onStep(by); onDone(); }}>
        <span className="rail-menu-check">{by === -1 ? <Icon.chevronUp size={12} /> : <Icon.chevronDown size={12} />}</span>
        {by === -1 ? "Move up" : "Move down"}
      </button>
    ))}
  </div>;
}
