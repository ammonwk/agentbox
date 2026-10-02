import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Btw, MateMessage, QueuedMessage, Session, TimelineEvent, Turn } from "../../../../src/core/types";
import { api, fmtClock, useAppState, useBtw, useTimeline } from "../../api";
import { fmtDur } from "../../lib/format";
import { Button, Empty, Icon, Spinner } from "../../components";
import { firstLine, foldSteps, groupTimeline, withBtw, type TimelineRow } from "../../lib/timeline";
import { field, type SendCall } from "../../lib/sendtool";
import { inputFields, labelOf, type InputField } from "../../lib/toolinput";
import { Markdown } from "./Markdown";
import { AskRow } from "./Question";
import { anchoredScrollTop, isAtTop, isPinnedToBottom, shouldAutoScroll } from "./scroll";
import { ECHO_TTL_MS, landed, onEcho, type Echo } from "./echo";
import { MessageRail, useTurns } from "./MessageRail";
import { takeJump } from "./jump";
import { useFamily } from "./family";
import { StatusDot } from "../../bits";
import { titleOf } from "../../lib/board";
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
  const [fold, setFold] = useFold();
  const allRows = useMemo(() => {
    const all = withBtw(groupTimeline(events), btw, exhausted);
    return fold ? foldSteps(all) : all;
  }, [events, btw, exhausted, fold]);
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

  // Esc puts a side question's card away while it is up: asking (the question
  // is taken back and the panel in the pane closes) or answered (read, done).
  // Not while typing — there Esc just blurs.
  const cards = useMemo(() => {
    const shown = allRows.filter((r) => r.type === "btw").map((r) => r.btw);
    const ids = new Set(shown.map((b) => b.id));
    return [...shown, ...btw.filter((b) => b.status === "asking" && !ids.has(b.id))];
  }, [allRows, btw]);
  useEffect(() => {
    if (cards.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      // A dialog is open, or you are typing: Esc is theirs, not the card's.
      if (document.querySelector("[role=dialog]")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      for (const b of cards) void api.btwDismiss(session.id, b.id).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, session.id]);

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
    if (exhausted || error) setJump(null);
    else if (!loadingOlder) loadOlder(1000);
  }, [jump, ready, staged, events, exhausted, error, loadingOlder, loadOlder, rowOf]);

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

  const renderRow = (r: Exclude<TimelineRow, { type: "steps" }>) =>
    r.type === "tools" ? (
      <ToolRun key={r.id} events={r.events} now={now} />
    ) : r.type === "idle" ? (
      <IdleRow key={r.id} events={r.events} />
    ) : r.type === "btw" ? (
      <BtwCard key={`btw-${r.btw.id}`} btw={r.btw} sessionId={session.id} />
    ) : r.type === "ask" ? (
      <AskRow key={r.event.id} ev={r.event} live={session.question?.id === r.event.ask.id} />
    ) : r.type === "sent" ? (
      <SentRow key={r.event.id} ev={r.event} send={r.send} />
    ) : (
      <EventRow key={r.event.id} ev={r.event} dur={thinkDur.get(r.event.id)} />
    );

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
            r.type === "steps" ? (
              <Steps key={r.id} rows={r.rows}>
                {(inner) => inner.map((x) => renderRow(x))}
              </Steps>
            ) : (
              renderRow(r)
            ),
          )}
          {queued.map((q, i) => (
            <UserRow key={`q${i}:${q.at}`} ev={{ id: `queued:${q.at}`, at: q.at, kind: "user", text: q.text }} queued />
          ))}
          {echoes.map((e) => (
            <div key={e.at} className="tl-user tl-echo" title="Sent; the agent has not recorded it yet">
              <div className="tl-who">
                <Icon.user size={13} /> You <span className="faint">· sending…</span>
                <time className="tl-time">{fmtClock(e.at)}</time>
              </div>
              <Markdown text={e.text} />
            </div>
          ))}
          {thinking ? <ThinkingLive since={liveSince} now={now} background={session.background} /> : null}
        </div>
      </div>
      <button
        className="tl-fold"
        aria-pressed={fold}
        onClick={() => setFold(!fold)}
        title={fold ? "Finished turns' thinking and tool calls are folded to one line each. Click to show them all." : "Fold each finished turn's thinking and tool calls to one line"}
        aria-label="Fold finished turns' steps"
      >
        {fold ? <Icon.unfold size={13} /> : <Icon.fold size={13} />}
      </button>
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
    </LocalAgents.Provider>
    </BoardSessions.Provider>
  );
}

