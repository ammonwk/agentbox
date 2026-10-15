/** The Agents page: each superagent with its main conversation, its own page
 *  (blocks its program answers with), its sessions, and what it is
 *  (docs/superagents.md). Opening any of it starts nothing; only sending does. */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type SuperagentActionReply } from "../api";
import type { AppState, SuperagentAction, SuperagentBlock, SuperagentField, SuperagentInfo, SuperagentView } from "../../../src/core/types";
import { Button, Empty, ErrorBoundary, Icon, RelativeTime } from "../components";
import { go as goTo, hrefOf as hrefTo, SESSION_TABS, type Route, type SessionTab } from "../route";
import { titleOf } from "../lib/board";
import { Detail } from "./session/SessionView";
import { Markdown } from "./session/Markdown";
import { loadDraft, newRevision, saveDraft } from "./session/drafts";
import { useIsNarrow } from "./session/useIsNarrow";
import "./agents.css";

const REMEMBER = "agentbox.agent";
const LIST_MS = 4_000;

function useSuperagents(): { list: SuperagentInfo[] | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<SuperagentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.superagents().then(
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

/** This page's own `{name, tab}` as the app's route: Chat, a page tab under
 *  Feed, Sessions, or About (Settings). */
type Place = { page: "agents"; name: string | null; tab: string | null };
function routeOf(p: Place): Route {
  if (!p.name) return { page: "agents" };
  if (p.tab === null) return { page: "agents", id: p.name };
  if (p.tab === "sessions") return { page: "agents", id: p.name, view: "sessions" };
  if (p.tab === "about") return { page: "agents", id: p.name, view: "settings" };
  return { page: "agents", id: p.name, view: "feed", tab: p.tab };
}
const go = (p: Place | Route, replace?: boolean) => goTo("name" in p ? routeOf(p) : p, replace);
const hrefOf = (p: Place | Route) => hrefTo("name" in p ? routeOf(p) : p);

export function Agents({ state, route }: { state: AppState; route: Extract<Route, { page: "agents" }> }) {
  const name = route.id ?? null;
  const tab = route.view === "sessions" ? "sessions" : route.view === "settings" ? "about" : route.view === "feed" ? (route.tab ?? "page") : null;
  const { list, error, reload } = useSuperagents();
  const narrow = useIsNarrow();
  const [q, setQ] = useState("");
  const selected = list?.find((a) => a.name === name) ?? null;

  // A computer opens straight onto the one last looked at; a phone shows the list first.
  useEffect(() => {
    if (name || narrow || !list?.length) return;
    const last = localStorage.getItem(REMEMBER);
    const pick = list.find((a) => a.name === last) ?? list[0]!;
    go({ page: "agents", name: pick.name, tab: null }, true);
  }, [name, narrow, list]);
  useEffect(() => {
    if (selected) localStorage.setItem(REMEMBER, selected.name);
  }, [selected?.name]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter((a) => !needle || [a.name, a.title, a.description].some((x) => x.toLowerCase().includes(needle)));
  }, [list, q]);

  const showList = !narrow || !name;
  const showPane = !narrow || !!name;
  return (
    <div className="ag" data-detail={name ? "on" : "off"}>
      {showList ? (
        <aside className="ag-list" aria-label="Agents" data-nav-region="list">
          <div className="ag-search">
            <Icon.search size={14} />
            <input data-search placeholder="Find an agent" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an agent" />
          </div>
          {error && !list ? <p className="ag-note bad">Could not load the agents: {error}</p> : null}
          <ul>
            {shown.map((a) => (
              <li key={a.name}>
                <a className={`ag-row${a.name === name ? " on" : ""}`} href={hrefOf({ page: "agents", name: a.name, tab: null })}>
                  <span className={`ag-dot ${dotOf(a, state)}`} aria-hidden />
                  <span className="ag-row-text">
                    <span className="ag-row-title">{a.title}</span>
                    <span className="ag-row-sub">{a.error ? "Its manifest cannot be read" : a.description || a.name}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {list && !list.length ? (
            <div className="ag-note">
              <p>No superagents yet.</p>
              <p>
                Add one from its directory with <code>agentbox superagent add &lt;dir&gt;</code>. The examples are in the agentbox checkout under{" "}
                <code>superagents/</code>; Jupiter writes new ones.
              </p>
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
              <Pane key={selected.name} info={selected} state={state} tab={tab} reload={reload} back={narrow} />
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

function dotOf(a: SuperagentInfo, state: AppState): string {
  if (a.error) return "bad";
  if (!a.enabled) return "idle";
  if (a.process?.state === "backoff") return "warn";
  const main = a.main ? state.sessions.find((s) => s.id === a.main) : null;
  if (main?.status === "running") return "busy";
  if (main?.status === "blocked") return "warn";
  return a.process?.state === "running" || main ? "ok" : "idle";
}

// ------------------------------------------------------------------- pane

function Pane({ info, state, tab, reload, back }: { info: SuperagentInfo; state: AppState; tab: string | null; reload: () => void; back: boolean }) {
  const wide = useWide();
  // The page's first tab, also what says which tabs it has.
  const page = usePage(info, null);
  const tabs = page.view?.tabs ?? (info.hasPage ? [{ id: "page", title: "Page" }] : []);
  const current = tab ?? "chat";
  // On a wide screen the page sits beside the chat, so its first tab is not a tab of its own.
  const beside = wide && info.hasPage && current === "chat";
  const [composeKey, setComposeKey] = useState(0);
  const compose = async (text: string) => {
    const main = info.main;
    const key = main ?? `superagent:${info.name}`;
    const cur = loadDraft(key);
    await saveDraft(key, cur?.text ? `${cur.text}\n\n${text}` : text, cur?.images ?? [], newRevision());
    setComposeKey((k) => k + 1);
    if (current !== "chat" && !beside) go({ page: "agents", name: info.name, tab: null });
  };
  const to = (t: string | null) => go({ page: "agents", name: info.name, tab: t }, true);

  return (
    <div className="ag-agent">
      <header className="ag-head">
        {back ? (
          <a className="ag-back" href={hrefOf({ page: "agents", name: null, tab: null })} aria-label="All agents">
            <Icon.chevronLeft size={16} />
          </a>
        ) : null}
        <div className="ag-head-text">
          <h2>{info.title}</h2>
          {info.description ? <p className="ag-desc">{info.description}</p> : null}
        </div>
        <ProcessPill info={info} />
      </header>
      <nav className="ag-tabs" role="tablist" aria-label={`${info.title} views`}>
        <TabButton on={current === "chat"} onClick={() => to(null)}>
          Chat
        </TabButton>
        {tabs.map((t, i) =>
          beside && i === 0 ? null : (
            <TabButton key={t.id} on={current === t.id} onClick={() => to(t.id)}>
              {t.title}
              {t.badge != null && t.badge !== 0 && t.badge !== "" ? <span className="ag-badge">{t.badge}</span> : null}
            </TabButton>
          ),
        )}
        <TabButton on={current === "sessions"} onClick={() => to("sessions")}>
          Sessions
        </TabButton>
        <TabButton on={current === "about"} onClick={() => to("about")}>
          About
        </TabButton>
      </nav>
      <div className={`ag-body${beside ? " split" : ""}`}>
        {current === "chat" ? (
          <>
            <Chat key={composeKey} info={info} state={state} reload={reload} />
            {beside ? <PagePanel info={info} page={page} tab={null} onCompose={compose} side /> : null}
          </>
        ) : current === "sessions" ? (
          <SessionsList info={info} state={state} />
        ) : current === "about" ? (
          <About info={info} reload={reload} />
        ) : (
          <TabPage info={info} tab={current === "page" ? null : current} onCompose={compose} />
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

function ProcessPill({ info }: { info: SuperagentInfo }) {
  if (info.error) return <span className="ag-pill bad">Manifest error</span>;
  if (!info.enabled) return <span className="ag-pill idle">Disabled</span>;
  const p = info.process;
  if (!p) return null;
  const label = p.state === "running" ? "Running" : p.state === "backoff" ? `Restarting${p.restarts ? ` (${p.restarts})` : ""}` : p.state === "starting" ? "Starting" : "Stopped";
  return <span className={`ag-pill ${p.state === "running" ? "ok" : p.state === "backoff" ? "warn" : "idle"}`}>{label}</span>;
}

// ------------------------------------------------------------------- chat

function Chat({ info, state, reload }: { info: SuperagentInfo; state: AppState; reload: () => void }) {
  const [sessTab, setSessTab] = useState<SessionTab>(SESSION_TABS[0]!);
  const main = info.main ? state.sessions.find((s) => s.id === info.main) ?? null : null;
  const earlier = info.previous.length ? (
    <div className="ag-earlier">
      Earlier conversations:{" "}
      {info.previous.slice(0, 6).map((id, i) => (
        <span key={id}>
          {i ? ", " : null}
          <a href={hrefOf({ page: "session", id, tab: "timeline" })}>{sessionName(state, id)}</a>
        </span>
      ))}
      {info.previous.length > 6 ? <span className="muted"> and {info.previous.length - 6} more on the Sessions tab</span> : null}
    </div>
  ) : null;
  if (main)
    return (
      <div className="ag-chat">
        {earlier}
        <Detail
          key={main.id}
          session={main}
          state={state}
          tab={sessTab}
          onTab={setSessTab}
          onClose={(s) => void api.close(s.id, true)}
        />
      </div>
    );
  if (info.main)
    return (
      <div className="ag-chat">
        {earlier}
        <Empty title="Its conversation is not on the board" action={<a className="btn" href={hrefOf({ page: "session", id: info.main, tab: "timeline" })}>Open {info.main}</a>}>
          <p>The main conversation is closed or older than the board&apos;s window.</p>
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
            : "Its manifest says neither how to start a main conversation nor which schedule's session it is."}
        </p>
      </Empty>
    </div>
  );
}

/** The first message: agentbox starts the main conversation from the manifest. One send id per attempt, kept across a reload, so a retry never starts two. */
function StartChat({ info, onStarted }: { info: SuperagentInfo; onStarted: () => void }) {
  const key = `superagent:${info.name}`;
  const pendingKey = `agentbox.superagentStart.${info.name}`;
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
      await api.superagentChat(info.name, text, sendId);
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
          onChange={(e) => save(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button variant="primary" icon={Icon.send} loading={busy} disabled={!text.trim()} type="submit">
          Send
        </Button>
      </div>
      {error ? <p className="ag-note bad" role="alert">That did not send: {error}</p> : null}
    </form>
  );
}

function sessionName(state: AppState, id: string): string {
  const s = state.sessions.find((x) => x.id === id);
  return s ? titleOf(s) : id;
}

// ------------------------------------------------------------------- page

function usePage(info: SuperagentInfo, tab: string | null) {
  const [view, setView] = useState<SuperagentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const running = info.hasPage && (!info.process || info.process.state === "running");
  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api.superagentView(info.name, tab).then(
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

function TabPage({ info, tab, onCompose }: { info: SuperagentInfo; tab: string | null; onCompose: (text: string) => void }) {
  const page = usePage(info, tab);
  return <PagePanel info={info} page={page} tab={tab} onCompose={onCompose} />;
}

function PagePanel({ info, page, tab, onCompose, side }: { info: SuperagentInfo; page: Page; tab: string | null; onCompose: (text: string) => void; side?: boolean }) {
  const { view, setView, error, running, reload } = page;
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const act = async (a: SuperagentAction, values: Record<string, unknown>) => {
    if (a.confirm && !confirm(a.confirm)) return;
    setMessage(null);
    try {
      const reply: SuperagentActionReply = (await api.superagentAction(info.name, { action: a.id, values: { ...a.values, ...values }, tab })) ?? {};
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
          <p>The About tab shows its state and the end of its output.</p>
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

type Act = (a: SuperagentAction, values: Record<string, unknown>) => Promise<void>;

function Blocks({ blocks, act }: { blocks: SuperagentBlock[]; act: Act }) {
  return (
    <>
      {(blocks ?? []).map((b, i) => (
        <BlockView key={("id" in b && b.id) || i} block={b} act={act} />
      ))}
    </>
  );
}

function BlockView({ block: b, act }: { block: SuperagentBlock; act: Act }) {
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
    case "item":
      return (
        <article className={`ag-item ${b.status ?? ""}`}>
          <header>
            {b.status ? <span className={`ag-dot ${b.status}`} aria-label={b.status} /> : null}
            <span className="ag-item-title">{b.title}</span>
            {b.subtitle ? <span className="ag-item-sub">{b.subtitle}</span> : null}
          </header>
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
        </article>
      );
    default:
      return null;
  }
}

function Actions({ actions, act, values }: { actions: SuperagentAction[]; act: Act; values: () => Record<string, unknown> }) {
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

function FormBlock({ form, act }: { form: Extract<SuperagentBlock, { type: "form" }>; act: Act }) {
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

function FieldView({ field: f, value, onChange }: { field: SuperagentField; value: unknown; onChange: (v: unknown) => void }) {
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

// --------------------------------------------------------------- sessions

/** Its main conversations, and what each started, at any depth: newest activity first. */
function SessionsList({ info, state }: { info: SuperagentInfo; state: AppState }) {
  const rows = useMemo(() => {
    const roots = new Set([info.main, ...info.previous].filter((x): x is string => !!x));
    const kids = new Map<string, string[]>();
    for (const s of state.sessions) if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s.id]);
    const all = new Set<string>();
    const walk = (id: string) => {
      if (all.has(id)) return;
      all.add(id);
      for (const k of kids.get(id) ?? []) walk(k);
    };
    roots.forEach(walk);
    return state.sessions.filter((s) => all.has(s.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }, [info.main, info.previous, state.sessions]);
  if (!rows.length)
    return (
      <Empty title="No sessions yet">
        <p>Its main conversation and every session it starts under it are listed here.</p>
      </Empty>
    );
  return (
    <ul className="ag-sessions">
      {rows.map((s) => (
        <li key={s.id}>
          <a href={hrefOf({ page: "session", id: s.id, tab: "timeline" })}>
            <span className={`ag-dot ${s.status === "running" ? "busy" : s.status === "blocked" ? "warn" : s.status === "closed" || s.status === "stopped" ? "idle" : "ok"}`} aria-hidden />
            <span className="ag-row-text">
              <span className="ag-row-title">
                {titleOf(s)}
                {s.id === info.main ? <span className="ag-tag">main</span> : info.previous.includes(s.id) ? <span className="ag-tag">earlier main</span> : null}
              </span>
              <span className="ag-row-sub">
                {s.provider} · {s.status} · <RelativeTime ts={s.lastActivityAt} />
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ about

function About({ info, reload }: { info: SuperagentInfo; reload: () => void }) {
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.superagentLog(info.name).then((l) => live && setLog(l.text), () => undefined);
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [info.name]);
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
  const p = info.process;
  return (
    <div className="ag-about">
      {info.description ? (
        <div className="ag-md">
          <Markdown text={info.description} />
        </div>
      ) : null}
      {info.error ? <p className="ag-note bad">{info.error}</p> : null}
      <dl className="ag-fields">
        <div>
          <dt>Name</dt>
          <dd className="mono">{info.name}</dd>
        </div>
        <div>
          <dt>Directory</dt>
          <dd className="mono">{info.dir}</dd>
        </div>
        <div>
          <dt>Main conversation</dt>
          <dd>{info.main ? <a href={hrefOf({ page: "session", id: info.main, tab: "timeline" })}>{info.main}</a> : info.canStart ? "Started by your first message" : "None yet"}</dd>
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
      <div className="ag-actions">
        {p ? (
          <Button size="sm" icon={Icon.refresh} loading={busy} onClick={() => void run(() => api.superagentRestart(info.name))}>
            Restart its program
          </Button>
        ) : null}
        <Button size="sm" variant={info.enabled ? "default" : "primary"} disabled={busy} onClick={() => void run(() => api.superagentPatch(info.name, { enabled: !info.enabled }))}>
          {info.enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      {error ? <p className="ag-note bad">{error}</p> : null}
      <p className="ag-note">
        Change it by changing its directory (ask your coding agent, or Jupiter), then <code>agentbox superagent add {info.dir}</code> to read the manifest
        again. <code>agentbox superagent rm {info.name}</code> forgets it and leaves the directory.
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
