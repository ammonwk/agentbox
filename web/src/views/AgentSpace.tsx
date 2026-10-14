import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AgentConversation,
  type Proposal,
  type ConversationPage,
  type ReadCursor,
  type AgentThread,
  type ChatEvent,
  type ChatPresence,
} from "../../../src/cloud/agent-conversation";
import type { HumanAgents } from "../../../src/cloud/agent-client";
import {
  AgentRun,
  type AgentBoard,
  type SharedAgent,
  type AgentAction,
} from "../../../src/cloud/agents";
import { z } from "zod";
import { CreationDraft, type CreationSpec } from "../../../src/cloud/agent-creation";
import { AgentCreationCard } from "./AgentCreationCard";
import { AgentMemory } from "./AgentMemory";
import { cloudCall, CloudError } from "../../../src/cloud/client";
import type { AppState } from "../../../src/core/types";
import { request, useNow } from "../api";
import { Button, Confirm, Empty, Toggle } from "../components";
import { useLoad } from "../lib/cloud";
import { AgentComposer } from "./session/Composer";
import { UI_REVISION } from "../build";
import { SessionFacts } from "./session/SessionFacts";
import { AgentConversationEvents, type ChatEcho } from "./session/Timeline";
import { followsAfterScroll, onChatSubmitted, followChatSize } from "./session/scroll";
import { AgentAvatar, AgentPictureEditor, localAvatarUrl } from "./AgentAvatar";
import { Markdown } from "./session/Markdown";
import "./session/session.css";
import { AgentBrowser, agentRoute, firstActive, landingForAgent, agentActivity, agentName, type AgentOption } from "./AgentBrowser";
import { shownStatus } from "../lib/board";
import { go, hrefOf } from "../route";
import { AGENT_TABS, type AgentTab } from "../lib/agentviews";

