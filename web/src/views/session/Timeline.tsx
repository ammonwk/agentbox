import { createContext, memo, startTransition, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Btw, MateMessage, QueuedMessage, Session, TimelineEvent, Turn } from "../../../../src/core/types";
import { api, useAppState, useBtw, useTimeline } from "../../api";
import { fmtDur, fmtHourMin } from "../../lib/format";
import { Button, Empty, Icon, Spinner } from "../../components";
import { firstLine, groupTimeline, rowEventIds, traceTurns, withBtw, type TimelineRow } from "../../lib/timeline";
import { field, type SendCall } from "../../lib/sendtool";
import { inputFields, labelOf, type InputField } from "../../lib/toolinput";
import { Markdown } from "./Markdown";
import { AskRow, QuestionCard } from "./Question";
import { anchoredScrollTop, isAtTop, isPinnedToBottom, shouldAutoScroll } from "./scroll";
import { ECHO_TTL_MS, landed, onEcho, type Echo } from "./echo";
import { MessageRail, useTurns } from "./MessageRail";
import { takeJump } from "./jump";
import { useFamily } from "./family";
import { PROVIDER_LABEL, StatusDot } from "../../bits";
import { shownStatus, titleOf } from "../../lib/board";
import { hrefOf } from "../../route";
import { readSent, splitPastes } from "../../../../src/core/sent";
import { BoardSessions, LocalAgents, senderOf, useBoardSessions, useLocalAgents } from "./boardsessions";
import { WithImagePaths } from "./imagepaths";

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;

const NO_TURNS: Turn[] = [];
/** A step still running after this long is flagged red. */
const SLOW_MS = 120_000;
/** A thinking block older than this is an idle gap, not a thought: no duration. */
const THINK_CAP_MS = 10 * 60_000;
/** Rows painted first when a session opens: a screenful and then some. The
 *  rest of the page renders right after, off the path to the first paint —
 *  building 200 rows of markdown before showing any took up to a second. */
const FIRST_ROWS = 40;

/**
 * The conversation as the provider's transcript records it, folded into
 * provider-neutral events. Newest at the bottom; scrolling to the top pages
 * older history in, anchored so the reader does not lose their place.
 */
