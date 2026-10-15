/** Team agents on the Agents page (docs/agents.md, Team agents): a
 *  superagent that another machine of the workspace hosts and shares, seen
 *  through the encrypted live relay (lib/teamagents.ts). Its Chat is read
 *  only, with a box for guidance; its Feed is its program's page, whose
 *  actions reach the program as `via: "team"`; its Settings say what it is
 *  and where to copy it from. A teammate never gets a terminal or a session.
 *
 *  `TeamShare` is the other side: the Team section of a local agent's
 *  Settings, where the host owner shares it or ends the share. */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { HumanCloud } from "../../../src/cloud/client";
import type { SuperagentAction, SuperagentInfo, SuperagentView, TimelineEvent } from "../../../src/core/types";
import type { SuperagentActionReply } from "../api";
import { Button, Empty, RelativeTime } from "../components";
import { useLoad } from "../lib/cloud";
import { AGENT_TABS, type AgentTab } from "../lib/agentviews";
import {
  act,
  guide,
  readChat,
  readView,
  receipt,
  relayUnavailable,
  share,
  teamMembers,
  unshare,
  useTeam,
  type CommandReceipt,
  type TeamChatEvent,
  type TeamChatPage,
  type TeamInstance,
} from "../lib/teamagents";
import { go, hrefOf } from "../route";
import { AgentAvatar } from "./AgentAvatar";
import { agentRoute, landingForTeam, teamRouteId } from "./AgentBrowser";
import { Blocks, LocalLinks } from "./AgentPage";
import { ComposerInput, ComposerSend } from "./session/ComposerInput";
import { loadDraft, saveDraft, newRevision } from "./session/drafts";
import { Markdown } from "./session/Markdown";
import { AgentConversationEvents, type ChatEcho } from "./session/Timeline";

/** How often an open Chat reads its page again. Each read crosses the relay to the host. */
const CHAT_POLL_MS = 5_000;

const draftKey = (instance: string) => `team:${instance}`;
const personName = (p: { display_name: string; email: string }) => p.display_name || p.email || "Someone";

/** The workspace's people by user id, for the maintainers lists. */
function usePeople(human: HumanCloud | null, workspace: string | null) {
  const members = useLoad(() => (human && workspace ? teamMembers(human, workspace) : Promise.resolve([])), [human, workspace]);
  const byId = useMemo(() => new Map((members.data ?? []).map((m) => [m.user_id, m.person])), [members.data]);
  return { members, byId };
}

/** The header's words for a shared instance: its host first, then what its main conversation does. */
function teamStatus(instance: TeamInstance, chat: TeamChatPage | null, asking: boolean): { label: string; tone: "ok" | "busy" | "warn" | "bad" | "idle" } {
  if (!instance.host.live) return { label: "Host offline", tone: "idle" };
  if (asking) return { label: "Asking its host a question", tone: "warn" };
  if (chat?.status === "running") return { label: "Working", tone: "busy" };
  if (chat?.status === "blocked") return { label: "Needs its host", tone: "warn" };
  if (chat && !chat.session) return { label: "No conversation", tone: "idle" };
  return { label: "Available", tone: "ok" };
}

// ------------------------------------------------------------------ space