type Receipt = { state: string; result: string; issue?: string };
const providerName = { codex: "Codex", claude: "Claude", muse: "Muse" } as const;
type Transport = {
  help?: (text: string, request: string, target: string | null) => Promise<Receipt>;
  sessionAction?: (thread: AgentThread, action: "close" | "restore") => Promise<{state: string; result: string}>;
  creations: () => Promise<CreationDraft[]>;
  editCreation: (draft: CreationDraft, spec: CreationSpec, create: boolean) => Promise<CreationDraft>;
  read: (cursor: ReadCursor, signal?: AbortSignal) => Promise<ConversationPage>;
  send: (
    body: string,
    id: string,
    proposal: { proposal: string; run: string } | undefined,
    target: AgentThread | null,
  ) => Promise<Receipt>;
  receipt: (id: string) => Promise<Receipt | null>;
  proposals: () => Promise<Proposal[]>;
  decide: (
    p: Proposal,
    choice: "approved" | "dismissed",
    id: string,
  ) => Promise<unknown>;
};
export function SharedAgentSpace({
  a,
  board,
  api,
  user,
  actions,
  children,
  options,
  onCreate,
  reload,
  control,
}: {
  a: SharedAgent;
  board: AgentBoard;
  api: HumanAgents;
  user: string;
  actions: AgentAction[];
  children: ReactNode;
  options: AgentOption[];
  onCreate: () => void;
  reload: () => Promise<unknown>;
  control?: ReactNode;
}) {
  const conversation = useMemo(() => new AgentConversation(api.human), [api]);
  const runs = useRef(board.runs); runs.current = board.runs;
  const activeRuns = board.runs.filter(
    (r) =>
      r.agent_id === a.id &&
      ["running", "waiting", "starting", "queued"].includes(r.state),
  );
  const responsible =
    activeRuns.find((r) =>
      board.work.some(
        (w) => w.id === r.work_id && w.external_key === `conversation:${a.id}`,
      ),
    ) ?? activeRuns[0];
  const transport = useMemo<Transport>(
    () => ({
      read: (cursor, signal) => conversation.read(a.id, cursor, signal),
      creations: () => cloudCall(api.human.sb, "agent_creation_list", { p_creator: a.id }, z.array(CreationDraft)),
      editCreation: async (draft, spec, create) => { const d = await cloudCall(api.human.sb, "agent_creation_edit", { p_creator: a.id, p_id: draft.id, p_revision: draft.revision, p_spec: spec, p_create: create }, CreationDraft); await reload(); return d; },
      proposals: () => conversation.proposals(a.id),
      decide: (p, choice, id) => conversation.decide(p.id, choice, id),
      receipt: (id) => conversation.receipt(id),
      send: async (body, id, proposal, target) => {
        try {
          if (proposal && proposal.run !== target?.run) return { state: "refused", result: "Recommendation belongs to another conversation" };
          const r = target ? runs.current.find((r) => r.id === target.run && r.agent_id === a.id) : await cloudCall(api.human.sb,
            "agent_conversation_start", { p_agent: a.id, p_request: crypto.randomUUID() }, AgentRun);
          if (!r || target && r.session_id !== target.id || !target && r.session_id) return { state: "refused", result: "Conversation changed; open the current session" };
          return await conversation.guide(a.id, r.id, id, body, proposal?.proposal ?? null, target?.id ?? null);
        } catch (e) {
          if (
            e instanceof CloudError &&
            [400, 401, 403, 409].includes(e.status)
          )
            return { state: "refused", result: e.message };
          throw e;
        }
      },
    }),
    [conversation, a.id, api],
  );
  const mayDecide = (p: Proposal) =>
    a.maintainers.includes(user) ||
    board.work.find(
      (w) => w.id === board.runs.find((r) => r.id === p.run_id)?.work_id,
    )?.assignee === user;
  return (
    <AgentSpace
      id={a.id}
      identity={{ role: a.definition.role, creator: a.capability === "creator", avatar: null }}
      options={options}
      conversationSession={activeRuns.find((r) => board.work.some((w) => w.id === r.work_id && w.external_key === `conversation:${a.id}`))?.session_id ?? null}
      onCreate={onCreate}
      name={agentName(a.name)}
      status={
        !a.enabled
          ? "Paused"
          : responsible?.state === "running"
            ? "Working"
            : responsible
              ? "Available"
              : "Ready to begin"
      }
      transport={transport}
      disabled={!a.enabled}
      control={control}
      mayDecide={mayDecide}
      actions={actions}
      settings={children}
    />
  );
}
import type { LocalAgent } from "../../../src/core/agents/conversation";
import { useScope } from "../lib/projects";
import { chooseWhere, sharedTwinOf } from "../lib/moveagents";
import { WhereToggle } from "./AgentWhere";
import { selectScope, scopeOf } from "../route";
/** A local agent as the sidebar shows it; the shared directory's landing reads it too. */
export function localAgentOption(a: LocalAgent, state: AppState): AgentOption {
  const linked = new Set([a.session, ...a.previous, ...(a.workSessions ?? [])]);
  return { id: a.id, name: a.name, role: a.role, creator: a.capability === "creator" && !a.unavailable, avatar: localAvatarUrl(a),
    activity: agentActivity(a.enabled && !a.unavailable, state.sessions.filter((s) => linked.has(s.id) || s.agentOwner === a.id).map(shownStatus)),
    detail: `${state.repos.find((r) => r.id === a.repo)?.displayName ?? (a.repo ? "Unregistered project" : "General")} · ${a.unavailable ? "History" : a.enabled ? "Local" : "Paused"}` };
}