export function Timeline({ session }: { session: Session }) {
  const { events, ready, loadingOlder, exhausted, error, loadOlder } = useTimeline(session.id);
  const btw = useBtw(session.id);
  // The agent works on the last turn: its trace stays open-ended and its answer waits.
  const live = session.status === "running" && !session.background;
  const allRows = useMemo(() => traceTurns(withBtw(groupTimeline(events), btw, exhausted), live), [events, btw, exhausted, live]);
  // Which trace holds each event, so a jump to one inside opens it first.
  const traceOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) if (r.type === "trace") for (const x of r.rows) for (const id of rowEventIds(x)) m.set(id, r.id);
    return m;
  }, [allRows]);
  const [openTraces, setOpenTraces] = useState<ReadonlySet<string>>(new Set());
  const toggleTrace = useCallback((id: string) => {
    setOpenTraces((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  // The session whose rows are all rendered. Until then only the newest
  // `FIRST_ROWS` are, and the rest follow once those are on screen.
  const [whole, setWhole] = useState<string | null>(null);
  const staged = whole !== session.id && allRows.length > FIRST_ROWS;
  const rows = useMemo(() => (staged ? allRows.slice(-FIRST_ROWS) : allRows), [allRows, staged]);
  useEffect(() => {
    if (!ready || whole === session.id) return;
    const id = session.id;
    let t: ReturnType<typeof setTimeout> | undefined;
    // After the paint: a frame, then a task.
    const raf = requestAnimationFrame(() => {
      t = setTimeout(() => startTransition(() => setWhole(id)), 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [ready, whole, session.id]);
  const { state } = useAppState();
  const board = useMemo(() => new Map((state?.sessions ?? []).map((s) => [s.id, s])), [state?.sessions]);
  const identity = state?.onboarding.identity;
  const me = useMemo(() => ({ name: identity?.name ?? "", github: identity?.github ?? "" }), [identity?.name, identity?.github]);
  // The agents it started inside itself, by name: where each was started, or
  // failing that (its start is on a page not loaded) the first word from it.
  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const ev of events) {
      const n =
        ev.kind === "tool" && (ev.name === "Agent" || ev.name === "Task")
          ? field(ev.input, "name")
          : ev.kind === "meta" && ev.mate
            ? ev.mate.name
            : null;
      if (n && !m.has(n) && !board.has(n)) m.set(n, ev.id);
    }
    return m;
  }, [events, board]);
  // Sent mid-turn and held by the agent until its current step yields.
  const queued = session.queued;
  const echoes = useEchoes(session.id, events, queued);
  // The turn is open but nothing has landed: the agent is thinking (a running
  // tool has a row of its own, spinning, so this is only for the gap before
  // the next step is written). The terminal shows the same state.
  const lastEv = events[events.length - 1];
  const thinking = session.status === "running" && !(lastEv?.kind === "tool" && lastEv.status === "running");
  // When the current wait began: the last step's end, or the session's last activity.
  const liveSince = lastEv
    ? lastEv.kind === "tool" && typeof lastEv.endedAt === "number" && lastEv.endedAt > lastEv.at
      ? lastEv.endedAt
      : lastEv.at
    : (session.lastActivityAt ?? Date.now());
  // Ticks once a second while the turn runs, so live durations advance.
  const now = useNow(session.status === "running");
  // How long each thinking block took: the gap from the previous step's end.
  const thinkDur = useMemo(() => {
    const m = new Map<string, number>();
    let prev: { at: number; end: number } | null = null;
    for (const ev of events) {
      const end = ev.kind === "tool" && typeof ev.endedAt === "number" && ev.endedAt > ev.at ? ev.endedAt : ev.at;
      if (ev.kind === "thinking" && prev && ev.at > prev.at) {
        const d = ev.at - prev.end;
        if (d > 0 && d <= THINK_CAP_MS) m.set(ev.id, d);
      }
      prev = { at: ev.at, end };
    }
    return m;
  }, [events]);

  const boxRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const prev = useRef({ count: 0, firstId: "", scrollTop: 0, scrollHeight: 0, initial: true });

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || events.length === 0) return;
    const p = prev.current;
    const firstId = events[0].id;
    if (!p.initial && p.firstId && firstId !== p.firstId && events.length > p.count) {
      // Older history landed above the reader: hold their place.
      el.scrollTop = anchoredScrollTop(p, el);
    } else if (shouldAutoScroll({ wasPinned: pinned, grew: events.length >= p.count, initial: p.initial })) {
      el.scrollTop = el.scrollHeight;
    }
    prev.current = { count: events.length, firstId, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, initial: false };
  }, [events, pinned, echoes.length, queued.length, btw, thinking]);

  // A question came up while you were at the tail (or the session opened on
  // one): show it from its top, which a card taller than the view would
  // otherwise have scrolled past.
  const question = session.question;
  useLayoutEffect(() => {
    const el = boxRef.current;
    const card = el?.querySelector<HTMLElement>(".ask-live");
    if (!el || !card || !pinned) return;
    el.scrollTop = el.scrollHeight;
    const over = el.getBoundingClientRect().top + 8 - card.getBoundingClientRect().top;
    if (over > 0) el.scrollTop -= over;
  }, [question?.id, ready]);

  // The rest of a staged page rendered above what is on screen: stay at the
  // bottom if that is where the reader was, else keep their place.
  const wasStaged = useRef(staged);
  useLayoutEffect(() => {
    const el = boxRef.current;
    const landed = wasStaged.current && !staged;
    wasStaged.current = staged;
    if (!el || !landed) return;
    const p = prev.current;
    el.scrollTop = pinned ? el.scrollHeight : anchoredScrollTop(p, el);
    prev.current = { ...p, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  }, [staged, pinned]);

  // ---- the message rail: where you are, and going to one of them
  const turnList = useTurns(session.id, session.lastActivityAt);
  const turns = turnList?.turns ?? NO_TURNS;
  const turnIds = useMemo(() => new Set(turns.map((t) => t.id)), [turns]);
  const [current, setCurrent] = useState<string | null>(null);
  const [jump, setJump] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rowOf = useCallback(
    (id: string) => boxRef.current?.querySelector<HTMLElement>(`[data-ev="${CSS.escape(id)}"]`) ?? null,
    [],
  );

  // The message you are reading: the last of yours that starts at or above
  // the top of the view — where a jump puts one.
  const frame = useRef(0);
  const findCurrent = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      const line = box.getBoundingClientRect().top + 48;
      let cur: string | null = null;
      for (const el of box.querySelectorAll<HTMLElement>("[data-ev]")) {
        if (!turnIds.has(el.dataset.ev!)) continue;
        if (el.getBoundingClientRect().top > line) break;
        cur = el.dataset.ev!;
      }
      setCurrent(cur);
    });
  }, [turnIds]);
  useEffect(findCurrent, [findCurrent, events]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // One handed over from the terminal's rail.
  useEffect(() => {
    const j = takeJump(session.id);
    if (j) {
      setJump(j.turnId);
      setNote(j.note ?? null);
    }
  }, [session.id]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  // Go to it once it is rendered, paging older history in until it is.
  useEffect(() => {
    if (!jump || !ready || staged) return;
    const box = boxRef.current;
    const el = rowOf(jump);
    if (box && el) {
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
      el.classList.remove("mr-flash");
      void el.offsetWidth; // restart the animation on a second jump to the same row
      el.classList.add("mr-flash");
      setTimeout(() => el.classList.remove("mr-flash"), 1900);
      setJump(null);
      return;
    }
    const trace = traceOf.get(jump);
    if (trace && !openTraces.has(trace)) toggleTrace(trace);
    else if (exhausted || error) setJump(null);
    else if (!loadingOlder) loadOlder(1000);
  }, [jump, ready, staged, events, exhausted, error, loadingOlder, loadOlder, rowOf, traceOf, openTraces, toggleTrace]);

  const local = useMemo(() => ({ names: agentNames, jump: (id: string) => setJump(id) }), [agentNames]);

  const toLatest = () => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  const step = (dir: -1 | 1) => {
    const box = boxRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    if (dir === -1) {
      // The last message that starts above the view. One not loaded yet is
      // older than everything that is, so above it too.
      let to: Turn | null = null;
      for (const t of turns) {
        const el = rowOf(t.id);
        if (!el || el.getBoundingClientRect().top < top + 4) to = t;
      }
      if (to) setJump(to.id);
    } else {
      const to = turns.find((t) => {
        const el = rowOf(t.id);
        return el && el.getBoundingClientRect().top > top + 20;
      });
      if (to) setJump(to.id);
      else toLatest();
    }
  };

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    prev.current.scrollTop = el.scrollTop;
    prev.current.scrollHeight = el.scrollHeight;
    const nowPinned = isPinnedToBottom(el);
    if (nowPinned !== pinned) setPinned(nowPinned);
    if (isAtTop(el) && !exhausted && !loadingOlder) loadOlder();
    findCurrent();
  };

  const renderRow = (r: Exclude<TimelineRow, { type: "trace" }>) =>
    r.type === "tools" ? (
      <ToolRun key={r.id} events={r.events} now={now} />
    ) : r.type === "idle" ? (
      <IdleRow key={r.id} events={r.events} />
    ) : r.type === "btw" ? (
      <BtwCard key={`btw-${r.btw.id}`} btw={r.btw} sessionId={session.id} />
    ) : r.type === "ask" ? (
      // The one being asked now is the card at the tail, not a record yet.
      question?.id === r.event.ask.id ? null : <AskRow key={r.event.id} ev={r.event} />
    ) : r.type === "sent" ? (
      <SentRow key={r.event.id} ev={r.event} send={r.send} />
    ) : (
      <EventRow key={r.event.id} ev={r.event} dur={thinkDur.get(r.event.id)} />
    );

  // Just started, and the CLI has not written its first turn: what you asked
  // and the agent coming up, not an empty page. One that stopped before
  // writing anything gets the plain explanation below.
  const up = session.status !== "stopped" && session.status !== "closed";
  if (up && (ready ? events.length === 0 : Date.now() - session.startedAt < STARTING_MS)) {
    return (
      <Me.Provider value={me}>
        <Starting session={session} />
      </Me.Provider>
    );
  }
  if (!ready) {
    return (
      <div className="sx-panel">
        <Empty title="Reading the transcript…" />
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="sx-panel">
        <Empty title="Nothing in the transcript yet">
          {session.agentSessionId
            ? "The provider has not written anything for this session. Messages and tool calls appear here as they land."
            : "The provider has not told us its session id yet, so there is no transcript to read. It usually appears within a few seconds of starting."}
        </Empty>
      </div>
    );
  }

  return (
    <BoardSessions.Provider value={board}>
    <LocalAgents.Provider value={local}>
    <Me.Provider value={me}>
    <div className="tl-wrap">
      <div className="sx-panel tl" ref={boxRef} onScroll={onScroll} tabIndex={0} aria-label="Timeline">
        <div className="tl-edge" role="status">
          {loadingOlder ? (
            <>
              <Spinner size={12} /> Loading earlier events…
            </>
          ) : error ? (
            <>
              Could not load earlier events: {error}{" "}
              <button className="linkish" onClick={() => loadOlder()}>
                retry
              </button>
            </>
          ) : exhausted ? (
            "Start of the conversation"
          ) : (
            <button className="linkish" onClick={() => loadOlder()}>
              Load earlier
            </button>
          )}
        </div>
        <div className="tl-stream">
          {rows.map((r) =>
            r.type === "trace" ? (
              <Trace
                key={r.id}
                row={r}
                open={openTraces.has(r.id)}
                onToggle={toggleTrace}
                now={now}
                tail={thinking && r.live ? <ThinkingLive since={liveSince} now={now} background={false} /> : null}
              >
                {(inner) => inner.map((x) => renderRow(x))}
              </Trace>
            ) : (
              renderRow(r)
            ),
          )}
          {question ? <QuestionCard key={question.id} sessionId={session.id} ask={question} /> : null}
          {queued.map((q, i) => (
            <UserRow key={`q${i}:${q.at}`} ev={{ id: `queued:${q.at}`, at: q.at, kind: "user", text: q.text }} queued />
          ))}
          {echoes.map((e) => (
            <Bubble key={e.at} at={e.at} className="tl-echo" note="Sending…" title="Sent; the agent has not recorded it yet" copy={e.text}>
              <Markdown text={e.text} />
            </Bubble>
          ))}
          {thinking && session.background ? <ThinkingLive since={liveSince} now={now} background /> : null}
        </div>
      </div>
      {!pinned ? (
        <div className="tl-jump">
          <Button size="sm" icon={Icon.arrowDown} onClick={toLatest}>
            Latest
          </Button>
        </div>
      ) : null}
      {note ? (
        <div className="tl-note" role="status">
          {note}
        </div>
      ) : null}
      <MessageRail
        turns={turns}
        total={turnList?.total ?? 0}
        current={pinned && current === turns[turns.length - 1]?.id ? null : current}
        busy={jump}
        onJump={(t) => setJump(t.id)}
        onStep={step}
      />
    </div>
    </Me.Provider>
    </LocalAgents.Provider>
    </BoardSessions.Provider>
  );
}

