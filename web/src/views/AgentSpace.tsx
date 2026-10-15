/** One superagent's space: its header (picture, title, status, the Chat /
 *  Feed / Settings tabs), and the tab shown. Chat is its conversation, read
 *  from the provider's transcript like a session's Timeline; Feed is its
 *  program's page and its daily closes; Settings is what it is and how it runs. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AppState, Session, SuperagentInfo } from "../../../src/core/types";
import type { SweepRecord } from "../../../src/core/superagent/state";
import { readSent } from "../../../src/core/sent";
import { api, useTimeline, type HelpReceipt } from "../api";
import { Button, Empty } from "../components";
import { useLoad } from "../lib/cloud";
import { go, hrefOf } from "../route";
import { AGENT_TABS, type AgentTab } from "../lib/agentviews";
import { UI_REVISION } from "../build";
import { AgentAvatar, avatarUrl } from "./AgentAvatar";
import { agentRoute, landingForAgent, type AgentThread } from "./AgentBrowser";
import { feedBadge, PagePanel, usePage, type Page } from "./AgentPage";
import { AgentSettings } from "./AgentSettings";
import { AgentComposer, composerMode } from "./session/Composer";
import { ComposerInput, ComposerSend } from "./session/ComposerInput";
import { loadDraft, newRevision, saveDraft } from "./session/drafts";
import { followChatSize, followsAfterScroll, onChatSubmitted } from "./session/scroll";
import { SessionFacts } from "./session/SessionFacts";
import { AgentConversationEvents, type ChatEcho } from "./session/Timeline";

/** What the header says the agent is doing: Nate's words for its main
 *  conversation, and the program's own states when they matter more. */
export function agentStatus(info: SuperagentInfo, main: Session | null): { label: string; tone: "ok" | "busy" | "warn" | "bad" | "idle" } {
  if (info.error) return { label: "Manifest error", tone: "bad" };
  if (!info.enabled) return { label: "Disabled", tone: "idle" };
  const p = info.process;
  if (p?.state === "backoff") return { label: `Restarting${p.restarts ? ` (${p.restarts})` : ""}`, tone: "warn" };
  if (p?.state === "stopped") return { label: "Stopped", tone: "warn" };
  if (main?.question) return { label: "Asking you a question", tone: "warn" };
  if (main?.status === "running") return { label: "Working", tone: "busy" };
  if (main?.status === "blocked") return { label: "Needs you", tone: "warn" };
  if (info.main) return { label: "Available", tone: "ok" };
  if (info.canStart) return { label: "Ready to begin", tone: "idle" };
  if (p?.state === "starting") return { label: "Starting", tone: "idle" };
  return p ? { label: "Running", tone: "ok" } : { label: "No conversation", tone: "idle" };
}

/** The draft key of the box a message goes to: the main's composer, or the first-message box. */
const chatKey = (info: SuperagentInfo) => (info.main ? `agent:${info.name}:${info.main}` : `superagent:${info.name}`);

