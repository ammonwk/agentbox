/** The Agents page: the rail of agents, each with its picture and what it is
 *  doing, and under the open one its conversations; beside it the open one's
 *  Chat, its Feed (the page its program answers with) and its Settings
 *  (docs/agents.md). Opening any of it starts nothing; only sending does. */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { Heartbeat } from "@phosphor-icons/react/dist/csr/Heartbeat";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { api, type AgentActionReply } from "../api";
import type { AppState, AgentAction, AgentBlock, AgentField, AgentIcon, AgentInfo, AgentView, Session } from "../../../src/core/types";
import { Button, Empty, ErrorBoundary, Icon, RelativeTime, Spinner, Toggle } from "../components";
import { copyText } from "../bits";
import { go, hrefOf, SESSION_TABS, type AgentTab, type SessionTab } from "../route";
import { titleOf } from "../lib/board";
import { useScope } from "../lib/projects";
import { halfOf, placeIn, readOrder, saveOrder, stepIn } from "../lib/manualorder";
import { Detail } from "./session/SessionView";
import { Markdown } from "./session/Markdown";
import { loadDraft, newRevision, saveDraft } from "./session/drafts";
import { useIsNarrow } from "./session/useIsNarrow";
import { ScheduleItem } from "./Settings";
import "./agents.css";

const REMEMBER = "agentbox.agent";
const LIST_MS = 4_000;
/** Your order of the agents, by project (lib/manualorder.ts). */
const ORDER = "agentbox.agentOrder";