/**
 * An agent's work, every step in view, for the agents a session runs inside
 * itself (AgentView.tsx): the same rows as the timeline, without the folding
 * into turns — one agent's run is one turn, and its steps are the point. What
 * it was asked was not typed by you, so it is framed as `from` sent it.
 */
export function AgentSteps({ events, live, from }: { events: readonly TimelineEvent[]; live: boolean; from: string }) {
  const rows = useMemo(() => groupTimeline(events), [events]);
  const now = useNow(live);
  return (
    <div className="tl-stream">
      {rows.map((r) =>
        r.type === "tools" ? (
          <ToolRun key={r.id} events={r.events} now={now} />
        ) : r.type === "idle" ? (
          <IdleRow key={r.id} events={r.events} />
        ) : r.type === "ask" ? (
          <AskRow key={r.event.id} ev={r.event} />
        ) : r.type === "sent" ? (
          <SentRow key={r.event.id} ev={r.event} send={r.send} />
        ) : r.type === "event" && r.event.kind === "user" ? (
          <div key={r.event.id} className="tl-user tl-sent" data-ev={r.event.id}>
            <div className="tl-who">
              <Icon.send size={12} /> {from}
              <time className="tl-time">{fmtHourMin(r.event.at)}</time>
            </div>
            <Clamp lines={8}>
              <Markdown text={r.event.text} />
            </Clamp>
          </div>
        ) : r.type === "event" ? (
          <EventRow key={r.event.id} ev={r.event} />
        ) : null,
      )}
    </div>
  );
}