export function TeamSpace({ instance }: { instance: TeamInstance }) {
  const { human, workspace } = useTeam();
  const route = agentRoute();
  const tab: AgentTab = route.view === "feed" ? "feed" : route.view === "settings" ? "settings" : "chat";
  const rid = teamRouteId(instance.id);
  useEffect(() => {
    if (!route.view) go(landingForTeam(instance.id), true);
  }, [instance.id, route.view]);
  const chat = useTeamChat(human, instance.id, tab === "chat");
  const people = usePeople(human, workspace);
  const asking = !!openQuestion(chat.events);
  const status = teamStatus(instance, chat.page, asking);
  /** A page's "give guidance": its text goes into the guidance box. */
  const compose = async (text: string) => {
    const cur = loadDraft(draftKey(instance.id));
    await saveDraft(draftKey(instance.id), cur?.text ? `${cur.text}\n\n${text}` : text, [], newRevision());
    go({ page: "agents", id: rid, view: "chat" });
  };
  if (!human) return <Empty title="Loading…" />;
  return (
    <div className={`agent-space agent-space-${tab} agent-space-team`}>
      <header className="agent-space-head">
        <a href={hrefOf({ page: "agents", id: rid, view: "sessions" })} className="hint agent-list-back" data-nav-back aria-label="Back to the agents">
          ← Agents
        </a>
        <div className="agent-identity">
          <AgentAvatar role={instance.description} size={28} />
          <div className="agent-heading">
            <h2>{instance.title}</h2>
            <span className="agent-description">
              On {instance.host.name ?? "a teammate's machine"} · shared by {personName(instance.shared_by)}
            </span>
          </div>
          <span className="agent-status" data-tone={status.tone}>
            {status.label}
          </span>
        </div>
        <nav aria-label="Agent views">
          {AGENT_TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? "active" : ""}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => go({ page: "agents", id: rid, view: t })}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      {tab === "settings" ? (
        <div className="agent-about agent-settings">
          <TeamSettings instance={instance} people={people.byId} />
        </div>
      ) : tab === "feed" ? (
        <TeamFeed human={human} instance={instance} tab={route.tab ?? null} onCompose={(t) => void compose(t)} />
      ) : (
        <TeamChat human={human} instance={instance} chat={chat} />
      )}
    </div>
  );
}

/** Why the relay cannot run in this browser, said plainly. */
function RelayNotice({ why }: { why: string }) {
  return (
    <div className="agent-chat-scroll">
      <div className="agent-conversation-width agent-chat-empty">
        <h3>The relay needs HTTPS or localhost</h3>
        <p>{why}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- chat

const mergeEvents = (a: readonly TeamChatEvent[], b: readonly TeamChatEvent[]) => {
  const byId = new Map(a.map((e) => [e.id, e]));
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.at - y.at);
};

type TeamChatState = ReturnType<typeof useTeamChat>;

/** Its main conversation through the relay: the newest page every few
 *  seconds while Chat shows and the tab is visible, and older pages on
 *  request. Every message read is kept, so a page that moves on between two
 *  reads leaves no gap. A new main (a rollover, a handover) starts over. */
function useTeamChat(human: HumanCloud | null, instance: string, active: boolean) {
  const [page, setPage] = useState<TeamChatPage | null>(null);
  const [events, setEvents] = useState<TeamChatEvent[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const session = useRef<string | null | undefined>(undefined);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!human || !active || relayUnavailable()) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const p = await readChat(human, instance, {}, ctrl.signal);
          if (!live) return;
          const fresh = session.current !== p.session;
          session.current = p.session;
          setPage(p);
          setError(p.error ?? null);
          setEvents((xs) => (fresh ? p.events : mergeEvents(xs, p.events)));
          if (fresh) setBefore(p.before);
        } catch (e) {
          if (live) setError((e as Error).message);
        }
      }
      if (live) timer = setTimeout(() => void load(), CHAT_POLL_MS);
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
  }, [human, instance, active, n]);
  const loadOlder = async () => {
    if (!human || !before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const p = await readChat(human, instance, { before, ...(session.current ? { session: session.current } : {}) });
      if (p.session !== session.current) return;
      setEvents((xs) => mergeEvents(p.events, xs));
      setBefore(p.before);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };
  return { page, events, before, error, loadingOlder, loadOlder, reload: () => setN((x) => x + 1) };
}

type TeamQuestion = Extract<TeamChatEvent, { kind: "question" }>;
/** The question its host's dialog shows now: the newest one, unanswered,
 *  with no reply after it. A message after it (guidance) leaves it open. */
function openQuestion(events: readonly TeamChatEvent[]): TeamQuestion | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "assistant") return null;
    if (e.kind === "question") return e.answers ? null : e;
  }
  return null;
}

/** The relay's chat as the Timeline draws it. A question shows as text with
 *  its answer: a teammate cannot answer the host's terminal dialog. */