const FOLD_KEY = "agentbox.timeline.fold";

/** Whether finished turns' work is folded: off unless you turn it on, and remembered. */
function useFold(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem(FOLD_KEY) === "1");
  const set = (v: boolean) => {
    setOn(v);
    localStorage.setItem(FOLD_KEY, v ? "1" : "0");
  };
  return [on, set];
}

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

/** The moment a row landed, shown while you hover it. */
function Stamp({ at, float }: { at: number; float?: boolean }) {
  return <time className={`tl-stamp${float ? " tl-stamp-float" : ""}`}>{fmtClock(at)}</time>;
}

const EventRow = memo(function EventRow({ ev, dur }: { ev: Exclude<TimelineEvent, ToolEvent>; dur?: number }) {
  switch (ev.kind) {
    case "user":
      return <UserRow ev={ev} />;
    case "assistant":
      return <AssistantRow ev={ev} />;
    case "thinking":
      return <Thinking text={ev.text} at={ev.at} dur={dur} />;
    case "meta":
      if (ev.mate) return <MateRow id={ev.id} mate={ev.mate} at={ev.at} />;
      return (
        <div className={`tl-meta tone-${ev.tone ?? "info"}`} title={fmtClock(ev.at)}>
          {ev.tone === "warn" || ev.tone === "error" ? <Icon.alert size={12} /> : null}
          <span>{ev.text}</span>
          <Stamp at={ev.at} />
        </div>
      );
  }
});

/**
 * Something said to the agent. What you typed is yours; what another agent
 * sent — through `agentbox send`, or Claude's own delivery between sessions —
 * says who sent it and links to them, in a quieter frame than yours. Pastes
 * are shown as pastes: Claude records one wrapped in `<pasted_content>`.
 */
function UserRow({ ev, queued }: { ev: Extract<TimelineEvent, { kind: "user" }>; queued?: boolean }) {
  const sent = useMemo(() => readSent(ev.text), [ev.text]);
  const parts = useMemo(() => splitPastes(sent.text), [sent.text]);
  const body = parts.map((p, i) =>
    p.kind === "paste" ? (
      <Clamp key={i} className="tl-paste" lines={8} label="Pasted">
        <Markdown text={p.text} />
      </Clamp>
    ) : (
      <Markdown key={i} text={p.text} />
    ),
  );
  const wait = queued ? (
    <span className="faint" title="Waiting in the agent's queue: it arrives when the current step yields">
      {" "}
      · queued
    </span>
  ) : null;
  const cls = queued ? " tl-queued" : "";
  if (sent.agent) {
    return (
      <div className={`tl-user tl-sent${cls}`} title={fmtClock(ev.at)} data-ev={ev.id}>
        <div className="tl-who">
          <Icon.send size={12} /> <Party name={sent.from} />
          <span className="tl-via">via {sent.via}</span>
          {wait}
          <time className="tl-time">{fmtClock(ev.at)}</time>
        </div>
        <Clamp lines={6}>{body}</Clamp>
      </div>
    );
  }
  return (
    <div className={`tl-user${cls}`} title={fmtClock(ev.at)} data-ev={ev.id}>
      <div className="tl-who">
        <Icon.user size={13} /> You
        {ev.images ? <span className="faint"> · {ev.images} image{ev.images === 1 ? "" : "s"}</span> : null}
        {wait}
        <time className="tl-time">{fmtClock(ev.at)}</time>
      </div>
      {body}
    </div>
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
      <StatusDot status={s.status} />
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
    <div className={`tl-user tl-sent tl-out${failed ? " is-failed" : ""}`} title={fmtClock(ev.at)} data-ev={ev.id}>
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
        <time className="tl-time">{fmtClock(ev.at)}</time>
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
    <div className="tl-assistant" title={fmtClock(ev.at)}>
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
      <Stamp at={ev.at} float />
    </div>
  );
}

/**
 * The work of a finished turn — its thinking and tool calls between what the
 * agent said — folded to one line, so the conversation reads through. The
 * turn still running is never folded.
 */
