import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentThread } from "../../../src/cloud/agent-conversation";
import { Button, Modal, RelativeTime } from "../components";
import { go, hrefOf, parseHash, scopeOf } from "../route";
import { RailTabs } from "./session/Rail";
export type AgentOption = { id: string; name: string; detail: string; role: string; creator?: boolean };
export function agentRoute() { const r = parseHash(location.hash); return r.page === "agents" ? r : { page: "agents" as const }; }
export function landingForAgent(id: string) {
  return { page: "agents" as const, id, view: "chat" as const, thread: "new" };
}
export function rememberAgent(id?: string) {
  const key = `agentbox.selectedAgent:${scopeOf().get("workspace") ?? ""}:${scopeOf().get("project") ?? ""}`;
  try { if (id) localStorage.setItem(key, id); return localStorage.getItem(key); } catch { return null; }
}
export function AgentBrowser({ id, options, threads, counts, more, loadMore, error, children, onCreate, ongoing }: {
  id: string; options: AgentOption[]; threads: AgentThread[]; counts: { active: number; inactive: number }; more: boolean;
  onCreate?: () => void; ongoing?: string | null;
  loadMore: () => void; error: string | null; children: ReactNode;
}) {
  const route = agentRoute(), selected = options.find((a) => a.id === id);
  const [picker, setPicker] = useState(false), [query, setQuery] = useState("");
  const [view, setView] = useState<"active" | "inactive">("active");
  const rail = useRef<HTMLElement>(null), hadDetail = useRef(route.view !== "sessions");
  useEffect(() => { rememberAgent(id); }, [id]);
  useEffect(() => {
    const t = threads.find((t) => t.id === route.thread);
    if (t) setView(t.active ? "active" : "inactive");
  }, [route.thread, threads.find((t) => t.id === route.thread)?.active]);
  useEffect(() => {
    if (hadDetail.current && route.view === "sessions") rail.current?.querySelector<HTMLAnchorElement>('[aria-current="page"], .rail-row')?.focus();
    hadDetail.current = route.view !== "sessions";
  }, [route.view]);
  const choose = (a: AgentOption) => { setPicker(false); setQuery(""); go(landingForAgent(a.id)); };
  const visible = options.filter((a) => `${a.name} ${a.detail} ${a.role}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sv agent-browser" data-rail="on" data-detail={route.view !== "sessions"}>
    <nav ref={rail} className="rail" aria-label="Agent sessions" data-nav-region="list" onKeyDown={(e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
      const el = e.target as HTMLElement;
      if (!el.classList.contains("rail-row")) return;
      const rows = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>(".rail-row")], at = rows.indexOf(el as HTMLAnchorElement);
      if (e.key === "ArrowDown") rows[at + 1]?.focus();
      else if (e.key === "ArrowUp") (rows[at - 1] ?? e.currentTarget.querySelector<HTMLButtonElement>(".agent-picker"))?.focus();
      else if (e.key === "ArrowRight") el.click(); else return;
      e.preventDefault(); e.stopPropagation();
    }}>
      <div className="rail-top"><button className="agent-picker" onClick={() => setPicker(true)} aria-label="Select agent" aria-haspopup="dialog"><span>{selected?.name ?? "Select agent"}<small>{selected?.detail}</small></span><span>⌄</span></button></div>
      <a className="rail-row agent-main-row" aria-current={route.thread === ongoing || route.thread === "new" ? "page" : undefined} href={hrefOf({ page: "agents", id, view: "chat", thread: ongoing ?? "new" })}><span className="rail-title">Main chat</span></a>
      <RailTabs view={view} counts={counts} onChange={setView} />
      <div className="rail-scroll">
        {threads.filter((t) => t.active === (view === "active")).map((t) => <a key={t.id} className="rail-row" data-id={t.id} data-status={t.status} aria-current={route.thread === t.id ? "page" : undefined} href={hrefOf({ page: "agents", id, view: "chat", thread: t.id })} title={`${t.title} · ${t.status}${t.writable ? "" : " · Read-only"}`}>
          <span className="rail-title">{t.title}</span><span className="rail-when">{t.at > 0 && <RelativeTime ts={t.at} />}</span><span className="agent-row-status" aria-label={t.status}>{t.status === "running" ? "●" : t.writable ? "◷" : "○"}</span>
        </a>)}
        {!threads.some((t) => t.active === (view === "active")) && <p className="rail-none">{error || `No ${view} sessions.`}</p>}
        {more && <Button variant="ghost" onClick={loadMore}>Load more sessions</Button>}
      </div>
      <div className="agent-rail-actions">
        <a href={hrefOf({ page: "agents", id, view: "chat", thread: ongoing ?? "new" })}>Open chat</a>
        <a href={hrefOf({ page: "agents", id, view: "about" })}>About</a><a href={hrefOf({ page: "agents", id, view: "feed" })}>Feed</a>
      </div>
    </nav>
    <div className="sv-main"><button className="agent-mobile-picker" onClick={() => setPicker(true)} aria-label="Select agent">{selected?.name ?? "Select agent"} ⌄</button>{children}</div>
    {picker && <Modal title="Choose agent" onClose={() => setPicker(false)}>
      <input className="input" autoFocus aria-label="Search agents" placeholder="Search agents…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".project-option")?.focus(); }
        if (e.key === "Enter" && visible.length === 1) { e.preventDefault(); choose(visible[0]!); }
      }} />
      <div className="project-options" onKeyDown={(e) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")], at = rows.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault(); rows[e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }}>{visible.map((a) => <button className="project-option" key={a.id} aria-pressed={id === a.id} onClick={() => choose(a)}><span><strong>{a.name}</strong><small>{a.detail}</small><small>{a.role}</small></span></button>)}</div>
      {(onCreate || options.some((a) => a.creator)) && <Button onClick={() => { setPicker(false); if (onCreate) onCreate(); else { const a = options.find((a) => a.creator)!; go({ page: "agents", id: a.id, view: "chat", thread: "new" }); } }}>Create agent…</Button>}
      <a href="#/agents/manage">Manage shared agents</a>
    </Modal>}
  </div>;
}