export function AgentSpace({ info, state, threads, viewed, reload }: { info: SuperagentInfo; state: AppState; threads: AgentThread[]; viewed: string | null; reload: () => Promise<void> }) {
  const route = agentRoute();
  const tab: AgentTab = route.view === "feed" ? "feed" : route.view === "settings" ? "settings" : "chat";
  useEffect(() => {
    if (!route.view) go({ ...landingForAgent(info.name), ...(route.thread ? { thread: route.thread } : {}) }, true);
  }, [info.name, route.view]);
  const home = usePage(info, null);
  const badge = feedBadge(home.view);
  const thread = threads.find((t) => t.id === viewed) ?? null;
  const session = viewed ? (state.sessions.find((s) => s.id === viewed) ?? null) : null;
  const main = info.main ? (state.sessions.find((s) => s.id === info.main) ?? null) : null;
  const status = agentStatus(info, main);
  const work = thread?.kind === "work" && tab === "chat";
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const setTab = (view: AgentTab) => go({ page: "agents", id: info.name, view, ...(view !== "feed" && route.thread ? { thread: route.thread } : {}) });
  /** A page's "give guidance": its text goes into the chat's box, after what is there. */
  const compose = async (text: string) => {
    const key = chatKey(info);
    const cur = loadDraft(key);
    await saveDraft(key, cur?.text ? `${cur.text}\n\n${text}` : text, cur?.images ?? [], newRevision());
    go({ page: "agents", id: info.name, view: "chat" });
  };
  const close = async () => {
    if (!session) return;
    setClosing(true);
    setCloseError(null);
    try {
      await api.close(session.id, true);
      go({ page: "agents", id: info.name, view: "chat" });
    } catch (e) {
      setCloseError((e as Error).message);
    } finally {
      setClosing(false);
    }
  };
  return (
    <div className={`agent-space agent-space-${tab}`}>
      <header className="agent-space-head">
        <a href={hrefOf({ page: "agents", id: info.name, view: "sessions", ...(route.thread ? { thread: route.thread } : {}) })} className="hint agent-list-back" data-nav-back aria-label="Back to the agents">
          ← Agents
        </a>
        <div className="agent-identity">
          <AgentAvatar role={info.description} icon={info.icon} src={avatarUrl(info)} size={28} />
          <div className="agent-heading">
            <h2>{work ? thread!.title : info.title}</h2>
            {!work && info.description && <span className="agent-description">{info.description.trim().split(/\s+/).slice(0, 10).join(" ")}</span>}
          </div>
          <span className="agent-status" data-tone={status.tone}>
            {status.label}
          </span>
        </div>
        <nav aria-label="Agent views">
          {work && session && session.status !== "closed" && (
            <Button variant="ghost" size="sm" loading={closing} onClick={() => void close()}>
              Close session
            </Button>
          )}
          {AGENT_TABS.map((t) => (
            <button key={t} type="button" className={tab === t ? "active" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
              {t === "feed" && badge > 0 && <span aria-label={`${badge} in its feed`}>{badge}</span>}
            </button>
          ))}
        </nav>
      </header>
      {closeError && (
        <p className="error agent-space-error" role="alert">
          {closeError}
        </p>
      )}
      {tab === "settings" ? (
        <div className="agent-about agent-settings">
          <AgentSettings info={info} state={state} reload={reload} />
        </div>
      ) : tab === "feed" ? (
        <Feed info={info} home={home} tab={route.tab ?? null} onCompose={(t) => void compose(t)} />
      ) : viewed ? (
        <ThreadChat key={viewed} info={info} state={state} sessionId={viewed} session={session} kind={thread?.kind ?? "work"} />
      ) : info.canStart ? (
        <StartChat info={info} onStarted={reload} />
      ) : (
        <div className="agent-chat-scroll">
          <div className="agent-conversation-width agent-chat-empty">
            <h3>No conversation yet</h3>
            <p>
              {info.hasPage
                ? "Its program starts its main conversation when it has something to talk about."
                : "Its manifest says neither how to start a main conversation (main.start) nor which schedule's session it is (main.schedule)."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- chat

const HELP = /^\/help(?:\s+([\s\S]*))?$/;

/** `/help <feedback>` from the chat box: a report to agentbox's issue tracker, not a message to the agent. */
async function helpReport(info: SuperagentInfo, text: string | undefined, request: string, target: string | null, publish: number[] = []): Promise<HelpReceipt> {
  if (!text?.trim())
    return {
      state: "sent",
      result: `Write /help and then the problem or the improvement. For example: /help ${info.title} asks for permission after I approved the work. Your text and the agent and session identifiers go to a GitHub issue in ammonwk/agentbox. The conversation stays here.`,
    };
  return api.superagentHelp(info.name, { request, text: text.trim(), target, uiRevision: UI_REVISION, ...(publish.length ? { publish } : {}) });
}

function HelpResult({ r }: { r: HelpReceipt }) {
  return (
    <p className="agent-help-result" role="status">
      {r.issue ? (
        <>
          Created{" "}
          <a href={r.issue} target="_blank" rel="noreferrer">
            Agentbox issue #{r.issue.split("/").at(-1)}
          </a>
          .{r.note && <> {r.note}</>}
        </>
      ) : (
        r.result
      )}
    </p>
  );
}

/** A submission's receipt as the agent composer reads it. */
const asReceipt = (r: { state: string; error: string | null }) => ({
  state: r.state === "sent" ? "sent" : r.state === "failed" ? "refused" : r.state === "unconfirmed" ? "unconfirmed" : "queued",
  result: r.error ?? "",
});

/**
 * One of its conversations, from the provider's transcript (`useTimeline`):
 * the messages and the questions it asked, the question it asks now as a
 * card, and the box. A message goes through the Sessions submit path, with a
 * receipt, so a reload or a lost answer never sends it twice.
 */
function ThreadChat({ info, state, sessionId, session, kind }: { info: SuperagentInfo; state: AppState; sessionId: string; session: Session | null; kind: AgentThread["kind"] }) {
  const tl = useTimeline(sessionId);
  const events = tl.events;
  const composerId = `${info.name}:${sessionId}`;
  const [echoes, setEchoes] = useState<ChatEcho[]>([]);
  const [help, setHelp] = useState<HelpReceipt | null>(null);
  const question = session?.question ? { sessionId, ask: session.question } : null;
  const identity = state.onboarding.identity;
  const me = identity ? { name: identity.name ?? "", github: identity.github ?? "" } : undefined;
  // Sent or Read under your newest message, and the dots while its turn is open.
  const presence = useMemo(() => {
    let message: string | null = null,
      read = false;
    for (const e of events) {
      if (e.kind === "user" && !e.sender && !readSent(e.text).agent) {
        message = e.id;
        read = false;
      } else if (message && e.kind !== "user" && e.kind !== "meta") read = true;
    }
    return { message, read, working: session?.status === "running", queued: session?.queued?.map((q) => q.text) ?? [] };
  }, [events, session?.status, session?.queued]);
  const shownEchoes = echoes
    .filter((x) => !events.some((e) => e.kind === "user" && e.at >= x.at - 60_000 && e.text.includes(x.text.trim())))
    // Delivered mid-turn and held by the agent: its queue says so, not a guess.
    .map((x) => (x.note === "Sent" && presence.queued.some((q) => q.trim() === x.text.trim()) ? { ...x, note: "Queued" } : x));

  const scroller = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    lastTop = useRef(0),
    anchor = useRef<number | null>(null);
  const [submitted, setSubmitted] = useState(0);
  const scrolledSubmission = useRef(0);
  // A question shows from its top, as in a session's Timeline: following the
  // chat's size would scroll a card taller than the view past it.
  const asking = useRef(question);
  asking.current = question;
  useEffect(() => {
    const el = scroller.current;
    if (el) return followChatSize(el, () => pinned.current && !asking.current);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current,
      card = el?.querySelector<HTMLElement>(".ask-live");
    if (!el || !card || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
    const over = el.getBoundingClientRect().top + 8 - card.getBoundingClientRect().top;
    if (over > 0) el.scrollTop -= over;
  }, [question?.ask.id, tl.ready]);
  useEffect(
    () =>
      onChatSubmitted(`agent:${composerId}`, () => {
        anchor.current = null;
        setSubmitted((n) => n + 1);
      }),
    [composerId],
  );
  // Older pages go above what is shown: keep the reader's place.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) {
      if (scrolledSubmission.current !== submitted) pinned.current = true;
      if (pinned.current && !asking.current) el.scrollTop = el.scrollHeight;
      else if (anchor.current !== null) el.scrollTop = el.scrollHeight - anchor.current;
      scrolledSubmission.current = submitted;
      lastTop.current = el.scrollTop;
    }
    anchor.current = null;
  }, [events, echoes, submitted]);
  const earlier = !tl.exhausted && events.length > 0;
  const loadEarlier = () => {
    if (!earlier || tl.loadingOlder) return;
    const el = scroller.current;
    if (el && !pinned.current) anchor.current = el.scrollHeight - el.scrollTop;
    tl.loadOlder();
  };

  const mode = session ? composerMode(session) : null;
  const send = async (body: string, request: string, publish: number[] = []) => {
    const h = HELP.exec(body.trim());
    if (h) {
      const r = await helpReport(info, h[1], request, sessionId, publish);
      setHelp(r);
      return r;
    }
    setEchoes((xs) => [...xs, { id: request, text: body, at: Date.now(), note: "Sending…" }]);
    try {
      // A person's message ends a running turn first, as the agent chat always did (#25).
      const r = asReceipt(await api.submit(sessionId, request, mode?.kind === "resume" ? "resume" : "send", body, true));
      // Refused: the composer keeps the draft and says why; nothing was sent.
      setEchoes((xs) => (r.state === "refused" ? xs.filter((x) => x.id !== request) : xs.map((x) => (x.id === request ? { ...x, note: r.state === "sent" ? "Sent" : "Not confirmed" } : x))));
      return r;
    } catch (e) {
      setEchoes((xs) => xs.filter((x) => x.id !== request));
      throw e;
    }
  };
  /** A pending send's receipt: a submission's, else a /help report's. */
  const receipt = async (request: string) => {
    const r = await api.submission(sessionId, request);
    if (r) return asReceipt(r);
    const h = await api.superagentHelpReceipt(info.name, request).catch(() => null);
    if (h?.issue) setHelp(h);
    return h;
  };

  return (
    <>
      <div
        className="agent-chat-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          pinned.current = followsAfterScroll(el, pinned.current, lastTop.current);
          // Scrolled up to the top: the next page loads by itself.
          if (el.scrollTop < 200 && el.scrollTop < lastTop.current) loadEarlier();
          lastTop.current = el.scrollTop;
        }}
      >
        <div className="agent-conversation-width">
          {earlier && (
            <Button variant="ghost" loading={tl.loadingOlder} onClick={loadEarlier}>
              Earlier messages
            </Button>
          )}
          {!events.length && !question && (
            <div className="agent-chat-empty">
              <h3>{tl.ready ? "No messages yet" : "Loading conversation…"}</h3>
              <p>{tl.ready ? "Share a task, ask a question, or shape what to work on next." : "Reading the conversation from its transcript."}</p>
            </div>
          )}
          <AgentConversationEvents
            events={events}
            me={me}
            agent={{ name: info.title, role: info.description, icon: info.icon, avatar: avatarUrl(info) }}
            presence={presence}
            echoes={shownEchoes}
            question={question}
          />
          {tl.error && (
            <p className="agent-chat-notice" role="status">
              {tl.error}
            </p>
          )}
        </div>
      </div>
      <div className="agent-conversation-width agent-compose-wrap">
        {help && <HelpResult r={help} />}
        {kind === "earlier" ? (
          <div className="agent-chat-notice">
            Read-only: an earlier conversation of {info.title}.{" "}
            {info.main && <a href={hrefOf({ page: "agents", id: info.name, view: "chat" })}>Open the current conversation</a>}
          </div>
        ) : !session ? (
          <div className="agent-chat-notice">
            {kind === "main" ? "Its conversation is starting, or it is not on the board now." : "This session is not on the board now."}{" "}
            <a href={hrefOf({ page: "session", id: sessionId, tab: "timeline" })}>Open {sessionId}</a>
          </div>
        ) : mode?.kind === "adopt" || mode?.kind === "subagent" ? (
          <div className="agent-chat-notice">
            {mode.kind === "adopt" ? "It runs in a terminal agentbox did not start, so it is read-only here." : "A subagent: its parent session steers it."}{" "}
            <a href={hrefOf({ page: "session", id: sessionId, tab: "timeline" })}>Open the session</a>
          </div>
        ) : (
          <AgentComposer key={composerId} id={composerId} attachments name={info.title} send={send} receipt={receipt} disabled={!info.enabled} />
        )}
        {kind !== "earlier" && session && !info.enabled && <p className="agent-chat-notice">{info.title} is disabled. Turn it on in Settings to send.</p>}
        {session && <SessionFacts session={session} state={state} />}
        <p className="agent-help-hint">
          <code>/help &lt;feedback&gt;</code> reports a problem or an improvement to Agentbox on GitHub.
        </p>
      </div>
    </>
  );
}

/** The first message: agentbox starts the main conversation from the
 *  manifest. One send id per attempt, kept across a reload, so a retry never
 *  starts two. */
function StartChat({ info, onStarted }: { info: SuperagentInfo; onStarted: () => Promise<void> }) {
  const key = chatKey(info);
  const pendingKey = `agentbox.superagentStart.${info.name}`;
  const [text, setText] = useState(() => loadDraft(key)?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState<HelpReceipt | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const save = (t: string) => {
    setText(t);
    void saveDraft(key, t, [], newRevision());
  };
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy || !info.enabled) return;
    setBusy(true);
    setError(null);
    const sendId = localStorage.getItem(pendingKey) ?? newRevision();
    localStorage.setItem(pendingKey, sendId);
    try {
      const h = HELP.exec(text.trim());
      if (h) {
        const r = await helpReport(info, h[1], sendId, null);
        setHelp(r);
        // Refused: nothing was filed. The text stays, and a new attempt takes a new id.
        if (r.state === "refused") return localStorage.removeItem(pendingKey);
      } else {
        await api.superagentChat(info.name, text, sendId);
        await onStarted();
      }
      localStorage.removeItem(pendingKey);
      save("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="agent-chat-scroll">
        <div className="agent-conversation-width agent-chat-empty">
          <h3>Talk with {info.title}</h3>
          <p>Your first message starts its conversation. Share a task, ask a question, or shape what to work on next.</p>
        </div>
      </div>
      <div className="agent-conversation-width agent-compose-wrap">
        {help && <HelpResult r={help} />}
        <form className="cmp agent-composer" data-multi={text.includes("\n") || text.length > 90 || undefined} onSubmit={send}>
          {error && (
            <p className="error" role="alert">
              That did not send: {error}
            </p>
          )}
          <div className="cmp-row">
            <div className="att-frame cmp-frame">
              <ComposerInput
                textareaRef={ref}
                onSend={() => void send()}
                aria-label={`Message ${info.title}`}
                placeholder={`Message ${info.title}`}
                value={text}
                disabled={!info.enabled}
                onChange={(e) => save(e.target.value)}
              />
              <div className="cmp-tools">
                <ComposerSend type="submit" aria-label="Send" disabled={!text.trim() || !info.enabled} loading={busy} data-ready={text.trim() ? true : undefined} />
              </div>
            </div>
          </div>
        </form>
        {!info.enabled && <p className="agent-chat-notice">{info.title} is disabled. Turn it on in Settings to send.</p>}
        <p className="agent-help-hint">
          <code>/help &lt;feedback&gt;</code> reports a problem or an improvement to Agentbox on GitHub.
        </p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------- feed

/** Feed: its program's page, with the page's own tabs as a row of their own,
 *  and the daily closes of its idle work sessions, newest first. */
function Feed({ info, home, tab, onCompose }: { info: SuperagentInfo; home: Page; tab: string | null; onCompose: (text: string) => void }) {
  const tabs = home.view?.tabs ?? [];
  const first = tabs[0]?.id ?? null;
  const current = tab && tabs.some((t) => t.id === tab) ? tab : first;
  const sweeps = useLoad(() => api.superagentSweeps(info.name), [info.name]);
  useEffect(() => {
    const t = setInterval(() => void sweeps.reload(), 30_000);
    return () => clearInterval(t);
  }, [sweeps.reload]);
  const closes = [...(sweeps.data ?? [])].sort((a, b) => b.at - a.at);
  const onFirst = current === first;
  return (
    <div className="agent-feed">
      {info.hasPage ? (
        <>
          {tabs.length > 1 && (
            <div className="agent-feed-tabs" role="tablist" aria-label={`${info.title} pages`}>
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={current === t.id}
                  onClick={() => go({ page: "agents", id: info.name, view: "feed", ...(t.id === first ? {} : { tab: t.id }) }, true)}
                >
                  {t.title}
                  {t.badge != null && t.badge !== 0 && t.badge !== "" && <span>{t.badge}</span>}
                </button>
              ))}
            </div>
          )}
          {onFirst ? <PagePanel info={info} page={home} tab={null} onCompose={onCompose} /> : <TabPage key={current} info={info} tab={current} onCompose={onCompose} />}
        </>
      ) : !closes.length ? (
        <Empty title="Nothing in its feed yet">
          <p>
            {info.title} has no page: its manifest names no program (<code>run</code> or <code>url</code>).
            {info.sweep ? ` Its daily close at ${info.sweep} puts what it closed here.` : ""}
          </p>
        </Empty>
      ) : (
        <p className="hint">{info.title} has no page: its manifest names no program. Its daily closes are below.</p>
      )}
      {sweeps.error && <p className="error">{sweeps.error}</p>}
      {onFirst && closes.map((s) => <SweepCard key={s.id} s={s} />)}
    </div>
  );
}

function TabPage({ info, tab, onCompose }: { info: SuperagentInfo; tab: string | null; onCompose: (text: string) => void }) {
  const page = usePage(info, tab);
  return <PagePanel info={info} page={page} tab={tab} onCompose={onCompose} />;
}

/** One daily close (src/core/superagent/sweep.ts): what it closed, and what it kept open and why. */
function SweepCard({ s }: { s: SweepRecord }) {
  const when = new Date(s.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const entry = (e: { id: string; title: string; why?: string }) => (
    <li key={e.id}>
      <a href={hrefOf({ page: "session", id: e.id, tab: "timeline" })}>{e.title}</a>
      {e.why && <span className="hint"> {e.why}</span>}
    </li>
  );
  return (
    <article className="agent-sweep card">
      <div className="agent-sweep-head">
        <h3>{s.closed.length ? `Closed ${s.closed.length} idle session${s.closed.length === 1 ? "" : "s"}` : `Kept ${s.kept.length} idle session${s.kept.length === 1 ? "" : "s"} open`}</h3>
        <small>Daily close · {when}</small>
      </div>
      {s.closed.length > 0 && (
        <>
          <p className="hint">Each was idle for at least two hours. A closed session keeps its transcript: open it to read it or resume it.</p>
          <ul>{s.closed.map(entry)}</ul>
        </>
      )}
      {s.kept.length > 0 && (
        <>
          <h4>Kept open</h4>
          <ul>{s.kept.map(entry)}</ul>
        </>
      )}
    </article>
  );
}
