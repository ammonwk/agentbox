import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentThread } from "../../../src/cloud/agent-conversation";
import { Button, Icon, RelativeTime, Spinner } from "../components";
import { go, hrefOf, parseHash, scopeOf } from "../route";
import { useIsNarrow } from "./session/useIsNarrow";
import { AgentAvatar } from "./AgentAvatar";
type AgentActivity = "working" | "approval" | "waiting" | "idle";
export type AgentOption = { id: string; name: string; detail: string; role: string; creator?: boolean; avatar?: string | null; activity: AgentActivity };
export const agentName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
export function agentActivity(enabled: boolean, statuses: readonly string[]): AgentActivity {
  if (statuses.some((s) => s === "blocked" || s === "uncertain")) return "approval";
  if (statuses.some((s) => ["running", "retrying", "starting", "queued"].includes(s))) return "working";
  if (!enabled) return "idle";
  return statuses.includes("waiting") ? "waiting" : "idle";
}
function ActivityIcon({ activity }: { activity: AgentActivity }) {
  const label = { working: "Active", approval: "Needs attention", waiting: "Waiting for you", idle: "Inactive" }[activity];
  return <span className="rail-state" data-state={activity} role="img" aria-label={label} title={label}>
    {activity === "working" ? <Spinner size={12} /> : activity === "approval" ? <Icon.alert size={13} /> : activity === "waiting" ? <Icon.clock size={13} /> : <span className="st-dot st-closed" />}
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
  const ordered = work.filter((t) => t.status !== "closed" || showClosed)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.at - a.at);
  const creator = options.find((a) => a.creator);
  return <div className="sv agent-browser" data-rail={narrow && route.view === "sessions" ? "full" : "on"} data-detail={route.view !== "sessions"}>
    <nav ref={rail} className="rail agent-tree" aria-label="Agent sessions" data-nav-region="list" onKeyDown={(e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
      const el = e.target as HTMLElement;
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
          {options.map((a) => {
            const open = a.id === id && expanded;
            const name = agentName(a.name);
            return <li key={a.id}>
              <button className="rail-row agent-tree-row" data-agent={a.id} data-selected={a.id === id} data-nav-item data-nav-id={`agent-${a.id}`} aria-expanded={a.id === id && ordered.length ? open : undefined} aria-controls={open && ordered.length ? `agent-sessions-${a.id}` : undefined} onClick={() => choose(a.id)} title={`${name} · ${a.role}\n${a.detail}`}>
                <span className="rail-title agent-tree-name">{name}</span>
                {a.id === id && activeCount > 0 && <span className="agent-tree-count" aria-label={`${activeCount}${more ? " or more" : ""} work sessions`}>{activeCount}{more ? "+" : ""}</span>}
                <ActivityIcon activity={a.activity} />
                <span className="agent-role-icon" role="img" aria-label={a.role} title={a.role}><AgentAvatar role={a.role} creator={a.creator} src={a.avatar} size={22} /></span>
              </button>
              {open && (work.length > 0 || showLoading || error || more) && <ul className="agent-threads" id={`agent-sessions-${a.id}`} aria-label={`${name} work sessions`}>
                {ordered.map((t) => <li key={t.id}><a className="rail-row" data-nav-item data-nav-id={`agent-session-${t.id}`} data-id={t.id} data-status={t.status} aria-current={route.thread === t.id && (!route.view || route.view === "chat" || route.view === "sessions") ? "page" : undefined} href={hrefOf({ page: "agents", id, view: "chat", thread: t.id })} title={`${t.title} · ${t.status}${t.writable ? "" : " · Read-only"}`}>
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
    </nav>
    <div className="sv-main" data-nav-region="detail" tabIndex={-1}>{children}</div>
  </div>;
}