/** Who "you" are, for the picture beside your messages. */
const Me = createContext<{ name: string; github: string }>({ name: "", github: "" });

/** Messages sent from here that the transcript has not caught up with. */
function useEchoes(sessionId: string, events: readonly TimelineEvent[], queued: readonly QueuedMessage[]): Echo[] {
  const [sent, setSent] = useState<Echo[]>([]);
  useEffect(() => onEcho((e) => e.sessionId === sessionId && setSent((xs) => [...xs, e])), [sessionId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (sent.length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [sent.length]);
  const users = useMemo(() => events.filter((e): e is Extract<TimelineEvent, { kind: "user" }> => e.kind === "user").slice(-20), [events]);
  // In the agent's queue is as good as landed: the queued row stands in for it.
  const live = sent.filter((e) => Date.now() - e.at < ECHO_TTL_MS && !landed(e, users) && !landed(e, queued));
  useEffect(() => {
    if (live.length !== sent.length) setSent(live);
  });
  return live;
}

/** Ticks once a second while `active`, so live durations advance. */
function useNow(active: boolean): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

const EventRow = memo(function EventRow({ ev, dur }: { ev: Exclude<TimelineEvent, ToolEvent>; dur?: number }) {
  switch (ev.kind) {
    case "user":
      return <UserRow ev={ev} />;
    case "assistant":
      return <AssistantRow ev={ev} />;
    case "thinking":
      return <Thinking text={ev.text} dur={dur} />;
    case "meta":
      if (ev.mate) return <MateRow id={ev.id} mate={ev.mate} />;
      return (
        <div className={`tl-meta tone-${ev.tone ?? "info"}`}>
          {ev.tone === "warn" || ev.tone === "error" ? <Icon.alert size={12} /> : null}
          <span>{ev.text}</span>
        </div>
      );
  }
});

/**
 * Something said to the agent. What you typed is yours, in a bubble on the
 * right; what another agent sent — through `agentbox send`, Claude's own
 * delivery between sessions, or agentbox's own notes — is one quiet line,
 * "agentbox", that opens on a click to who sent it (linked) and all of it.
 * Pastes are shown as pastes: Claude records one wrapped in `<pasted_content>`.
 */
function UserRow({ ev, queued }: { ev: Extract<TimelineEvent, { kind: "user" }>; queued?: boolean }) {
  const sent = useMemo(() => readSent(ev.text), [ev.text]);
  const parts = useMemo(() => splitPastes(sent.text), [sent.text]);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const body = parts.map((p, i) =>
    p.kind === "paste" ? (
      <Clamp key={i} className="tl-paste" lines={8} label="Pasted">
        <Markdown text={p.text} />
      </Clamp>
    ) : (
      <Markdown key={i} text={p.text} />
    ),
  );
  if (!sent.agent) {
    const images = ev.images ? `${ev.images} image${ev.images === 1 ? "" : "s"}` : null;
    return (
      <Bubble id={ev.id} at={ev.at} className={queued ? "tl-queued" : undefined} note={[images, queued ? "Queued" : null].filter(Boolean).join(" · ")} copy={sent.text}>
        {body}
      </Bubble>
    );
  }
  const queuedNote = queued ? (
    <span className="faint" title="Waiting in the agent's queue: it arrives when the current step yields">
      {" "}
      · queued
    </span>
  ) : null;
  return (
    <div className={`tl-user tl-sent tl-sent-fold${open ? " is-open" : ""}${queued ? " tl-queued" : ""}`} data-ev={ev.id}>
      <button type="button" className="tl-sent-toggle" aria-expanded={open} aria-controls={bodyId} title={open ? "Hide the message" : "Show who sent it and the whole message"} onClick={() => setOpen(!open)}>
        <Icon.send size={12} /> <span className="tl-sent-label">agentbox</span>
        {open ? null : queuedNote}
      </button>
      {open ? (
        <div id={bodyId} className="tl-sent-full">
          <div className="tl-who">
            <Party name={sent.from} />
            {sent.via ? <span className="tl-via">via {sent.via}</span> : null}
            {queuedNote}
            <time className="tl-time">{fmtHourMin(ev.at)}</time>
          </div>
          {/* Opened on purpose: all of it, pastes too, with no second "Show all". */}
          {parts.map((p, i) =>
            p.kind === "paste" ? (
              <div key={i} className="tl-clamp tl-paste">
                <div className="tl-clamp-label">Pasted</div>
                <div className="tl-clamp-body">
                  <Markdown text={p.text} />
                </div>
              </div>
            ) : (
              <Markdown key={i} text={p.text} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Your message, the way a chat app sets it: a bubble on the right beside
 * your picture, and under it a copy button and the time. `note` says what
 * else is true of it — its images, that it waits in the queue.
 */
function Bubble({ id, at, className, note, title, copy, children }: { id?: string; at: number; className?: string; note?: string; title?: string; copy: string; children: React.ReactNode }) {
  return (
    <div className={`tl-me${className ? ` ${className}` : ""}`} data-ev={id} title={title}>
      <div className="tl-me-row">
        <div className="tl-bubble">{children}</div>
        <Avatar />
      </div>
      <div className="tl-me-foot">
        <CopyIcon text={copy} />
        {note ? <span>{note}</span> : null}
        <time dateTime={new Date(at).toISOString()}>{fmtHourMin(at)}</time>
      </div>
    </div>
  );
}

/** How long after its start a session still reads as starting while its
 *  transcript loads, rather than "Reading the transcript…". */
const STARTING_MS = 60_000;

/** A session between its start and its CLI's first written turn: the prompt
 *  it was started with, sending, and the agent starting under it. */
function Starting({ session }: { session: Session }) {
  return (
    <div className="sx-panel tl">
      <div className="tl-stream">
        {session.firstPrompt ? (
          <Bubble at={session.startedAt} className="tl-echo" note="Sending…" copy={session.firstPrompt}>
            <Markdown text={session.firstPrompt} />
          </Bubble>
        ) : null}
        <div className="tl-starting" role="status">
          <Spinner size={14} /> Starting {PROVIDER_LABEL[session.provider]}…
        </div>
      </div>
    </div>
  );
}

/** Your GitHub picture, or your initials when there is none. */
function Avatar() {
  const me = useContext(Me);
  const [failed, setFailed] = useState(false);
  if (me.github && !failed) {
    return <img className="tl-avatar" src={`https://github.com/${encodeURIComponent(me.github)}.png?size=80`} alt="" onError={() => setFailed(true)} />;
  }
  const initials = me.name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="tl-avatar" aria-hidden="true">
      {initials || <Icon.user size={15} />}
    </span>
  );
}

function CopyIcon({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="tl-me-copy"
      aria-label={done ? "Copied" : "Copy the message"}
      title={done ? "Copied" : "Copy"}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}
    >
      {done ? <Icon.check size={14} /> : <Icon.copy size={14} />}
    </button>
  );
}

/** The session at the other end of a message, linked, with what it is doing;
 *  its name as given when it is not on the board. */
function Party({ name }: { name: string | null }) {
  const board = useBoardSessions();
  const { byName, tab } = useFamily();
  const local = useLocalAgents();
  const s = name ? senderOf(name, board, byName) : null;
  const started = !s && name ? local.names.get(name) : undefined;
  if (started) {
    return (
      <a
        className="tl-sender"
        href={`#ev:${started}`}
        title="An agent this session started; go to where it was started"
        onClick={(e) => {
          e.preventDefault();
          local.jump(started);
        }}
      >
        <span className="tl-sender-name">{name}</span>
      </a>
    );
  }
  if (!s) {
    // Claude addresses a session it has no name for by its socket.
    const shown = !name ? "An agent" : name.startsWith("uds:") ? "a Claude session" : name === "main" ? "its caller" : name;
    const why = !name ? "Sent before agentbox recorded who sends a message, or from outside any session it runs" : name;
    return (
      <span className="tl-sender" title={why}>
        {shown}
      </span>
    );
  }
  return (
    <a className="tl-sender" href={hrefOf({ page: "session", id: s.id, tab })} title={`Open ${titleOf(s)} (${s.id})`}>
      <StatusDot status={shownStatus(s)} />
      <span className="tl-sender-name">{titleOf(s)}</span>
      <span className="tl-sender-id">{s.id}</span>
    </a>
  );
}

/**
 * A message this agent sent another, from whichever tool carried it: who to,
 * what it said, and whether it went. Set on the right, the way a sent message
 * is; the call itself is one click away.
 */
function SentRow({ ev, send }: { ev: ToolEvent; send: SendCall }) {
  const [open, setOpen] = useState(false);
  const failed = ev.status === "error" || /^\s*\{\s*"success"\s*:\s*false/.test(ev.output ?? "");
  const call =
    ev.input || ev.output ? (
      <button className="linkish tl-clamp-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide the call" : "The call"}
      </button>
    ) : null;
  return (
    <div className={`tl-user tl-sent tl-out${failed ? " is-failed" : ""}`} data-ev={ev.id}>
      <div className="tl-who">
        <Icon.send size={12} /> <span className="tl-to">To</span> <Party name={send.to} />
        <span className="tl-via">via {send.via}</span>
        {ev.status === "running" ? (
          <span className="tl-via">
            <Spinner size={11} /> sending…
          </span>
        ) : failed ? (
          <span className="tl-out-err">
            <Icon.alert size={12} /> not delivered
          </span>
        ) : null}
        <time className="tl-time">{fmtHourMin(ev.at)}</time>
      </div>
      {send.text ? (
        <Clamp lines={6} foot={call}>
          <Markdown text={send.text} />
        </Clamp>
      ) : (
        <>
          <p className="faint tl-out-sealed">{ev.name.startsWith("collaboration.") ? "Codex does not show what one agent sends another." : ev.summary}</p>
          {call ? <div className="tl-clamp-foot">{call}</div> : null}
        </>
      )}
      {open ? (
        <div className="sx-tool-detail">
          {ev.input ? <ToolInput input={ev.input} title={ev.title} /> : null}
          {ev.output ? (
            <div>
              <h4>{failed ? "Error" : "Result"}</h4>
              <pre className="sx-pre">{ev.output}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Long content cut to its first `lines`, with a button for the rest. Measured,
 * so short content gets no button.
 */
function Clamp({
  lines,
  className,
  label,
  foot,
  children,
}: {
  lines: number;
  className?: string;
  label?: string;
  /** More to put on the line "Show all" goes on. */
  foot?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOver(el.scrollHeight > el.clientHeight + 4);
  });
  return (
    <div className={`tl-clamp${className ? ` ${className}` : ""}`}>
      {label ? <div className="tl-clamp-label">{label}</div> : null}
      <div ref={ref} className={`tl-clamp-body${open ? "" : " is-clamped"}${over && !open ? " is-over" : ""}`} style={{ "--lines": lines } as React.CSSProperties}>
        {children}
      </div>
      {over || open || foot ? (
        <div className="tl-clamp-foot">
          {over || open ? (
            <button className="linkish tl-clamp-more" onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show all"}
            </button>
          ) : null}
          {foot}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Codex closes an answer that drew on its memory with an `<oai-mem-citation>`
 * block of file ranges and rollout ids. Not prose: a quiet line naming the files.
 */
const MEM_CITE = /(?:^|\n)[ \t]*<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>[\s\S]*?(?:<\/oai-mem-citation>|(?![\s\S]))/g;

/** The block is taken only whole and on a line of its own: prose that names
 *  the tag (`<oai-mem-citation>` in backticks) is left as it is. */
function citations(text: string): { text: string; cites: string[] } {
  if (!text.includes("<oai-mem-citation>")) return { text, cites: [] };
  const cites: string[] = [];
  const rest = text.replace(MEM_CITE, (_, entries: string) => {
    for (const line of entries.split("\n")) {
      const t = line.trim();
      if (t) cites.push(t);
    }
    return "";
  });
  return { text: rest.trim(), cites };
}

function AssistantRow({ ev }: { ev: Extract<TimelineEvent, { kind: "assistant" }> }) {
  const { text, cites } = useMemo(() => citations(ev.text), [ev.text]);
  return (
    <div className="tl-assistant">
      <Markdown text={text} />
      {cites.length ? (
        <div className="tl-cites">
          From memory:{" "}
          {cites.map((c, i) => {
            const [where, note] = c.split("|note=");
            return (
              <code key={i} className="sx-fileref" title={note?.replace(/^\[|\]$/g, "")}>
                {where}
              </code>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type Flat = Exclude<TimelineRow, { type: "trace" }>;

/**
 * A turn's work — thinking, tool calls, what the agent said on the way —
 * folded to one line, so the conversation reads as messages and answers.
 * While the agent works, the line says what it does now and for how long.
 */
function Trace({
  row,
  open,
  onToggle,
  now,
  tail,
  children,
}: {
  row: Extract<TimelineRow, { type: "trace" }>;
  open: boolean;
  onToggle: (id: string) => void;
  now: number;
  /** Under the open trace: the wait for the next step. */
  tail: React.ReactNode;
  children: (rows: Flat[]) => React.ReactNode;
}) {
  const steps = useMemo(() => {
    let steps = 0;
    for (const r of row.rows) {
      if (r.type === "tools") {
        steps += r.events.length;
      } else steps++;
    }
    return steps;
  }, [row.rows]);
  const ms = Math.max(0, (row.live ? now : row.to) - row.from);
  return (
    <div className={`tl-trace${open ? " is-open" : ""}${row.live ? " is-live" : ""}`}>
      <button className="tl-trace-head" aria-expanded={open} onClick={() => onToggle(row.id)} title={open ? "Hide the work" : "Show the work"}>
        {row.live ? <Spinner size={12} /> : null}
        <span className="tl-trace-label">{row.live ? "Working" : ms >= 1000 ? `Worked for ${fmtDur(ms)}` : "Worked"}</span>
        {row.live && ms >= 1000 ? <span className="tl-dur">{fmtDur(ms)}</span> : null}
        {row.live ? (
          <span className="tl-trace-now">
            <NowDoing rows={row.rows} />
          </span>
        ) : steps ? (
          <span className="tl-trace-n">
            {steps} step{steps === 1 ? "" : "s"}
          </span>
        ) : null}
        <Icon.chevronRight size={12} className="tl-trace-chev" />
      </button>
      {open ? (
        <div className="tl-trace-body">
          {children(row.rows)}
          {tail}
        </div>
      ) : null}
    </div>
  );
}

/** What the agent does now, from the last step of its trace. */
function NowDoing({ rows }: { rows: Flat[] }) {
  const r = rows[rows.length - 1];
  if (r?.type === "tools") {
    const e = r.events[r.events.length - 1]!;
    if (e.status === "running") {
      // An MCP tool by its own name, and its input only when it is not raw JSON.
      const name = e.name.startsWith("mcp__") ? e.name.split("__").pop() : e.name;
      const what = e.title || (/^\s*[[{]/.test(e.summary) ? "" : shortCommand(e.summary));
      return (
        <>
          <b>{name}</b> {what}
        </>
      );
    }
  }
  if (r?.type === "event" && r.event.kind === "assistant") return <>{firstLine(r.event.text, 200)}</>;
  return <>Thinking…</>;
}

/**
 * A message from another member of the agent team. The name opens its
 * session; what it said opens in place. An idle notice that reported nothing
 * is one quiet line — a lead hears one every time a teammate's turn ends.
 */
function MateRow({ id, mate }: { id: string; mate: MateMessage }) {
  const [open, setOpen] = useState(false);
  const { byName, tab } = useFamily();
  const local = useLocalAgents();
  const to = byName.get(mate.name) ?? null;
  // Not a session: an agent started inside this one. Its name goes to where it started.
  const started = !to ? local.names.get(mate.name) : undefined;
  const failed = mate.idle?.startsWith("failed") ?? false;
  const name = to && mate.name === "team-lead" ? `${titleOf(to)} (lead)` : mate.name;
  const who = (
    <span className="tl-mate-who" data-color={mate.color}>
      {to ? <StatusDot status={shownStatus(to)} /> : <span className="tl-mate-swatch" aria-hidden="true" />}
      {to ? (
        <a href={hrefOf({ page: "session", id: to.id, tab })} title={`Open ${titleOf(to)}`} onClick={(e) => e.stopPropagation()}>
          {name}
        </a>
      ) : started && started !== id ? (
        <a
          href={`#ev:${started}`}
          title="An agent this session started; go to where it was started"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            local.jump(started);
          }}
        >
          {name}
        </a>
      ) : (
        <span>{name}</span>
      )}
    </span>
  );
  const said = mate.summary ?? firstLine(mate.body);
  if (!mate.body) {
    return (
      <div className={`tl-mate tl-mate-quiet${failed ? " is-failed" : ""}`} data-ev={id}>
        {who}
        <span className="tl-mate-said">{mate.idle !== undefined ? (failed ? mate.idle.replace(/^failed: ?/, "stopped: ") : "is idle") : <Markdown inline text={said} />}</span>
      </div>
    );
  }
  return (
    <div className={`tl-mate${failed ? " is-failed" : ""}`} data-ev={id}>
      <button className="tl-mate-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {who}
        <span className="tl-mate-said">
          {mate.idle !== undefined ? <span className="faint">finished · </span> : null}
          <Markdown inline text={said} />
        </span>
        <Icon.chevronDown size={12} className={open ? "rot" : undefined} />
      </button>
      {open ? (
        <div className="tl-mate-body">
          <Markdown text={mate.body} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A side question and its answer. Beside the conversation, not in it: Claude
 * answered it from what it knew then, and the agent never saw it.
 */
function BtwCard({ btw, sessionId }: { btw: Btw; sessionId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={`tl-btw is-${btw.status}`}>
      <div className="tl-who">
        <span className="tl-btw-tag">/btw</span> You
        {btw.source === "terminal" ? <span className="faint"> · in the terminal</span> : null}
        <time className="tl-time">{fmtHourMin(btw.askedAt)}</time>
        <Button
          variant="ghost"
          size="sm"
          icon={Icon.x}
          className="tl-btw-x"
          aria-label="Dismiss"
          title="Dismiss"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.btwDismiss(sessionId, btw.id).catch(() => setBusy(false));
          }}
        />
      </div>
      <div className="tl-btw-q">
        <Markdown text={btw.question} />
      </div>
      <div className="tl-btw-a">
        {btw.status === "asking" ? (
          <span className="faint">
            <Spinner size={11} /> Answering…
          </span>
        ) : btw.status === "failed" ? (
          <span className="tl-btw-err">
            <Icon.alert size={12} /> No answer: {btw.error}
          </span>
        ) : (
          <Markdown text={btw.answer ?? ""} />
        )}
      </div>
    </div>
  );
}

/** Teammates that finished a turn with nothing to say, each named once and linked. */
function IdleRow({ events }: { events: { at: number; mate: MateMessage }[] }) {
  const { byName, tab } = useFamily();
  const names = [...new Set(events.map((e) => e.mate.name))];
  return (
    <div className="tl-mate tl-mate-quiet">
      <span className="tl-mate-said">
        {names.map((n, i) => {
          const to = byName.get(n);
          return (
            <span key={n}>
              {i ? ", " : null}
              {to ? <a href={hrefOf({ page: "session", id: to.id, tab })}>{n}</a> : n}
            </span>
          );
        })}{" "}
        {names.length === 1 ? "is" : "are"} idle
      </span>
    </div>
  );
}

/** One line — how long, and how the thought began — and the whole of it on click. */
function Thinking({ text, dur }: { text: string; dur?: number }) {
  const [open, setOpen] = useState(false);
  const body = text.trim();
  return (
    <div className="tl-thinking">
      <button className="tl-thinking-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon.brain size={13} />
        <span className="tl-thinking-label">Thinking</span>
        {dur !== undefined ? <span className="tl-dur">{fmtDur(dur)}</span> : null}
        <span className="tl-thinking-fill">{open ? null : <Markdown inline text={firstLine(body, 400)} />}</span>
        <Icon.chevronDown size={12} className={open ? "rot" : undefined} />
      </button>
      {open ? (
        <div className="tl-thinking-body">
          <Markdown text={body} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The gap before the next step lands: thinking, with a live clock that goes
 * red past two minutes. With the turn over and only background work going,
 * it is waiting instead, and a long wait is no sign of trouble.
 */
function ThinkingLive({ since, now, background }: { since: number; now: number; background: boolean }) {
  const ms = Math.max(0, now - since);
  if (background) {
    return (
      <div className="tl-live" role="status" title="The turn is over; it is waiting on teammates, background agents or shells it started">
        Waiting… <span className="tl-dur">{fmtDur(ms)}</span>
      </div>
    );
  }
  return (
    <div className={`tl-live${ms > SLOW_MS ? " is-slow" : ""}`} role="status" title="The turn is running and its next step has not landed in the transcript yet">
      <Spinner size={12} /> Thinking… <span className="tl-dur">{fmtDur(ms)}</span>
    </div>
  );
}

function ToolRun({ events, now }: { events: ToolEvent[]; now: number }) {
  return (
    <div className="sx-run">
      {events.map((e) => (
        <ToolRow key={e.id} ev={e} now={e.status === "running" ? now : 0} />
      ))}
    </div>
  );
}

const ToolRow = memo(function ToolRow({ ev, now }: { ev: ToolEvent; now: number }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(ev.input || ev.output);
  const running = ev.status === "running";
  // A finished call shows how long it took; a live one ticks until its result lands.
  const took = running ? (now > 0 ? Math.max(0, now - ev.at) : null) : typeof ev.endedAt === "number" && ev.endedAt > ev.at ? ev.endedAt - ev.at : null;
  const slow = running && now > 0 && now - ev.at > SLOW_MS;
  return (
    <>
      <button
        className={`sx-tool ${ev.status}`}
        data-ev={ev.id}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        title={running && took !== null ? `Running for ${fmtDur(took)}` : undefined}
      >
        <span className="sx-tool-glyph" aria-hidden="true">
          {running ? <Spinner size={11} /> : ev.status === "error" ? <Icon.x size={13} /> : <Icon.check size={13} />}
        </span>
        <span className="sx-tool-title">{ev.name}</span>
        {ev.title ? (
          <span className="sx-tool-desc">
            <Markdown inline text={ev.title} />
          </span>
        ) : null}
        <span className="sx-tool-sub">
          <WithImagePaths text={shortCommand(ev.summary)} />
        </span>
        <span className={`sx-tool-status ${ev.status}${slow ? " is-slow" : ""}`}>
          {running ? (now > 0 ? fmtDur(now - ev.at) : "running") : ev.status === "error" ? `error${ev.endedAt && ev.endedAt > ev.at ? ` · ${fmtDur(ev.endedAt - ev.at)}` : ""}` : typeof ev.endedAt === "number" && ev.endedAt > ev.at ? fmtDur(ev.endedAt - ev.at) : ""}
        </span>
        {hasDetail ? <Icon.chevronDown size={12} className={open ? "rot" : undefined} /> : null}
      </button>
      {open && hasDetail ? (
        <div className="sx-tool-detail">
          {ev.input ? <ToolInput input={ev.input} title={ev.title} /> : null}
          {ev.output ? (
            <div>
              <h4>{ev.status === "error" ? "Error" : "Output"}</h4>
              <pre className="sx-pre">{ev.output}</pre>
            </div>
          ) : ev.status === "running" ? (
            <p className="faint">No result yet — it is still running.</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
});

/** A command without the `cd <dir> &&` agents put first: the directory takes
 *  the whole line, and the full command is one click away. */
function shortCommand(cmd: string): string {
  return cmd.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
}

/** The call's input by field: the command as a command, an edit as a diff. */
function ToolInput({ input, title }: { input: string; title?: string }) {
  const fields = useMemo(() => inputFields(input, title), [input, title]);
  if (!fields) {
    return (
      <div>
        <h4>Input</h4>
        <pre className="sx-pre">{input}</pre>
      </div>
    );
  }
  if (fields.length === 0) return null;
  return <dl className="sx-fields">{fields.map((f) => <Field key={f.key} f={f} />)}</dl>;
}

function Field({ f }: { f: InputField }) {
  return (
    <>
      <dt>{f.kind === "shell" ? "$" : labelOf(f.key)}</dt>
      <dd>
        {f.kind === "shell" ? (
          <pre className="sx-pre sx-shell">{f.text}</pre>
        ) : f.kind === "diff" ? (
          <pre className="sx-pre sx-diff">
            {f.old ? <span className="sx-del">{f.old}</span> : null}
            {f.new ? <span className="sx-add">{f.new}</span> : null}
          </pre>
        ) : f.kind === "block" ? (
          <pre className="sx-pre">{f.text}</pre>
        ) : (
          <code className="sx-inline">
            <WithImagePaths text={f.text} />
          </code>
        )}
      </dd>
    </>
  );
}

/** Read-through shared agent conversation: the same provider-neutral bubbles as
 * Sessions, without remote terminal controls or unrelated local session links. */
export function AgentConversationEvents({events}:{events:readonly TimelineEvent[]}) {
 return <div className="tl-stream">{events.filter(e=>e.kind==='user'||e.kind==='assistant').map(e=><EventRow key={e.id} ev={e as Extract<TimelineEvent,{kind:'user'|'assistant'}>} />)}</div>;
}