function Steps({ rows, children }: { rows: Exclude<TimelineRow, { type: "steps" }>[]; children: (rows: Exclude<TimelineRow, { type: "steps" }>[]) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { tools, errors, thoughts, ms } = useMemo(() => {
    let tools = 0;
    let errors = 0;
    let thoughts = 0;
    let first = Infinity;
    let last = 0;
    for (const r of rows) {
      if (r.type === "tools") {
        for (const e of r.events) {
          tools++;
          if (e.status === "error") errors++;
          first = Math.min(first, e.at);
          last = Math.max(last, typeof e.endedAt === "number" ? e.endedAt : e.at);
        }
      } else if (r.type === "event") {
        if (r.event.kind === "thinking") thoughts++;
        first = Math.min(first, r.event.at);
        last = Math.max(last, r.event.at);
      }
    }
    return { tools, errors, thoughts, ms: last > first ? last - first : 0 };
  }, [rows]);
  const said = [thoughts ? `thought${thoughts > 1 ? ` ×${thoughts}` : ""}` : null, tools ? `${tools} tool call${tools === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <div className={`tl-steps${open ? " is-open" : ""}`}>
      <button className="tl-steps-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <Icon.chevronDown size={12} /> : <Icon.chevronRight size={12} />}
        <span>{said.charAt(0).toUpperCase() + said.slice(1)}</span>
        {errors ? <span className="tl-steps-err">{errors} failed</span> : null}
        {ms ? <span className="tl-dur">{fmtDur(ms)}</span> : null}
      </button>
      {open ? <div className="tl-steps-body">{children(rows)}</div> : null}
    </div>
  );
}

/**
 * A message from another member of the agent team. The name opens its
 * session; what it said opens in place. An idle notice that reported nothing
 * is one quiet line — a lead hears one every time a teammate's turn ends.
 */
function MateRow({ id, mate, at }: { id: string; mate: MateMessage; at: number }) {
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
      {to ? <StatusDot status={to.status} /> : <span className="tl-mate-swatch" aria-hidden="true" />}
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
      <div className={`tl-mate tl-mate-quiet${failed ? " is-failed" : ""}`} title={fmtClock(at)} data-ev={id}>
        {who}
        <span className="tl-mate-said">{mate.idle !== undefined ? (failed ? mate.idle.replace(/^failed: ?/, "stopped: ") : "is idle") : <Markdown inline text={said} />}</span>
        <Stamp at={at} />
      </div>
    );
  }
  return (
    <div className={`tl-mate${failed ? " is-failed" : ""}`} data-ev={id}>
      <button className="tl-mate-head" aria-expanded={open} onClick={() => setOpen(!open)} title={fmtClock(at)}>
        {who}
        <span className="tl-mate-said">
          {mate.idle !== undefined ? <span className="faint">finished · </span> : null}
          <Markdown inline text={said} />
        </span>
        <Stamp at={at} />
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
    <div className={`tl-btw is-${btw.status}`} title={fmtClock(btw.askedAt)}>
      <div className="tl-who">
        <span className="tl-btw-tag">/btw</span> You
        {btw.source === "terminal" ? <span className="faint"> · in the terminal</span> : null}
        <time className="tl-time">{fmtClock(btw.askedAt)}</time>
        <Button
          variant="ghost"
          size="sm"
          icon={Icon.x}
          className="tl-btw-x"
          aria-label="Dismiss"
          title="Dismiss (Esc)"
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
            <Spinner size={11} /> Answering… <span className="tl-btw-hint">· Esc dismisses</span>
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
    <div className="tl-mate tl-mate-quiet" title={fmtClock(events[events.length - 1]!.at)}>
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
      <Stamp at={events[events.length - 1]!.at} />
    </div>
  );
}

/** One line — how long, and how the thought began — and the whole of it on click. */
function Thinking({ text, at, dur }: { text: string; at: number; dur?: number }) {
  const [open, setOpen] = useState(false);
  const body = text.trim();
  return (
    <div className="tl-thinking">
      <button className="tl-thinking-head" aria-expanded={open} onClick={() => setOpen(!open)} title={fmtClock(at)}>
        <Icon.brain size={13} />
        <span className="tl-thinking-label">Thinking</span>
        {dur !== undefined ? <span className="tl-dur">{fmtDur(dur)}</span> : null}
        <span className="tl-thinking-fill">{open ? null : <Markdown inline text={firstLine(body, 400)} />}</span>
        <Stamp at={at} />
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
        title={running && took !== null ? `${fmtClock(ev.at)} · running for ${fmtDur(took)}` : fmtClock(ev.at)}
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