function asTimeline(events: readonly TeamChatEvent[]): TimelineEvent[] {
  const lastId = openQuestion(events)?.id;
  return events.map((e): TimelineEvent => {
    if (e.kind !== "question") return e;
    return {
      id: e.id,
      at: e.at,
      kind: "tool",
      name: "AskUserQuestion",
      summary: e.questions[0]?.question ?? "",
      status: e.answers ? "ok" : e.id === lastId ? "running" : "error",
      ask: {
        id: e.id,
        questions: e.questions.map((q) => ({ question: q.question, header: "", multiSelect: false, options: q.options.map((label) => ({ label })) })),
        ...(e.answers ? { answers: e.answers } : {}),
      },
    };
  });
}

const FINAL = (r: CommandReceipt) => r.state !== "queued" && r.state !== "attempting";

/** What a guidance receipt says, in words. */
function receiptText(r: CommandReceipt): { text: string; bad: boolean } {
  switch (r.state) {
    case "queued":
      return { text: "Queued in the cloud. Its host has not taken it yet.", bad: false };
    case "attempting":
      return { text: "Its host is typing it into the main conversation…", bad: false };
    case "sent":
      return { text: "Sent to its main conversation.", bad: false };
    case "refused":
      return { text: `Refused: ${r.result || "its host did not take it"}. Read the conversation again, then send.`, bad: true };
    case "failed":
      return { text: `Not sent: ${r.result || "its host could not type it"}.`, bad: true };
    case "uncertain":
      return { text: `Not confirmed: ${r.result || "its host did not say whether it typed it"}. Read the conversation before you send it again.`, bad: true };
  }
}

function TeamChat({ human, instance, chat }: { human: HumanCloud; instance: TeamInstance; chat: TeamChatState }) {
  const why = relayUnavailable();
  const shown = useMemo(() => asTimeline(chat.events), [chat.events]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchor = useRef<number | null>(null);
  const [echo, setEcho] = useState<ChatEcho | null>(null);
  // The newest messages stay in view, and an older page keeps the reader's place.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) el.scrollTop = el.scrollHeight - anchor.current;
    else if (pinned.current) el.scrollTop = el.scrollHeight;
    anchor.current = null;
  }, [shown, echo]);
  if (why) return <RelayNotice why={why} />;
  const asking = openQuestion(chat.events);
  // The guidance shows until the conversation has it.
  const pending = echo && !chat.events.some((e) => e.kind === "user" && e.at >= echo.at - 60_000 && e.text.includes(echo.text.trim())) ? echo : null;
  const older = async () => {
    const el = scroller.current;
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
    await chat.loadOlder();
  };
  return (
    <>
      <div
        className="agent-chat-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="agent-conversation-width">
          {chat.before && chat.events.length > 0 && (
            <Button variant="ghost" loading={chat.loadingOlder} onClick={() => void older()}>
              Earlier messages
            </Button>
          )}
          {!chat.events.length && (
            <div className="agent-chat-empty">
              <h3>{chat.page ? (chat.page.session ? "No messages yet" : "No conversation yet") : "Reading its conversation…"}</h3>
              <p>
                {chat.page
                  ? chat.page.session
                    ? "Its main conversation has no messages yet."
                    : "Its host has not started its main conversation."
                  : `The relay asks ${instance.host.name ?? "its host"} for it. A host that is off answers after 45 seconds.`}
              </p>
            </div>
          )}
          <AgentConversationEvents
            events={shown}
            agent={{ name: instance.title, role: instance.description, icon: null, avatar: null }}
            presence={{ message: null, read: false, working: chat.page?.status === "running", queued: [] }}
            echoes={pending ? [pending] : []}
          />
          {asking && (
            <p className="agent-chat-notice" role="status">
              It asks its host to choose: {asking.questions.flatMap((q) => q.options).join(" · ") || "a free answer"}. Only its host can answer, on its own
              machine. Your guidance goes to the conversation as a message.
            </p>
          )}
          {chat.error && (
            <p className="agent-chat-notice" role="status">
              {chat.error}
            </p>
          )}
        </div>
      </div>
      <GuideBox human={human} instance={instance} session={chat.page?.session ?? null} loaded={!!chat.page} onSent={setEcho} />
    </>
  );
}

/** Guidance to its main conversation, typed only into the conversation this
 *  page shows (`expectedSession`). One send id per attempt, kept across a
 *  reload, so a retry is the same message. */