export function LocalAgentSpace({
  state,
  id,
}: {
  state: AppState;
  id?: string;
}) {
  const { project } = useScope();
  const agents = useLoad(
    () => project ? request<LocalAgent[]>("POST", "/api/agents/local/project", { repo: project }) : request<LocalAgent[]>("GET", "/api/agents/local"),
    [project],
  );
  useEffect(() => {
    const timer = setInterval(() => void agents.reload(), 10000);
    return () => clearInterval(timer);
  }, [agents.reload]);
  // A Jupiter kept as history outside the Agentbox project is not listed.
  const options = (agents.data ?? []).filter((a) => (!project || a.repo === project) && !(a.capability === "creator" && a.unavailable)).map((a) => localAgentOption(a, state));
  const selected = agents.data?.find((a) => a.id === id);
  const sharedId = selected ? sharedTwinOf(selected.id) : undefined;
  useEffect(() => {
    if (!id && options.length) go(landingForAgent(firstActive(options)!.id), true);
  }, [id, agents.data, project]);
  useEffect(() => {
    if (selected && !scopeOf().has("project")) selectScope("project", selected.repo, { ...agentRoute(), page: "agents", id: selected.id }, true);
  }, [selected?.id]);
  const transport = useMemo<Transport>(
    () => ({
      read: (cursor) => request("POST", `/api/agents/local/${id}/read`, cursor),
      help: (text, requestId, target) => request("POST", `/api/agents/local/${id}/help`, {text, request:requestId, target, uiRevision:UI_REVISION}),
      creations: () => request("GET", `/api/agents/local/${id}/creations`),
      editCreation: async (draft, spec, create) => { const d = await request<CreationDraft>("POST", `/api/agents/local/${id}/creations/${draft.id}`, { revision: draft.revision, spec, create, repo: selected?.repo ?? null }); await agents.reload(); return d; },
      proposals: () => request("GET", `/api/agents/local/${id}/proposals`),
      decide: (p, decision, requestId) =>
        request("POST", `/api/agents/local/${id}/decide`, {
          id: p.id,
          decision,
          request: requestId,
        }),
      send: async (body, requestId, context, target) => {
        const receipt = await request<Receipt>(
          "POST",
          `/api/agents/local/${id}/chat`,
          {
            body,
            request: requestId,
            context,
            target: target?.id ?? null,
          },
        );
        await agents.reload();
        return receipt;
      },
      receipt: (requestId) =>
        request("GET", `/api/agents/local/${id}/receipt/${requestId}`),
      sessionAction: (thread, action) => request("POST", `/api/agents/local/${id}/sessions/${encodeURIComponent(thread.id)}`, {
        request: crypto.randomUUID(), action, activity: thread.at,
        reason: action === "close" ? "Closed by the user after reviewing the work" : "Restored by the user while cached",
      }),
    }),
    [id, selected?.repo, agents.reload],
  );
  if (agents.error)
    return <Empty title="Could not load local agents">{agents.error}</Empty>;
  if (!agents.data) return <Empty title="Loading agents…" />;
  if (selected && project && selected.repo !== project) return <Empty title="This agent belongs to another project"><Button onClick={() => selectScope("project", selected.repo, { ...agentRoute(), page: "agents", id: selected.id })}>Open in its project</Button></Empty>;
  if (id && !selected) return <Empty title="Agent not found" />;
  if (!selected) return <Empty title="Loading agents…" />;
  const session = state.sessions.find((s) => s.id === selected.session);
  const route = agentRoute();
  const viewedId = route.thread && route.thread !== "new" ? route.thread : selected.session;
  const viewed = state.sessions.find((s) => s.id === viewedId && (s.agentOwner === selected.id || [selected.session, ...selected.previous, ...(selected.workSessions ?? [])].includes(s.id)));
  return (
    <AgentSpace
      key={selected.id}
      footer={(!route.view || route.view === "chat" || route.view === "sessions") && viewed ? <SessionFacts session={viewed} state={state} /> : null}
      id={selected.id}
      attachments
      identity={{ role: selected.role, creator: selected.capability === "creator", avatar: localAvatarUrl(selected) }}
      me={state.onboarding.identity ? { name: state.onboarding.identity.name ?? "", github: state.onboarding.identity.github ?? "" } : undefined}
      options={options}
      name={agentName(selected.name)}
      conversationSession={selected.session}
      status={
        selected.unavailable
          ? "History"
          : !selected.enabled
          ? "Paused"
          : session?.status === "running"
            ? "Working"
            : selected.session
              ? "Available"
              : "Ready to begin"
      }
      transport={transport}
      disabled={!selected.enabled || !!selected.unavailable}
      control={selected.unavailable ? null : <>{sharedId && <WhereToggle where="local" onChange={() => { chooseWhere(sharedId, "hosted"); go({ page: "agents", id: sharedId }); }} />}<EnabledToggle agent={selected} live={state.sessions.some((s) => s.host !== "none" && (s.agentOwner === selected.id || [selected.session, ...(selected.workSessions ?? [])].includes(s.id)))} onChange={agents.reload} /></>}
      mayDecide={() => true}
      settings={
        <>
          {selected.unavailable && <p role="status">{selected.unavailable}</p>}
          <fieldset className="agent-about-controls" disabled={!!selected.unavailable}>
          <AgentPictureEditor agent={selected} onChange={agents.reload} />
          <h3>{selected.role}</h3>
          <p className="hint">Manual chat · {selected.createdBy ?? "Local operator"}{selected.automation ? ` · Requested automation (not configured): ${selected.automation}` : ""}</p>
          <p>
            Local to this machine. This conversation uses your existing provider
            account. Shared workspace setup is optional.
          </p>
          <Markdown text={selected.instructions} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void request(
                "POST",
                `/api/agents/local/${selected.id}/configure`,
                {
                  provider: data.get("provider"),
                  repo: selected.project ?? (data.get("repo") || null),
                  enabled: selected.enabled,
                  memoryPolicy: {
                    rollover: data.get("rollover") === "on",
                    idleMin: Number(data.get("idleMin")),
                    contextPct: Number(data.get("contextPct")),
                  },
                },
              )
                .then(agents.reload)
                .catch((e) => alert(e.message));
            }}
          >
            <label>
              Provider
              <select
                name="provider"
                className="input"
                defaultValue={selected.pinned ?? "auto"}
              >
                <option value="auto">Automatic</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
                <option value="muse">Muse</option>
              </select>
            </label>
            <p className="hint agent-provider-now">
              {selected.session || selected.previous.length
                ? `Current conversation: ${providerName[selected.provider]}${selected.selection ? ` — ${selected.selection.why}` : ""}`
                : "No conversation yet: the first message chooses where it runs."}
            </p>
            <p className="hint">
              {selected.project ? "This agent stays in its project. Switch projects to use a separate conversation. Automatic keeps a warm conversation where it is and chooses again only for a fresh one; choosing a provider is an override that starts a fresh session when idle." : "Automatic keeps a warm conversation where it is and chooses again only for a fresh one. Choosing a provider, or changing the repository, preserves history and starts a fresh session when idle. General conversations remain available in All projects."}
            </p>
            <label>
              Repository
              <select
                className="input"
                name="repo"
                disabled={!!selected.project}
                defaultValue={selected.repo ?? ""}
              >
                <option value="">Conversation only</option>
                {state.repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                name="rollover"
                defaultChecked={selected.memoryPolicy?.rollover ?? true}
              />{" "}
              Continue in a fresh conversation from a saved handoff
            </label>
            <label>
              Handoff after idle minutes
              <input className="input" type="number" name="idleMin" min={5} max={240} required defaultValue={selected.memoryPolicy?.idleMin ?? 10} />
            </label>
            <label>
              Fresh conversation past context %
              <input className="input" type="number" name="contextPct" min={20} max={95} required defaultValue={selected.memoryPolicy?.contextPct ?? 60} />
            </label>
            <Button type="submit">Save</Button>
          </form>
          <AgentMemory key={selected.session ?? "none"} agent={selected} />
          <a href="#/team">Connect a shared workspace</a>
          </fieldset>
        </>
      }
    />
  );
}
/** Settings' Enabled switch: the form's own configure request, with the
 *  provider and repository it already has, so no conversation is replaced.
 *  Pausing stops the agent's running sessions; it asks first when any runs. */
