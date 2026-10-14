import {
  useCallback,
  useEffect,
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
} from "../../../src/cloud/agent-conversation";
import type { HumanAgents } from "../../../src/cloud/agent-client";
import {
  AgentRun,
  type AgentBoard,
  type SharedAgent,
  type AgentAction,
} from "../../../src/cloud/agents";
import { cloudCall } from "../../../src/cloud/client";
import type { AppState, TimelineEvent } from "../../../src/core/types";
import { request } from "../api";
import { Button, Empty } from "../components";
import { useLoad } from "../lib/cloud";
import { AgentComposer } from "./session/Composer";
import { AgentConversationEvents } from "./session/Timeline";
import { Markdown } from "./session/Markdown";
import "./session/session.css";

type Receipt = { state: string; result: string };
type Transport = {
  read: (cursor: ReadCursor, signal?: AbortSignal) => Promise<ConversationPage>;
  send: (body: string, id: string, proposal?: Proposal) => Promise<Receipt>;
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
}: {
  a: SharedAgent;
  board: AgentBoard;
  api: HumanAgents;
  user: string;
  actions: AgentAction[];
  children: ReactNode;
}) {
  const conversation = useMemo(() => new AgentConversation(api.human), [api]);
  const responsible = board.runs.find(
    (r) =>
      r.agent_id === a.id &&
      ["running", "waiting", "starting", "queued"].includes(r.state),
  );
  const transport = useMemo<Transport>(
    () => ({
      read: (cursor, signal) => conversation.read(a.id, cursor, signal),
      proposals: () => conversation.proposals(a.id),
      decide: (p, choice, id) => conversation.decide(p.id, choice, id),
      receipt: (id) => conversation.receipt(id),
      send: async (body, id, proposal) => {
        const r =
          (proposal
            ? board.runs.find((r) => r.id === proposal.run_id)
            : responsible) ??
          (await cloudCall(
            api.human.sb,
            "agent_conversation_start",
            { p_agent: a.id, p_request: crypto.randomUUID() },
            AgentRun,
          ));
        return conversation.guide(a.id, r.id, id, body, proposal?.id ?? null);
      },
    }),
    [conversation, a.id, responsible?.id, api],
  );
  const mayDecide = (p: Proposal) =>
    a.maintainers.includes(user) ||
    board.work.find(
      (w) => w.id === board.runs.find((r) => r.id === p.run_id)?.work_id,
    )?.assignee === user;
  return (
    <AgentSpace
      id={a.id}
      name={a.name}
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
      mayDecide={mayDecide}
      actions={actions}
      about={children}
    />
  );
}
type LocalAgent = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  provider: string;
  repo: string | null;
  session: string | null;
  enabled: boolean;
};
export function LocalAgentSpace({
  state,
  id,
}: {
  state: AppState;
  id?: string;
}) {
  const agents = useLoad(
    () => request<LocalAgent[]>("GET", "/api/agents/local"),
    [],
  );
  const selected = agents.data?.find((a) => a.id === id);
  const transport = useMemo<Transport>(
    () => ({
      read: (cursor) => request("POST", `/api/agents/local/${id}/read`, cursor),
      proposals: () => request("GET", `/api/agents/local/${id}/proposals`),
      decide: (p, decision, requestId) =>
        request("POST", `/api/agents/local/${id}/decide`, {
          id: p.id,
          decision,
          request: requestId,
        }),
      send: (body, requestId) =>
        request("POST", `/api/agents/local/${id}/chat`, {
          body,
          request: requestId,
        }),
      receipt: (requestId) =>
        request("GET", `/api/agents/local/${id}/receipt/${requestId}`),
    }),
    [id],
  );
  if (agents.error)
    return <Empty title="Could not load local agents">{agents.error}</Empty>;
  if (!agents.data) return <Empty title="Loading agents…" />;
  if (!selected)
    return (
      <div className="agents-page agent-local-directory">
        <div>
          <h2>Your agents</h2>
          <p className="hint">
            Start a conversation. Your provider keeps the history on this
            machine.
          </p>
        </div>
        <div className="agent-directory">
          {agents.data.map((a) => (
            <a
              key={a.id}
              href={`#/agents/${a.id}`}
              className="card agent-directory-card"
            >
              <h3>{a.name}</h3>
              <p>{a.role}</p>
              <span className="hint">
                {a.session ? "Continue conversation" : "Start chatting"} →
              </span>
            </a>
          ))}
        </div>
        <p className="hint">
          Local agents · <a href="#/team">Connect a workspace</a> to share
          agents and run them on another host.
        </p>
      </div>
    );
  const session = state.sessions.find((s) => s.id === selected.session);
  return (
    <AgentSpace
      key={selected.id}
      id={selected.id}
      name={selected.name}
      status={
        !selected.enabled
          ? "Paused"
          : session?.status === "running"
            ? "Working"
            : selected.session
              ? "Available"
              : "Ready to begin"
      }
      transport={transport}
      disabled={!selected.enabled}
      mayDecide={() => true}
      about={
        <div className="agent-about">
          <h3>{selected.role}</h3>
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
                  repo: data.get("repo") || null,
                  enabled: data.get("enabled") === "on",
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
                defaultValue={selected.provider}
                disabled={!!selected.session}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
                <option value="muse">Muse</option>
              </select>
            </label>
            <label>
              Repository
              <select
                className="input"
                name="repo"
                defaultValue={selected.repo ?? ""}
                disabled={!!selected.session}
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
                name="enabled"
                defaultChecked={selected.enabled}
              />{" "}
              Enabled
            </label>
            <Button type="submit">Save</Button>
          </form>
          <a href="#/team">Connect a shared workspace</a>
        </div>
      }
    />
  );
}
function AgentSpace({
  id,
  name,
  status,
  transport,
  disabled,
  mayDecide,
  about,
  actions = [],
}: {
  id: string;
  name: string;
  status: string;
  transport: Transport;
  disabled: boolean;
  mayDecide: (p: Proposal) => boolean;
  about: ReactNode;
  actions?: AgentAction[];
}) {
  const [tab, setTab] = useState<"chat" | "about" | "feed">("chat"),
    [events, setEvents] = useState<TimelineEvent[]>([]),
    [next, setNext] = useState<ReadCursor | null>(null),
    [error, setError] = useState<string | null>(null),
    [reading, setReading] = useState(false),
    [ready, setReady] = useState(false),
    [guidance, setGuidance] = useState<{
      id: string;
      text: string;
      proposal: Proposal;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const feed = useLoad(transport.proposals, [transport]),
    bottom = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    pinned = useRef(true);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const page = await transport.read(
          { session: 0, before: null },
          controller.signal,
        );
        if (live) {
          setEvents((old) => {
            const m = new Map(old.map((e) => [e.id, e]));
            page.events.forEach((e) => m.set(e.id, e));
            return [...m.values()].sort((a, b) => a.at - b.at);
          });
          setNext((old) => old ?? page.next);
          setError(page.error ?? null);
          setReady(true);
        }
      } catch (e) {
        if (live) {
          setError((e as Error).message);
          setReady(true);
        }
      } finally {
        if (live) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    if (tab === "chat") void refresh();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, transport, tab]);
  useEffect(() => {
    const t = setInterval(() => void feed.reload(), 5000);
    return () => clearInterval(t);
  }, [feed.reload]);
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, tab]);
  const send = useCallback(
    async (body: string, requestId: string) => {
      const r = await transport.send(body, requestId, guidance?.proposal);
      setGuidance(null);
      return r;
    },
    [transport, guidance],
  );
  const receipt = useCallback(
    (requestId: string) => transport.receipt(requestId),
    [transport],
  );
  const open = feed.data?.filter((p) => p.state === "open") ?? [];
  async function decide(p: Proposal, choice: "approved" | "dismissed") {
    setBusy(true);
    setError(null);
    try {
      await transport.decide(p, choice, crypto.randomUUID());
      await feed.reload();
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
                setGuidance({
                  id: crypto.randomUUID(),
                  proposal: p,
                  text: `Regarding “${p.title}” (${p.id}): `,
                });
                setTab("chat");
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
    <div className={`agent-space agent-space-${tab}`}>
      <header className="agent-space-head">
        <a href="#/agents" className="hint" aria-label="Back to agents">
          ← Agents
        </a>
        <div>
          <h2>{name}</h2>
          <span className="agent-chat-status">{status}</span>
        </div>
        <nav aria-label="Agent views">
          {(["chat", "about", "feed"] as const).map((t) => (
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
      {tab === "about" ? (
        <div className="agent-about">{about}</div>
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
              if (el)
                pinned.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            <div className="agent-conversation-width">
              {next && (
                <Button
                  variant="ghost"
                  loading={reading}
                  onClick={() => {
                    setReading(true);
                    void transport
                      .read(next)
                      .then((page) => {
                        setEvents((old) => {
                          const m = new Map(old.map((e) => [e.id, e]));
                          page.events.forEach((e) => m.set(e.id, e));
                          return [...m.values()].sort((a, b) => a.at - b.at);
                        });
                        setNext(page.next);
                      })
                      .catch((e) => setError(e.message))
                      .finally(() => setReading(false));
                  }}
                >
                  Earlier messages
                </Button>
              )}
              {!events.length && (
                <div className="agent-chat-empty">
                  <h3>{ready ? `Talk with ${name}` : "Connecting…"}</h3>
                  <p>
                    {ready
                      ? "Share a task, ask a question, or shape what to work on next."
                      : "Reading the conversation from its execution host."}
                  </p>
                </div>
              )}
              <AgentConversationEvents events={events} />
              {open.slice(0, 4).map(card)}
              {error && (
                <p className="agent-chat-notice" role="status">
                  {error}
                </p>
              )}
              <div ref={bottom} />
            </div>
          </div>
          <div className="agent-conversation-width agent-compose-wrap">
            <AgentComposer
              key={id}
              id={id}
              name={name}
              send={send}
              receipt={receipt}
              disabled={disabled}
              guidance={guidance}
            />
          </div>
        </>
      )}
    </div>
  );
}