function GuideBox({ human, instance, session, loaded, onSent }: { human: HumanCloud; instance: TeamInstance; session: string | null; loaded: boolean; onSent: (e: ChatEcho) => void }) {
  const key = draftKey(instance.id);
  const pendingKey = `agentbox.teamGuide.${instance.id}`;
  const [text, setText] = useState(() => loadDraft(key)?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<CommandReceipt | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // A page action's "give guidance" fills the draft from another pane.
  useEffect(() => {
    const d = loadDraft(key)?.text;
    if (d && d !== text) setText(d);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Follow a receipt until it is final, every two seconds for at most two minutes.
  useEffect(() => {
    if (!last || FINAL(last)) return;
    let live = true;
    let tries = 0;
    const t = setInterval(() => {
      if (++tries > 60) return clearInterval(t);
      receipt(human, last.id).then(
        (r) => live && (r.state !== last.state || r.result !== last.result) && setLast(r),
        () => undefined,
      );
    }, 2_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [human, last]);
  const save = (t: string) => {
    setText(t);
    void saveDraft(key, t, [], newRevision());
  };
  const canSend = !!session && instance.host.live;
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy || !session) return;
    setBusy(true);
    setError(null);
    let sendId = localStorage.getItem(pendingKey);
    if (!sendId) localStorage.setItem(pendingKey, (sendId = crypto.randomUUID()));
    try {
      const r = await guide(human, instance.id, text.trim(), sendId, session);
      localStorage.removeItem(pendingKey);
      setLast(r);
      if (r.state !== "refused" && r.state !== "failed") {
        onSent({ id: sendId, text: text.trim(), at: Date.now(), note: "Guidance" });
        save("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const said = last ? receiptText(last) : null;
  return (
    <div className="agent-conversation-width agent-compose-wrap">
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
              aria-label={`Guidance for ${instance.title}`}
              placeholder={`Guidance for ${instance.title}`}
              value={text}
              disabled={!canSend}
              onChange={(e) => {
                // Another text is another message: it takes a new send id.
                localStorage.removeItem(pendingKey);
                save(e.target.value);
              }}
            />
            <div className="cmp-tools">
              <ComposerSend type="submit" aria-label="Send guidance" disabled={!text.trim() || !canSend} loading={busy} data-ready={text.trim() ? true : undefined} />
            </div>
          </div>
        </div>
      </form>
      {said && (
        <p className={`ag-note ${said.bad ? "bad" : "ok"}`} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
      <p className="agent-help-hint">
        {!instance.host.live
          ? `${instance.host.name ?? "Its host"} is offline. Guidance waits until it is back.`
          : loaded && !session
            ? "It has no main conversation yet. Its host starts one."
            : "Your guidance arrives in its main conversation as a teammate's request, with your name. You get no terminal."}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- feed

/** Its program's page through the relay, drawn with the same blocks as a
 *  local agent's. Its actions reach the program as `via: "team"`. */
function TeamFeed({ human, instance, tab, onCompose }: { human: HumanCloud; instance: TeamInstance; tab: string | null; onCompose: (text: string) => void }) {
  const why = relayUnavailable();
  const [view, setView] = useState<SuperagentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (why) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const load = async () => {
      let next = 30;
      if (document.visibilityState === "visible") {
        try {
          const p = await readView(human, instance.id, tab, ctrl.signal);
          if (!live) return;
          if (p.error) setError(p.error);
          else {
            const v = p.view as SuperagentView | null;
            setView(v);
            setError(null);
            next = Math.max(5, v?.refresh ?? 30);
          }
        } catch (e) {
          if (live) setError((e as Error).message);
        }
      }
      if (live) timer = setTimeout(() => void load(), next * 1000);
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
  }, [human, instance.id, tab, n, why]);
  if (why) return <RelayNotice why={why} />;
  const take = async (a: SuperagentAction, values: Record<string, unknown>) => {
    if (a.confirm && !confirm(a.confirm)) return;
    setMessage(null);
    try {
      const { receipt: r, answer } = await act(human, instance.id, a.id, { ...a.values, ...values }, tab);
      if (!answer) return setMessage({ text: r.result || `Its host did not run it (${r.state}).`, bad: true });
      if (!answer.ok) return setMessage({ text: answer.error, bad: true });
      const reply = (answer.answer ?? {}) as SuperagentActionReply;
      if (reply.view) setView(reply.view);
      else setN((x) => x + 1);
      if (reply.message) setMessage({ text: reply.message, bad: false });
      if (reply.compose) onCompose(reply.compose);
      // `open` names a place on its host: there is nothing to open here.
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  };
  const tabs = view?.tabs ?? [];
  const first = tabs[0]?.id ?? null;
  const current = tab && tabs.some((t) => t.id === tab) ? tab : first;
  return (
    <div className="agent-feed">
      {tabs.length > 1 && (
        <div className="agent-feed-tabs" role="tablist" aria-label={`${instance.title} pages`}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={current === t.id}
              onClick={() => go({ page: "agents", id: teamRouteId(instance.id), view: "feed", ...(t.id === first ? {} : { tab: t.id }) }, true)}
            >
              {t.title}
              {t.badge != null && t.badge !== 0 && t.badge !== "" && <span>{t.badge}</span>}
            </button>
          ))}
        </div>
      )}
      {error && !view ? (
        <p className="ag-note bad">Its page did not load: {error}</p>
      ) : !view ? (
        <Empty title="Reading its page…">
          <p>The relay asks {instance.host.name ?? "its host"} for it. A host that is off answers after 45 seconds.</p>
        </Empty>
      ) : (
        <div className="ag-page">
          {view.title ? <h3 className="ag-page-title">{view.title}</h3> : null}
          {message ? (
            <p className={`ag-note ${message.bad ? "bad" : "ok"}`} role={message.bad ? "alert" : "status"}>
              {message.text}
            </p>
          ) : null}
          {error ? <p className="ag-note bad">The last refresh failed: {error}</p> : null}
          <LocalLinks.Provider value={false}>
            <Blocks blocks={view.blocks} act={take} />
          </LocalLinks.Provider>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- settings

type People = Map<string, { display_name: string; email: string }>;
const names = (ids: readonly string[], people: People) => ids.map((id) => (people.get(id) ? personName(people.get(id)!) : id)).join(", ") || "None";

function Source({ source }: { source: TeamInstance["source"] }) {
  return source ? (
    <span className="mono">
      {source.repo} · {source.path} · {source.commit.slice(0, 12)}
    </span>
  ) : (
    <>None: its directory is not in a git checkout with a remote.</>
  );
}

/** What a shared instance is. Nothing here changes its host. */
function TeamSettings({ instance, people }: { instance: TeamInstance; people: People }) {
  const seen = instance.host.last_seen_at ? Date.parse(instance.host.last_seen_at) : null;
  return (
    <section className="agent-settings-section" aria-labelledby="team-what">
      <h3 id="team-what">{instance.title}</h3>
      {instance.description && (
        <div className="ag-md">
          <Markdown text={instance.description} />
        </div>
      )}
      <dl className="ag-fields">
        <div>
          <dt>Name</dt>
          <dd className="mono">{instance.name}</dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd>
            {instance.host.name ?? "A machine with no name"} · {instance.host.live ? "online" : "offline"}
            {seen ? (
              <>
                {" "}
                · seen <RelativeTime ts={seen} />
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Shared by</dt>
          <dd>
            {personName(instance.shared_by)}
            {instance.shared_by.email && instance.shared_by.display_name ? ` (${instance.shared_by.email})` : ""}
          </dd>
        </div>
        <div>
          <dt>Maintainers</dt>
          <dd>{names(instance.maintainers, people)}</dd>
        </div>
        <div>
          <dt>Visibility</dt>
          <dd>{instance.visibility === "workspace" ? "Every member of the workspace" : "Its maintainers only"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            <Source source={instance.source} />
          </dd>
        </div>
      </dl>
      {instance.source ? (
        <p className="hint">
          Copy this directory from git to run your own instance: fetch <code>{instance.source.repo}</code> at <code>{instance.source.commit.slice(0, 12)}</code>, copy{" "}
          <code>{instance.source.path}</code>, change it, and add it with <code>agentbox superagent add &lt;dir&gt;</code>.
        </p>
      ) : (
        <p className="hint">Its host shared no git source, so there is nothing to copy. Ask {personName(instance.shared_by)} for its directory.</p>
      )}
      <p className="hint">
        It runs on {instance.host.name ?? "its host"} only. You can read its Chat and its page, take its actions and send guidance. Only its host owner can change
        it or stop the share, and nobody gets its terminal.
      </p>
    </section>
  );
}

// ------------------------------------------------------- share (the host)

/** The Team section of a local agent's Settings: share it with the
 *  workspace, or end the share. The host owner only; the cloud checks. */
export function TeamShare({ info, reload }: { info: SuperagentInfo; reload: () => Promise<void> }) {
  const team = useTeam();
  const { members, byId } = usePeople(team.human, team.hostWorkspace);
  const [visibility, setVisibility] = useState<"private" | "workspace">("workspace");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!team.configured) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const me = team.userId;
  const shared = info.team;
  return (
    <section className="agent-settings-section agent-team-share" aria-labelledby="agent-team">
      <h3 id="agent-team">Team</h3>
      {!team.ready ? (
        <p className="hint">Checking your cloud sign-in…</p>
      ) : !team.human ? (
        <p className="hint">
          Sign in on the <a href={hrefOf({ page: "team" })}>Team page</a> to share {info.title} with your workspace.
        </p>
      ) : shared ? (
        <>
          <p className="hint">
            Shared. Teammates who can see it read its Chat and its page, take its actions and send guidance to its main conversation. It still runs on this
            machine only, and nobody gets its terminal.
          </p>
          <dl className="ag-fields">
            <div>
              <dt>Visibility</dt>
              <dd>{shared.visibility === "workspace" ? "Every member of the workspace" : "Its maintainers only"}</dd>
            </div>
            <div>
              <dt>Maintainers</dt>
              <dd>{names(shared.maintainers, byId)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                <Source source={shared.source} />
              </dd>
            </div>
            <div>
              <dt>Instance</dt>
              <dd className="mono">{shared.instance}</dd>
            </div>
          </dl>
          {!shared.source && <p className="hint">Without a git source, a teammate cannot copy it. Push its directory to a repository and share it again.</p>}
          <div className="ag-actions">
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() => confirm(`Stop sharing ${info.title}? Teammates no longer see it.`) && void run(() => unshare(team.human!, info.name))}
            >
              Stop sharing
            </Button>
          </div>
        </>
      ) : (
        <form
          className="ag-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => share(team.human!, info.name, { visibility, maintainers: [...new Set([...(me ? [me] : []), ...picked])] }));
          }}
        >
          <p className="hint">
            Not shared. Share it with the workspace this machine is registered in. It still runs here only. Teammates read its Chat and its page, take its actions
            and send guidance; nobody gets its terminal.
          </p>
          <fieldset className="agent-team-choice">
            <legend>Who can see it</legend>
            <label className="ag-check">
              <input type="radio" name="visibility" checked={visibility === "workspace"} onChange={() => setVisibility("workspace")} /> Every member of the workspace
            </label>
            <label className="ag-check">
              <input type="radio" name="visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} /> Its maintainers only
            </label>
          </fieldset>
          <fieldset className="agent-team-choice">
            <legend>Maintainers</legend>
            {members.error && <p className="hint">The members did not load: {members.error}</p>}
            {(members.data ?? []).length
              ? members.data!.map((m) => (
                  <label key={m.user_id} className="ag-check">
                    <input
                      type="checkbox"
                      checked={m.user_id === me || picked.includes(m.user_id)}
                      disabled={m.user_id === me}
                      onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, m.user_id] : xs.filter((x) => x !== m.user_id)))}
                    />{" "}
                    {personName(m.person)}
                    {m.user_id === me ? " (you, its host owner)" : ""}
                  </label>
                ))
              : !members.error && <p className="hint">{team.hostWorkspace ? "Loading the members…" : "You, its host owner. Register this machine on the Team page to pick others."}</p>}
          </fieldset>
          <div className="ag-actions">
            <Button size="sm" variant="primary" type="submit" loading={busy}>
              Share with the workspace
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