function useAgents(): { list: AgentInfo[] | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.agents().then(
        (l) => live && (setList(l), setError(null)),
        (e: Error) => live && setError(e.message),
      );
    void load();
    const t = setInterval(load, LIST_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [n]);
  return { list, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** A disabled agent, or one whose manifest cannot be read: listed last, never opened first. */
const resting = (a: AgentInfo) => !a.enabled || !!a.error;

export function Agents({ state, name, tab, sub }: { state: AppState; name: string | null; tab: AgentTab | null; sub: string | null }) {
  const { list, error, reload } = useAgents();
  const narrow = useIsNarrow();
  const { project } = useScope();
  const scope = project ?? "";
  const [order, setOrder] = useState(() => ({ scope, ids: readOrder(ORDER, scope) }));
  const ids = order.scope === scope ? order.ids : readOrder(ORDER, scope);
  // Those the project shows (its manifest's `projects`), awake ones first, each part in your order.
  const agents = useMemo(() => {
    const rank = new Map(ids.map((id, i) => [id, i]));
    return (list ?? [])
      .filter((a) => !project || !a.projects || a.projects.includes(project))
      .sort((a, b) => Number(resting(a)) - Number(resting(b)) || (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
  }, [list, project, ids]);
  const reorder = (next: string[]) => {
    saveOrder(ORDER, scope, next);
    setOrder({ scope, ids: next });
  };
  const selected = list?.find((a) => a.name === name) ?? null;

  // A computer opens straight onto the one last looked at; a phone shows the list first.
  useEffect(() => {
    if (name || narrow || !agents.length) return;
    const last = localStorage.getItem(REMEMBER);
    const pick = agents.find((a) => a.name === last) ?? agents.find((a) => !resting(a)) ?? agents[0]!;
    go({ page: "agents", name: pick.name, tab: null }, true);
  }, [name, narrow, agents]);
  useEffect(() => {
    if (selected) localStorage.setItem(REMEMBER, selected.name);
  }, [selected?.name]);

  const showList = !narrow || !name;
  const showPane = !narrow || !!name;
  return (
    <div className="ag" data-detail={name ? "on" : "off"}>
      {showList ? (
        <aside className="ag-list" aria-label="Agents" data-nav-region="list">
          {error && !list ? <p className="ag-note bad">Could not load the agents: {error}</p> : null}
          <Rail agents={agents} state={state} name={name} sub={tab ? null : sub} order={ids} reorder={reorder} />
          {list && !agents.length ? (
            <div className="ag-note">
              {list.length ? (
                <p>No agent shows in this project. An agent shows in the projects its manifest names (`projects`), or in every one when it names none.</p>
              ) : (
                <>
                  <p>No agents yet.</p>
                  <p>
                    Add one from its directory with <code>agentbox agent add &lt;dir&gt;</code>. The examples are in the agentbox checkout under{" "}
                    <code>agents/</code>; Jupiter writes new ones.
                  </p>
                </>
              )}
            </div>
          ) : null}
        </aside>
      ) : null}
      {showPane ? (
        <section className="ag-pane" data-nav-region="detail">
          {!list ? (
            <Empty title="Loading…" />
          ) : selected ? (
            <ErrorBoundary resetKey={selected.name} label="This agent">
              <Pane key={selected.name} info={selected} state={state} tab={tab} sub={sub} reload={reload} back={narrow} />
            </ErrorBoundary>
          ) : name ? (
            <Empty title="No such agent" action={<a className="btn" href={hrefOf({ page: "agents", name: null, tab: null })}>All agents</a>}>
              <p>
                Nothing here is called <code>{name}</code>. It may live on another machine, or it was removed.
              </p>
            </Empty>
          ) : (
            <Empty title="Pick an agent" />
          )}
        </section>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- rail

type Tone = "ok" | "busy" | "warn" | "bad" | "idle";

/** What an agent is doing, from its program and its main conversation. */
function statusOf(a: AgentInfo, main: Session | null): { label: string; tone: Tone } {
  if (a.error) return { label: "Manifest error", tone: "bad" };
  if (!a.enabled) return { label: "Disabled", tone: "idle" };
  const p = a.process;
  if (p?.state === "backoff") return { label: `Restarting${p.restarts ? ` (${p.restarts})` : ""}`, tone: "warn" };
  if (main?.question) return { label: "Asking you", tone: "warn" };
  if (main?.status === "blocked") return { label: "Needs you", tone: "warn" };
  if (main?.status === "running") return { label: "Working", tone: "busy" };
  if (p?.state === "stopped") return { label: "Stopped", tone: "warn" };
  if (main) return { label: "Available", tone: "ok" };
  if (a.canStart) return { label: "Ready to begin", tone: "idle" };
  return p ? { label: p.state === "running" ? "Running" : "Starting", tone: p.state === "running" ? "ok" : "idle" } : { label: "No conversation", tone: "idle" };
}

const toneOf = (s: Session | undefined): Tone =>
  !s ? "idle" : s.question || s.status === "blocked" ? "warn" : s.status === "running" ? "busy" : s.status === "closed" || s.status === "stopped" ? "idle" : "ok";

function StateMark({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="ag-state" role="img" aria-label={label} title={label}>
      {tone === "busy" ? <Spinner size={12} /> : tone === "warn" ? <Icon.alert size={13} /> : <span className={`ag-dot ${tone}`} />}
    </span>
  );
}

/** One of an agent's conversations: its main, a session it started under one of its mains, or an earlier main. */
type Thread = { id: string; session: Session | undefined; kind: "main" | "work" | "earlier" };

function threadsOf(info: AgentInfo, state: AppState): Thread[] {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const kids = new Map<string, Session[]>();
  for (const s of state.sessions) if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  const mains = [info.main, ...info.previous].filter((x): x is string => !!x);
  const seen = new Set(mains);
  const work: Session[] = [];
  const walk = (id: string) => {
    for (const k of kids.get(id) ?? []) if (!seen.has(k.id)) (seen.add(k.id), work.push(k), walk(k.id));
  };
  mains.forEach(walk);
  work.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return [
    ...(info.main ? [{ id: info.main, session: byId.get(info.main), kind: "main" as const }] : []),
    ...work.map((s) => ({ id: s.id, session: s, kind: "work" as const })),
    ...info.previous.map((id) => ({ id, session: byId.get(id), kind: "earlier" as const })),
  ];
}

const active = (t: Thread) => t.kind === "main" || (t.kind === "work" && t.session?.status !== "closed" && t.session?.status !== "stopped");

/** The agents in your order (drag one, or Alt+↑/↓), and the open one's conversations under it. */
function Rail({ agents, state, name, sub, order, reorder }: { agents: AgentInfo[]; state: AppState; name: string | null; sub: string | null; order: string[]; reorder: (ids: string[]) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ name: string; at: "before" | "after" } | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [name]);
  const list = useRef<HTMLUListElement>(null);
  // An agent moves among those beside it: the awake ones, or the resting ones.
  const siblingsOf = (n: string) => {
    const a = agents.find((x) => x.name === n);
    return agents.filter((x) => a && resting(x) === resting(a)).map((x) => x.name);
  };
  const step = (n: string, by: -1 | 1) => {
    const next = stepIn(order, siblingsOf(n), n, by);
    if (!next) return false;
    reorder(next);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(n)}"]`)?.focus());
    return true;
  };
  const dropOn = (target: string, e: DragEvent) => (drag && drag !== target && siblingsOf(drag).includes(target) ? halfOf(e) : null);
  return (
    <ul className="ag-rail" ref={list}>
      {agents.map((a) => {
        const main = a.main ? state.sessions.find((s) => s.id === a.main) ?? null : null;
        const st = statusOf(a, main);
        const open = a.name === name;
        const threads = open ? threadsOf(a, state) : [];
        const shown = threads.filter((t) => showAll || active(t));
        const hidden = threads.length - shown.length;
        return (
          <li key={a.name}>
            <a
              className={`ag-row${open ? " on" : ""}`}
              href={hrefOf({ page: "agents", name: a.name, tab: null })}
              aria-current={open && !sub ? "page" : undefined}
              data-agent={a.name}
              data-drop={over?.name === a.name ? over.at : undefined}
              draggable
              title={a.description || a.name}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/x-agentbox-order", a.name);
                setDrag(a.name);
              }}
              onDragEnd={() => (setDrag(null), setOver(null))}
              onDragOver={(e) => {
                const at = dropOn(a.name, e);
                if (!at) return setOver(null);
                e.preventDefault();
                setOver({ name: a.name, at });
              }}
              onDrop={(e) => {
                e.preventDefault();
                const at = dropOn(a.name, e);
                if (drag && at) reorder(placeIn(order, siblingsOf(drag), drag, a.name, at));
                setDrag(null);
                setOver(null);
              }}
              onKeyDown={(e) => {
                if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                if (step(a.name, e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
              }}
            >
              <AgentAvatar info={a} size={24} />
              <span className="ag-row-title">{a.title}</span>
              <StateMark tone={st.tone} label={st.label} />
            </a>
            {open && threads.length > 1 ? (
              <ul className="ag-threads" aria-label={`${a.title}'s conversations`}>
                {shown.map((t) => (
                  <li key={t.id}>
                    <a
                      className={`ag-thread${sub === t.id || (!sub && t.kind === "main") ? " on" : ""}`}
                      href={hrefOf({ page: "agents", name: a.name, tab: null, sub: t.kind === "main" ? null : t.id })}
                      aria-current={sub === t.id ? "page" : undefined}
                    >
                      <span className="ag-row-title">{t.kind === "main" ? "Main conversation" : t.session ? titleOf(t.session) : t.id}</span>
                      {t.kind === "earlier" ? <span className="ag-tag">earlier</span> : null}
                      {t.session ? <span className="ag-when"><RelativeTime ts={t.session.lastActivityAt} short /></span> : null}
                      <StateMark tone={toneOf(t.session)} label={t.session?.status ?? "closed"} />
                    </a>
                  </li>
                ))}
                {hidden > 0 || showAll ? (
                  <li>
                    <button type="button" className="ag-more" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? "Only the active ones" : `${hidden} closed and earlier`}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const ICONS: Record<AgentIcon, typeof Brain> = { brain: Brain, sparkle: Sparkle, fix: Wrench, release: Cloud, health: Heartbeat };

/** Its picture, else the icon its manifest names, else one from what it says it does. */
function AgentAvatar({ info, size }: { info: AgentInfo; size: number }) {
  const src = info.avatar ? `/api/agents/${encodeURIComponent(info.name)}/avatar?v=${info.avatar.at}` : null;
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) return <img className="ag-avatar" style={{ width: size, height: size }} src={src} alt="" onError={() => setFailed(src)} />;
  const d = info.description;
  const Glyph = info.icon ? ICONS[info.icon] : /deploy|release/i.test(d) ? Cloud : /health|monitor|performance/i.test(d) ? Heartbeat : /fix|triage|bug|repair/i.test(d) ? Wrench : Brain;
  return (
    <span className="ag-avatar icon" style={{ width: size, height: size }} aria-hidden>
      <Glyph size={Math.round(size * 0.58)} weight="duotone" />
    </span>
  );
}

// ------------------------------------------------------------------- pane

function Pane({ info, state, tab, sub, reload, back }: { info: AgentInfo; state: AppState; tab: AgentTab | null; sub: string | null; reload: () => void; back: boolean }) {
  const wide = useWide();
  // The page's first tab, also what says which tabs it has.
  const page = usePage(info, null);
  const tabs = page.view?.tabs ?? [];
  const main = info.main ? state.sessions.find((s) => s.id === info.main) ?? null : null;
  const status = statusOf(info, main);
  const badge = tabs.reduce((n, t) => n + (typeof t.badge === "number" ? t.badge : 0), 0);
  const feed = tab === "feed" && info.hasPage;
  // On a wide screen the page sits beside its main conversation.
  const beside = wide && info.hasPage && !tab && !sub;
  const [composeKey, setComposeKey] = useState(0);
  /** A page's "give guidance": its text goes into the main's box, after what is there. */
  const compose = async (text: string) => {
    const key = info.main ?? `agent:${info.name}`;
    const cur = loadDraft(key);
    await saveDraft(key, cur?.text ? `${cur.text}\n\n${text}` : text, cur?.images ?? [], newRevision());
    setComposeKey((k) => k + 1);
    if (!beside) go({ page: "agents", name: info.name, tab: null });
  };
  const to = (t: AgentTab | null, s: string | null = null) => go({ page: "agents", name: info.name, tab: t, sub: s }, true);

  return (
    <div className="ag-agent">
      <header className="ag-head">
        {back ? (
          <a className="ag-back" href={hrefOf({ page: "agents", name: null, tab: null })} aria-label="All agents">
            <Icon.chevronLeft size={16} />
          </a>
        ) : null}
        <AgentAvatar info={info} size={34} />
        <div className="ag-head-text">
          <h2>{info.title}</h2>
          {info.description ? <p className="ag-desc">{info.description}</p> : null}
        </div>
        <span className={`ag-pill ${status.tone}`}>{status.label}</span>
      </header>
      <nav className="ag-tabs" role="tablist" aria-label={`${info.title} views`}>
        <TabButton on={!tab} onClick={() => to(null)}>
          Chat
        </TabButton>
        {info.hasPage ? (
          <TabButton on={feed} onClick={() => to("feed")}>
            Feed
            {badge ? <span className="ag-badge">{badge}</span> : null}
          </TabButton>
        ) : null}
        <TabButton on={tab === "settings"} onClick={() => to("settings")}>
          Settings
        </TabButton>
      </nav>
      {feed && tabs.length > 1 ? (
        <div className="ag-subtabs" role="tablist" aria-label="Its feed">
          {tabs.map((t, i) => (
            <button key={t.id} type="button" role="tab" aria-selected={(sub ?? tabs[0]!.id) === t.id} onClick={() => to("feed", i ? t.id : null)}>
              {t.title}
              {t.badge != null && t.badge !== 0 && t.badge !== "" ? <span className="ag-badge">{t.badge}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className={`ag-body${beside ? " split" : ""}`}>
        {tab === "settings" ? (
          <AgentSettings info={info} state={state} main={main} reload={reload} />
        ) : feed ? (
          sub && sub !== tabs[0]?.id ? <TabPage key={sub} info={info} tab={sub} onCompose={compose} /> : <PagePanel info={info} page={page} tab={null} onCompose={compose} />
        ) : (
          <>
            <Chat key={`${sub}:${composeKey}`} info={info} state={state} sub={sub} reload={reload} />
            {beside ? <PagePanel info={info} page={page} tab={null} onCompose={compose} side /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={on} className="sx-tab" onClick={onClick}>
      {children}
    </button>
  );
}

function useWide(): boolean {
  const q = "(min-width: 1280px)";
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

// ------------------------------------------------------------------- chat

/** Its main conversation, or the one of its conversations picked in the rail, as a session's Timeline. */
function Chat({ info, state, sub, reload }: { info: AgentInfo; state: AppState; sub: string | null; reload: () => void }) {
  const [sessTab, setSessTab] = useState<SessionTab>(SESSION_TABS[0]!);
  const id = sub ?? info.main;
  const session = id ? state.sessions.find((s) => s.id === id) ?? null : null;
  if (session)
    return (
      <div className="ag-chat">
        <Detail key={session.id} session={session} state={state} tab={sessTab} onTab={setSessTab} onClose={(s) => void api.close(s.id, true)} />
      </div>
    );
  if (id)
    return (
      <div className="ag-chat">
        <Empty title="It is not on the board" action={<a className="btn" href={hrefOf({ page: "session", id, tab: "timeline" })}>Open {id}</a>}>
          <p>The conversation is closed or older than the board&apos;s window.</p>
        </Empty>
      </div>
    );
  if (info.canStart) return <StartChat info={info} onStarted={reload} />;
  return (
    <div className="ag-chat">
      <Empty title="No conversation yet">
        <p>
          {info.process
            ? "Its program starts its main conversation when it has something to talk about."
            : "Its manifest does not say how to start a main conversation (main.start)."}
        </p>
      </Empty>
    </div>
  );
}

/** The first message: agentbox starts the main conversation from the manifest. One send id per attempt, kept across a reload, so a retry never starts two. */
function StartChat({ info, onStarted }: { info: AgentInfo; onStarted: () => void }) {
  const key = `agent:${info.name}`;
  const pendingKey = `agentbox.agentStart.${info.name}`;
  const [text, setText] = useState(() => loadDraft(key)?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const save = (t: string) => {
    setText(t);
    void saveDraft(key, t, [], newRevision());
  };
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const sendId = localStorage.getItem(pendingKey) ?? newRevision();
    localStorage.setItem(pendingKey, sendId);
    try {
      await api.agentChat(info.name, text, sendId);
      localStorage.removeItem(pendingKey);
      void saveDraft(key, "", [], newRevision());
      onStarted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ag-start" onSubmit={send}>
      <Empty title={`Talk with ${info.title}`}>
        <p>Your first message starts its conversation{info.description ? `: ${info.description}` : "."}</p>
      </Empty>
      <div className="ag-start-box">
        <textarea
          ref={ref}
          value={text}
          rows={3}
          placeholder={`Message ${info.title}`}
          disabled={!info.enabled}
          onChange={(e) => save(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button variant="primary" icon={Icon.send} loading={busy} disabled={!text.trim() || !info.enabled} type="submit">
          Send
        </Button>
      </div>
      {!info.enabled ? <p className="ag-note">{info.title} is disabled. Turn it on in Settings to send.</p> : null}
      {error ? <p className="ag-note bad" role="alert">That did not send: {error}</p> : null}
    </form>
  );
}

// ------------------------------------------------------------------- page

function usePage(info: AgentInfo, tab: string | null) {
  const [view, setView] = useState<AgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const running = info.hasPage && (!info.process || info.process.state === "running");
  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api.agentView(info.name, tab).then(
        (v) => {
          if (!live) return;
          setView(v);
          setError(null);
          timer = setTimeout(load, Math.max(2, v?.refresh ?? 15) * 1000);
        },
        (e: Error) => {
          if (!live) return;
          setError(e.message);
          timer = setTimeout(load, 15_000);
        },
      );
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [info.name, tab, running, n]);
  return { view, setView, error, running, reload: () => setN((x) => x + 1) };
}

type Page = ReturnType<typeof usePage>;

function TabPage({ info, tab, onCompose }: { info: AgentInfo; tab: string | null; onCompose: (text: string) => void }) {
  const page = usePage(info, tab);
  return <PagePanel info={info} page={page} tab={tab} onCompose={onCompose} />;
}

function PagePanel({ info, page, tab, onCompose, side }: { info: AgentInfo; page: Page; tab: string | null; onCompose: (text: string) => void; side?: boolean }) {
  const { view, setView, error, running, reload } = page;
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const act = async (a: AgentAction, values: Record<string, unknown>) => {
    if (a.confirm && !confirm(a.confirm)) return;
    setMessage(null);
    try {
      const reply: AgentActionReply = (await api.agentAction(info.name, { action: a.id, values: { ...a.values, ...values }, tab })) ?? {};
      if (reply.view) setView(reply.view);
      else reload();
      if (reply.message) setMessage({ text: reply.message, bad: false });
      if (reply.compose) onCompose(reply.compose);
      if (reply.open) location.hash = reply.open.replace(/^#?/, "#");
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  };
  return (
    <div className={`ag-page${side ? " side" : ""}`}>
      {!running ? (
        <Empty title="Its program is not running">
          <p>Its Settings tab shows its state and the end of its output.</p>
        </Empty>
      ) : error && !view ? (
        <p className="ag-note bad">Its page did not load: {error}</p>
      ) : !view ? (
        <Empty title="Loading…" />
      ) : (
        <>
          {view.title ? <h3 className="ag-page-title">{view.title}</h3> : null}
          {message ? (
            <p className={`ag-note ${message.bad ? "bad" : "ok"}`} role={message.bad ? "alert" : "status"}>
              {message.text}
            </p>
          ) : null}
          {error ? <p className="ag-note bad">The last refresh failed: {error}</p> : null}
          <Blocks blocks={view.blocks} act={act} />
        </>
      )}
    </div>
  );
}

type Act = (a: AgentAction, values: Record<string, unknown>) => Promise<void>;

function Blocks({ blocks, act }: { blocks: AgentBlock[]; act: Act }) {
  return (
    <>
      {(blocks ?? []).map((b, i) => (
        <BlockView key={("id" in b && b.id) || i} block={b} act={act} />
      ))}
    </>
  );
}

function BlockView({ block: b, act }: { block: AgentBlock; act: Act }) {
  switch (b.type) {
    case "heading":
      return <h4 className="ag-h">{b.text}</h4>;
    case "markdown":
      return (
        <div className="ag-md">
          <Markdown text={b.text} />
        </div>
      );
    case "divider":
      return <hr className="ag-hr" />;
    case "fields":
      return (
        <dl className="ag-fields">
          {b.items.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>
                <Markdown text={f.value} inline />
              </dd>
            </div>
          ))}
        </dl>
      );
    case "actions":
      return <Actions actions={b.actions} act={act} values={() => ({})} />;
    case "form":
      return <FormBlock form={b} act={act} />;
    case "text":
      return <TextBlock block={b} />;
    case "split":
      return <SplitBlock block={b} act={act} />;
    case "switch":
      return <SwitchBlock block={b} act={act} />;
    case "item":
      return <ItemBlock block={b} act={act} />;
    default:
      return null;
  }
}

/** A choice the browser keeps for a block across refreshes and tab changes: by the block's id, for this tab's life. */
function useKept<T extends string | boolean>(id: string | undefined, initial: T): [T, (v: T) => void] {
  const key = id ? `agentbox.block.${id}` : null;
  const [v, setV] = useState<T>(() => {
    const got = key ? sessionStorage.getItem(key) : null;
    return got === null ? initial : (typeof initial === "boolean" ? got === "true" : got) as T;
  });
  return [
    v,
    (next: T) => {
      setV(next);
      if (key) sessionStorage.setItem(key, String(next));
    },
  ];
}

function TextBlock({ block: b }: { block: Extract<AgentBlock, { type: "text" }> }) {
  const [wrap, setWrap] = useState(b.wrap ?? true);
  const [copied, setCopied] = useState(false);
  const lines = b.text ? b.text.split("\n").length : 0;
  return (
    <figure className="ag-text">
      <figcaption>
        <span className="ag-text-title">{b.title ?? ""}</span>
        <span className="ag-text-size">
          {lines.toLocaleString()} line{lines === 1 ? "" : "s"} · {b.text.length.toLocaleString()} chars
        </span>
        <button type="button" className="ag-text-btn" aria-pressed={wrap} onClick={() => setWrap(!wrap)} title="Wrap long lines">
          wrap
        </button>
        <button
          type="button"
          className="ag-text-btn"
          onClick={() => void copyText(b.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
          title="Copy all of it"
        >
          {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />}
        </button>
      </figcaption>
      <pre className={wrap ? "wrap" : undefined} style={{ maxHeight: b.maxHeight ?? 480 }} tabIndex={0}>
        {b.text}
      </pre>
    </figure>
  );
}

function SplitBlock({ block: b, act }: { block: Extract<AgentBlock, { type: "split" }>; act: Act }) {
  const narrow = useIsNarrow();
  const [chosen, choose] = useKept<string>(b.id, b.selected ?? b.items[0]?.id ?? "");
  // On a phone the list comes first; choosing opens the pane, and back returns to the list.
  const [open, setOpen] = useState(false);
  const item = b.items.find((x) => x.id === chosen) ?? b.items[0];
  if (!item) return null;
  const showList = !narrow || !open;
  const showPane = !narrow || open;
  return (
    <section className="ag-split" data-panes={narrow ? "one" : "two"}>
      {showList ? (
        <nav className="ag-split-list" aria-label={b.title ?? "Entries"}>
          {b.title ? <h4 className="ag-split-head">{b.title}</h4> : null}
          <ul>
            {b.items.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  className="ag-split-row"
                  aria-current={x.id === item.id}
                  onClick={() => {
                    choose(x.id);
                    setOpen(true);
                  }}
                >
                  <span className="ag-split-top">
                    {x.status ? <span className={`ag-dot ${x.status}`} aria-label={x.status} /> : null}
                    <span className="ag-split-name">{x.title}</span>
                    {x.badge != null && x.badge !== "" ? <span className="ag-split-badge">{x.badge}</span> : null}
                  </span>
                  {x.subtitle ? <span className="ag-split-sub">{x.subtitle}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {showPane ? (
        <div className="ag-split-pane" aria-label={item.title}>
          {narrow ? (
            <button type="button" className="ag-split-back" onClick={() => setOpen(false)}>
              <Icon.chevronLeft size={14} /> {b.title ?? "All"}
            </button>
          ) : null}
          <h3 className="ag-split-title">{item.title}</h3>
          <Blocks key={item.id} blocks={item.blocks} act={act} />
        </div>
      ) : null}
    </section>
  );
}

function SwitchBlock({ block: b, act }: { block: Extract<AgentBlock, { type: "switch" }>; act: Act }) {
  const [chosen, choose] = useKept<string>(b.id, b.selected ?? b.options[0]?.id ?? "");
  const opt = b.options.find((o) => o.id === chosen) ?? b.options[0];
  if (!opt) return null;
  return (
    <div className="ag-switch">
      <div className="ag-switch-bar" role="tablist">
        {b.options.map((o) => (
          <button key={o.id} type="button" role="tab" aria-selected={o.id === opt.id} onClick={() => choose(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <Blocks key={opt.id} blocks={opt.blocks} act={act} />
    </div>
  );
}

function ItemBlock({ block: b, act }: { block: Extract<AgentBlock, { type: "item" }>; act: Act }) {
  const folds = b.collapsed !== undefined;
  const [folded, setFolded] = useKept<boolean>(folds ? b.id : undefined, b.collapsed ?? false);
  const head = (
    <>
      {folds ? <Icon.chevronRight size={13} className={`ag-fold${folded ? "" : " open"}`} /> : null}
      {b.status ? <span className={`ag-dot ${b.status}`} aria-label={b.status} /> : null}
      <span className="ag-item-title">{b.title}</span>
      {b.subtitle ? <span className="ag-item-sub">{b.subtitle}</span> : null}
    </>
  );
  return (
    <article className={`ag-item ${b.status ?? ""}${folds ? " folds" : ""}`}>
      {folds ? (
        <header>
          <button type="button" className="ag-item-toggle" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            {head}
          </button>
        </header>
      ) : (
        <header>{head}</header>
      )}
      {folded ? null : (
        <>
          {b.body ? (
            <div className="ag-md">
              <Markdown text={b.body} />
            </div>
          ) : null}
          {b.sessions?.length || b.links?.length ? (
            <div className="ag-item-links">
              {b.sessions?.map((id) => (
                <a key={id} href={hrefOf({ page: "session", id, tab: "timeline" })}>
                  <Icon.terminal size={12} /> {id}
                </a>
              ))}
              {b.links?.map((l, i) =>
                /^https?:/.test(l.url) || l.url.startsWith("#") ? (
                  <a key={i} href={l.url} target={l.url.startsWith("#") ? undefined : "_blank"} rel="noreferrer">
                    {l.url.startsWith("#") ? null : <Icon.external size={12} />} {l.label}
                  </a>
                ) : null,
              )}
            </div>
          ) : null}
          {b.children?.length ? (
            <div className="ag-item-children">
              <Blocks blocks={b.children} act={act} />
            </div>
          ) : null}
          {b.actions?.length ? <Actions actions={b.actions} act={act} values={() => ({})} /> : null}
        </>
      )}
    </article>
  );
}

function Actions({ actions, act, values }: { actions: AgentAction[]; act: Act; values: () => Record<string, unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="ag-actions">
      {actions.map((a) => (
        <Button
          key={a.id}
          size="sm"
          type="button"
          variant={a.style === "primary" ? "primary" : a.style === "danger" ? "danger" : "default"}
          loading={busy === a.id}
          disabled={!!busy}
          onClick={async () => {
            setBusy(a.id);
            try {
              await act(a, values());
            } finally {
              setBusy(null);
            }
          }}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

function FormBlock({ form, act }: { form: Extract<AgentBlock, { type: "form" }>; act: Act }) {
  const initial = () => Object.fromEntries(form.fields.map((f) => [f.name, f.value ?? (f.kind === "checkbox" ? false : "")]));
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  // A page that changed what the form holds (after an action) shows it; what you are typing is kept otherwise.
  const shape = JSON.stringify(form.fields.map((f) => [f.name, f.value]));
  const last = useRef(shape);
  useEffect(() => {
    if (last.current !== shape) {
      last.current = shape;
      setValues(initial());
    }
  }, [shape]);
  const set = (name: string, v: unknown) => setValues((x) => ({ ...x, [name]: v }));
  return (
    <form className="ag-form" onSubmit={(e) => e.preventDefault()}>
      {form.fields.map((f) => (
        <FieldView key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
      ))}
      <Actions actions={form.actions} act={act} values={() => values} />
    </form>
  );
}

function FieldView({ field: f, value, onChange }: { field: AgentField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ag-f-${f.name}`;
  if (f.kind === "checkbox")
    return (
      <label className="ag-check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {f.label}
      </label>
    );
  return (
    <label className="ag-field" htmlFor={id}>
      <span>{f.label}</span>
      {f.kind === "textarea" ? (
        <textarea id={id} rows={f.rows ?? 5} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : f.kind === "select" ? (
        <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}


// --------------------------------------------------------------- settings

/** What it is, whether it runs, and what speaks to it. What it does is its directory's to say. */
function AgentSettings({ info, state, main, reload }: { info: AgentInfo; state: AppState; main: Session | null; reload: () => void }) {
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = info.process;
  useEffect(() => {
    if (!p) return;
    let live = true;
    const load = () => api.agentLog(info.name).then((l) => live && setLog(l.text), () => undefined);
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [info.name, !!p]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const schedules = state.schedules.filter((s) => s.agent === info.name);
  const projects = info.projects?.map((id) => state.repos.find((r) => r.id === id)?.displayName ?? id);
  return (
    <div className="ag-about">
      {info.error ? <p className="ag-note bad">{info.error}</p> : null}
      <div className="ag-picture">
        <AgentAvatar info={info} size={64} />
        <div className="ag-actions">
          <label className={`btn btn-sm${busy ? " disabled" : ""}`}>
            {info.avatar ? "Replace picture" : "Upload a picture"}
            <input
              type="file"
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp"
              disabled={busy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) return setError("A picture is at most 2 MB");
                void run(() => api.agentAvatar(info.name, file));
              }}
            />
          </label>
          {info.avatar ? (
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.agentAvatar(info.name, null))}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      {info.description ? (
        <div className="ag-md">
          <Markdown text={info.description} />
        </div>
      ) : null}
      <Toggle checked={info.enabled} label={info.enabled ? "Enabled" : "Disabled: its program is stopped and its main takes no messages"} disabled={busy} onChange={(on) => void run(() => api.agentPatch(info.name, { enabled: on }))} />
      <dl className="ag-fields">
        <div>
          <dt>Directory</dt>
          <dd className="mono">{info.dir}</dd>
        </div>
        <div>
          <dt>Shows in</dt>
          <dd>{projects ? projects.join(", ") || "No project" : "Every project"}</dd>
        </div>
        <div>
          <dt>Main conversation</dt>
          <dd>
            {info.main ? <a href={hrefOf({ page: "session", id: info.main, tab: "timeline" })}>{info.main}</a> : info.canStart ? "Started by your first message" : "None yet"}
            {main ? ` · ${[main.provider, main.model].filter(Boolean).join(" ")}` : null}
          </dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd>
            {p
              ? `${p.state}${p.pid ? `, pid ${p.pid}` : ""}${p.restarts ? `, ${p.restarts} restart${p.restarts === 1 ? "" : "s"}` : ""}${p.lastExit ? `; last exit ${p.lastExit.code ?? "signal"}` : ""}`
              : "None: it is a conversation, or runs elsewhere"}
            {p?.since ? (
              <>
                {" "}
                · since <RelativeTime ts={p.since} />
              </>
            ) : null}
          </dd>
        </div>
      </dl>
      {p ? (
        <div className="ag-actions">
          <Button size="sm" icon={Icon.refresh} loading={busy} onClick={() => void run(() => api.agentRestart(info.name))}>
            Restart its program
          </Button>
        </div>
      ) : null}
      {error ? <p className="ag-note bad">{error}</p> : null}
      <h4 className="ag-h">What speaks to it</h4>
      {schedules.length ? (
        <ul className="sched-list">
          {schedules.map((sc) => (
            <ScheduleItem key={sc.id} sc={sc} state={state} />
          ))}
        </ul>
      ) : (
        <p className="ag-note">
          No schedule. <code>agentbox schedule "every weekday at 9am" --to {info.name} &lt;what to say&gt;</code> gives it one.
        </p>
      )}
      <p className="ag-note">
        Change it by changing its directory (ask your coding agent, or Jupiter), then <code>agentbox agent add {info.dir}</code> to read the manifest
        again. <code>agentbox agent rm {info.name}</code> forgets it and leaves the directory.
      </p>
      {p ? (
        <>
          <h4 className="ag-h">Its output</h4>
          <pre className="ag-log">{log === null ? "…" : log.slice(-20_000) || "(nothing yet)"}</pre>
        </>
      ) : null}
    </div>
  );
}