function EnabledToggle({ agent, live, onChange }: { agent: LocalAgent; live: boolean; onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [asking, setAsking] = useState(false), [error, setError] = useState<string | null>(null);
  const set = (enabled: boolean) => {
    setAsking(false); setBusy(true); setError(null);
    void request("POST", `/api/agents/local/${agent.id}/configure`, { provider: agent.pinned ?? "auto", repo: agent.repo, enabled })
      .then(onChange).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <span className="agent-enabled">
      <Toggle checked={agent.enabled} disabled={busy} label="Enabled" onChange={(on) => on || !live ? set(on) : setAsking(true)} />
      {error && <span className="error" role="alert">{error}</span>}
      {asking && <Confirm title={`Pause ${agentName(agent.name)}?`} confirmLabel="Pause" onCancel={() => setAsking(false)} onConfirm={() => set(false)}
        body="Pausing stops its running sessions. Their conversations and transcripts stay; enable it again to continue." />}
    </span>
  );
}
function AgentSpace({
  footer,
  id,
  attachments = false,
  identity,
  me,
  name,
  status,
  transport,
  disabled,
  mayDecide,
  settings,
  control,
  actions = [],
  conversationSession,
  options,
  onCreate,
}: {
  id: string;
  footer?: ReactNode;
  /** Images in the composer: a local agent reads them from this machine. */
  attachments?: boolean;
  /** The agent's picture and the role its default icon comes from. */
  identity: { role: string; creator: boolean; avatar: string | null };
  /** The viewer, for their own messages; shared chats pass none. */
  me?: { name: string; github: string };
  name: string;
  status: string;
  transport: Transport;
  disabled: boolean;
  mayDecide: (p: Proposal) => boolean;
  /** The Settings tab: what the agent is, and its configuration. */
  settings: ReactNode;
  /** Where it runs and whether it is enabled, at the top of Settings. */
  control?: ReactNode;
  actions?: AgentAction[];
  conversationSession?: string | null;
  options: AgentOption[];
  onCreate?: () => void;
}) {
  const route = agentRoute(), tab = route.view === "sessions" ? "chat" : route.view ?? "chat";
  // Resolve the main chat before the first paint/read, not after an empty
  // "new conversation" has rendered and issued its own request.
  const requestedTarget = route.thread ?? "new";
  const target = requestedTarget === "new" ? conversationSession ?? "new" : requestedTarget;
  useEffect(() => { if (!route.view) go(landingForAgent(id), true); }, [id, route.view]);
  const setTab = (view: AgentTab) => go({ page: "agents", id, view, thread: target });
  const [threads, setThreads] = useState<AgentThread[]>([]), [more, setMore] = useState<number | null>(null), [railError, setRailError] = useState<string | null>(null);
  const selected = threads.find((t) => t.id === target);
  const now = useNow(15000);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [helpResult, setHelpResult] = useState<Receipt | null>(null);
  const ongoing = conversationSession;
  const loadedThreads = useRef(0);
  const readList = useCallback(async (offset = 0) => {
    const page = await transport.read({ session: 0, before: null, list: true, offset });
    if (page.error) throw Error(page.error);
    setThreads((old) => offset ? [...new Map([...old, ...(page.threads ?? [])].map((t) => [t.id,t])).values()] : page.threads ?? []);
    loadedThreads.current = offset + (page.threads?.length ?? 0);
    setMore(page.more ?? null); setRailError(null);
  }, [transport]);
  const followed = useRef(ongoing);
  const manageSession = async (action: "close" | "restore") => {
    if (!selected || !transport.sessionAction || sessionBusy) return;
    setSessionBusy(true);
    try {
      const result = await transport.sessionAction(selected, action);
      if (result.state !== "done") throw Error(result.result);
      await readList();
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setSessionBusy(false); }
  };
  useEffect(() => {
    // A link without a thread opens the main chat's thread in the view it names.
    if (requestedTarget === "new" && ongoing) go({ page: "agents", id, view: route.view ?? "chat", thread: ongoing }, true);
    // Continued in a fresh conversation: follow it from the one it replaced.
    else if (ongoing && followed.current && ongoing !== followed.current && target === followed.current) {
      const from = followed.current;
      setEchoes((xs) => xs.map((x) => (x.thread === from ? { ...x, thread: ongoing } : x)));
      go({ page: "agents", id, view: tab, thread: ongoing }, true);
    }
    followed.current = ongoing;
  }, [target, requestedTarget, ongoing, route.view]);
  const [events, setEvents] = useState<ChatEvent[]>([]),
    [next, setNext] = useState<ReadCursor | null>(null),
    [error, setError] = useState<string | null>(null),
    [reading, setReading] = useState(false),
    [ready, setReady] = useState(false),
    [guidance, setGuidance] = useState<{
      id: string;
      text: string;
      proposal: Proposal;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [echoes, setEchoes] = useState<(ChatEcho & { thread: string })[]>([]),
    [presence, setPresence] = useState<ChatPresence | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; }, [target, tab, transport]);
  const creations = useLoad(transport.creations, [transport]);
  const feed = useLoad(transport.proposals, [transport]),
    scroller = useRef<HTMLDivElement>(null),
    pinned = useRef(true);
  const [submitted, setSubmitted] = useState(0);
  const scrolledSubmission = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (el) return followChatSize(el, () => pinned.current);
  }, [tab, target]);
  useEffect(() => {
    pinned.current = true;
    setEvents([]); setNext(null); setReady(false); setError(null); setPresence(null);
    let live = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const page = await transport.read(
          { session: 0, before: null, ...(tab === "chat" && target && target !== "new" ? {target} : {list: true}) },
          controller.signal,
        );
        if (live) {
          if (page.threads) setThreads((old) => [...new Map([...old, ...page.threads!].map((t) => [t.id, t])).values()]);
          loadedThreads.current = Math.max(loadedThreads.current, page.threads?.length ?? 0);
          if (page.counts) setMore(page.counts.active + page.counts.inactive > loadedThreads.current ? loadedThreads.current : null);
          setRailError(page.error && page.session === null ? page.error : null);
          setEvents((old) => {
            const m = new Map(old.map((e) => [e.id, e]));
            page.events.forEach((e) => m.set(e.id, e));
            return [...m.values()].sort((a, b) => a.at - b.at);
          });
          setNext((old) => old ?? page.next);
          setPresence(page.presence ?? null);
          if (page.thread) setThreads((old) => old.some((t) => t.id === page.thread!.id) ? old.map((t) => t.id === page.thread!.id ? page.thread! : t) : [...old, page.thread!]);
          setError(page.error ?? null);
          setReady(true);
        }
      } catch (e) {
        if (live) {
          setError((e as Error).message);
          setPresence(null);
          setReady(true);
        }
      } finally {
        if (live) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    void refresh();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, transport, tab, target]);
  useEffect(() => {
    const t = setInterval(() => { void feed.reload(); void creations.reload(); }, 5000);
    return () => clearInterval(t);
  }, [feed.reload]);
  useEffect(() => onChatSubmitted(`agent:${id}:${target}`, () => {
    anchor.current = null;
    setSubmitted((n) => n + 1);
  }), [id, target]);
  // Older pages go above what is shown: keep the reader's place.
  const lastTop = useRef(0), anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) {
      if (scrolledSubmission.current !== submitted) pinned.current = true;
      if (pinned.current) el.scrollTop = el.scrollHeight;
      else if (anchor.current !== null) el.scrollTop = el.scrollHeight - anchor.current;
      scrolledSubmission.current = submitted;
      lastTop.current = el.scrollTop;
    }
    anchor.current = null;
  }, [events, echoes, tab, feed.data, creations.data, submitted]);
  const loadEarlier = () => {
    if (!next || reading) return;
    setReading(true);
    const mine = generation.current, el = scroller.current;
    void transport
      .read(next)
      .then((page) => {
        if (mine !== generation.current) return;
        if (el && !pinned.current) anchor.current = el.scrollHeight - el.scrollTop;
        setEvents((old) => {
          const m = new Map(old.map((e) => [e.id, e]));
          page.events.forEach((e) => m.set(e.id, e));
          return [...m.values()].sort((a, b) => a.at - b.at);
        });
        setNext(page.next);
        setError(page.error ?? null);
      })
      .catch((e) => { if (mine === generation.current) setError(e.message); })
      .finally(() => { if (mine === generation.current) setReading(false); });
  };
  const send = useCallback(
    async (
      body: string,
      requestId: string,
      context?: { proposal: string; run: string },
    ) => {
      const help = /^\/help(?:\s+([\s\S]*))?$/.exec(body.trim());
      if (help) {
        if (!transport.help) return {state:"refused",result:"Feedback reports are currently available in local agent chats."};
        const text = help[1]?.trim();
        const r = text ? await transport.help(text,requestId,selected?.id ?? null) : {
          state:"sent", result:"Use /help followed by an issue or improvement. For example: /help Vulcan asks for permission after I already approved the work. Your feedback and agent/session identifiers go to a GitHub issue in ammonwk/agentbox; the conversation is not uploaded.",
        };
        setHelpResult(r);
        return r;
      }
      setEchoes((xs) => [...xs, { id: requestId, text: body, at: Date.now(), note: "Sending…", thread: target }]);
      let r: Receipt;
      try {
        r = await transport.send(body, requestId, context, selected ?? null);
      } catch (e) {
        setEchoes((xs) => xs.filter((x) => x.id !== requestId));
        throw e;
      }
      // Refused: the composer keeps the draft and says why; nothing was sent.
      setEchoes((xs) => r.state === "refused" ? xs.filter((x) => x.id !== requestId) : xs.map((x) => x.id === requestId ? { ...x, note: r.state === "sent" ? "Sent" : "Not confirmed" } : x));
      void readList().catch((e) => setRailError(e.message));
      setGuidance(null);
      return r;
    },
    [transport, selected, readList, target],
  );
  const receipt = useCallback(
    async (requestId: string) => {
      const r = await transport.receipt(requestId);
      if (r?.issue) setHelpResult(r);
      return r;
    },
    [transport],
  );
  const open = feed.data?.filter((p) => p.state === "open") ?? [];
  async function decide(p: Proposal, choice: "approved" | "dismissed") {
    setBusy(true);
    setError(null);
    try {
      await transport.decide(p, choice, crypto.randomUUID());
      await feed.reload();
      const responsible = threads.find((t) => t.run === p.run_id && t.writable);
      if (choice === "approved" && responsible) go({ page: "agents", id, view: "chat", thread: responsible.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function card(p: Proposal) {
    return (
      <article className="agent-proposal card" key={p.id}>
        <div className="agents-toolbar">
          <h3>{p.title}</h3>
          <small>{p.state === "open" ? "Recommendation" : p.state}</small>
        </div>
        <Markdown text={p.finding} />
        {p.reason && <p className="hint">{p.reason}</p>}
        <p className="agent-next">{p.next_step}</p>
        {p.evidence.length > 0 && (
          <div className="agent-evidence">
            {p.evidence.map((e, i) => (
              <a key={i} href={e.url} target="_blank" rel="noreferrer">
                {e.label || "Evidence"} ↗
              </a>
            ))}
          </div>
        )}
        {p.action_id && (
          <details>
            <summary>Review the exact action</summary>
            <pre>
              {JSON.stringify(
                actions.find((x) => x.id === p.action_id)?.specification ?? {
                  unavailable: "Reload to see the current action",
                },
                null,
                2,
              )}
            </pre>
            <p className="hint">
              Existing checks and contact consent still apply.
            </p>
          </details>
        )}
        {p.delivery && (
          <p className="hint" role="status">
            {p.delivery.state === "sent"
              ? "Delivered to the agent"
              : `Delivery ${p.delivery.state}: ${p.delivery.result || "Waiting for confirmation"}`}
          </p>
        )}
        {p.state === "open" && (
          <div className="agents-buttons">
            {mayDecide(p) && (
              <Button
                variant="primary"
                disabled={
                  busy ||
                  (!!p.action_id && !actions.some((x) => x.id === p.action_id))
                }
                onClick={() => void decide(p, "approved")}
              >
                Approve
              </Button>
            )}
            <Button
              onClick={() => {
                const responsible = threads.find((t) => t.run === p.run_id && t.writable);
                if (!responsible) { setError("This recommendation’s conversation is no longer writable. Open its history or ask the current agent to review it."); return; }
                setGuidance({
                  id: crypto.randomUUID(),
                  proposal: p,
                  text: `Regarding “${p.title}” (${p.id}): `,
                });
                go({ page: "agents", id, view: "chat", thread: responsible.id });
              }}
            >
              Give guidance
            </Button>
            {mayDecide(p) && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void decide(p, "dismissed")}
              >
                Dismiss
              </Button>
            )}
          </div>
        )}
      </article>
    );
  }
  return (
    <AgentBrowser id={id} options={options} onCreate={onCreate} ongoing={ongoing} threads={threads} loading={!ready} more={more !== null} loadMore={() => { void readList(more ?? 0).catch((e) => setRailError(e.message)); }} error={railError}>
      {footer}
    <div className={`agent-space agent-space-${tab}`}>

      <header className="agent-space-head">
        <a href={hrefOf({ page: "agents", id, view: "sessions", thread: target })} className="hint agent-list-back" data-nav-back aria-label="Back to agent sessions">
          ← Agents
        </a>
        <div className="agent-identity">
          <AgentAvatar role={identity.role} creator={identity.creator} src={identity.avatar} size={28} />
          <div className="agent-heading">
            <h2>{selected?.kind === "work" && tab === "chat" ? selected.title : name}</h2>
            {selected?.kind !== "work" && <span className="agent-description">{identity.role.trim().split(/\s+/).slice(0, 10).join(" ")}</span>}
          </div>
          <span className="agent-chat-status">{status}</span>
        </div>
        <nav aria-label="Agent views">
          {transport.sessionAction && selected?.kind === "work" && selected.status !== "closed" &&
            <Button variant="ghost" size="sm" loading={sessionBusy} onClick={() => void manageSession("close")}>Close session</Button>}
          {AGENT_TABS.map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
              {t === "feed" && open.length > 0 && <span>{open.length}</span>}
            </button>
          ))}
        </nav>
      </header>
      {tab === "settings" ? (
        <div className="agent-about agent-settings">
          {control && <div className="agent-settings-controls">{control}</div>}
          {settings}
        </div>
      ) : tab === "feed" ? (
        <div className="agent-feed">
          {feed.error && <p className="error">{feed.error}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {feed.data?.length ? (
            feed.data.map(card)
          ) : (
            <Empty title="Nothing to recommend yet">
              {name} will bring useful findings and next steps here as it works.
            </Empty>
          )}
        </div>
      ) : (
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
              {next && (
                <Button variant="ghost" loading={reading} onClick={loadEarlier}>
                  {next.history ? "Earlier, summarized conversation" : "Earlier messages"}
                </Button>
              )}
              {!events.length && !error && (
                <div className="agent-chat-empty">
                  <h3>{ready ? target === "new" ? `Talk with ${name}` : "No messages yet" : "Loading conversation…"}</h3>
                  <p>
                    {ready
                      ? "Share a task, ask a question, or shape what to work on next."
                      : "Reading the conversation from its execution host."}
                  </p>
                </div>
              )}
              <AgentConversationEvents
                recommendations={feed.data ?? []}
                events={events}
                me={me}
                agent={{ ...identity, name }}
                presence={presence}
                echoes={echoes.filter((x) => (x.thread === target || (x.thread === "new" && target === ongoing)) && !events.some((e) => e.kind === "user" && e.at >= x.at - 60_000 && e.text.includes(x.text.trim())))
                  // Delivered mid-turn and held by the agent: its queue says so, not a guess.
                  .map((x, _, pending) => x.note === "Sent" && presence?.queued.filter((q) => q.trim() === x.text.trim()).length === 1 && pending.filter((p) => p.text.trim() === x.text.trim()).length === 1 ? { ...x, note: "Queued" } : x)}
                earlier={!!next}
                cards={[
                  // A draft from before drafts recorded their time comes last, as it did.
                  ...(creations.data?.filter((d) => d.run === selected?.run).map((d) => ({ id: `creation-${d.id}`, at: d.at ?? Infinity,
                    node: <AgentCreationCard key={`${d.id}:${d.revision}:${d.created}`} draft={d} scope={options.find((a) => a.id === id)?.detail ?? "Current project"} edit={transport.editCreation} reload={creations.reload} /> })) ?? []),
                  ...open.filter((p) => p.run_id === selected?.run).slice(0, 4).map((p) => ({ id: `proposal-${p.id}`, at: Date.parse(p.created_at), node: card(p) })),
                ]}
              />
              {error && (
                <p className="agent-chat-notice" role="status">
                  {error}
                </p>
              )}
            </div>
          </div>
          <div className="agent-conversation-width agent-compose-wrap">
            {helpResult && <p className="agent-help-result" role="status">
              {helpResult.issue ? <>Created <a href={helpResult.issue} target="_blank" rel="noreferrer">Agentbox issue #{helpResult.issue.split("/").at(-1)}</a> for Vulcan to triage.</> : helpResult.result}
            </p>}
            {target === "new" || selected?.writable ? <AgentComposer
              key={`${id}:${target}`}
              id={`${id}:${target}`}
              run={selected?.run}
              recoverFrom={[id, ...(target !== "new" ? [`${id}:new`] : [])]}
              attachments={attachments}
              name={name}
              send={send}
              receipt={receipt}
              disabled={disabled || !!railError}
              onGuidanceApplied={() => setGuidance(null)}
              guidance={
                guidance && guidance.proposal.run_id === selected?.run
                  ? {
                      ...guidance,
                      context: {
                        proposal: guidance.proposal.id,
                        run: guidance.proposal.run_id,
                      },
                    }
                  : null
              }
            /> : <div className="agent-chat-notice">Read-only conversation. {selected?.successor && <a href={hrefOf({ page: "agents", id, view: "chat", thread: selected.successor })}>Open current session</a>}
              {transport.sessionAction && selected?.canRestore && (selected.cacheWarmUntil ?? 0) > now &&
                <Button variant="ghost" loading={sessionBusy} onClick={() => void manageSession("restore")}>Restore cached session</Button>}
            </div>}
            {transport.help && <p className="agent-help-hint"><code>/help &lt;feedback&gt;</code> reports an issue or improvement to Agentbox on GitHub.</p>}
          </div>
        </>
      )}
    </div>
    </AgentBrowser>
  );
}
