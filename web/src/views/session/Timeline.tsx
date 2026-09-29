import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Btw, MateMessage, Session, TimelineEvent, Turn } from "../../../../src/core/types";
import { api, fmtClock, useBtw, useTimeline } from "../../api";
import { fmtDur } from "../../lib/format";
import { Button, Empty, Icon, Spinner } from "../../components";
import { firstLine, groupTimeline, withBtw } from "../../lib/timeline";
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

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;

const NO_TURNS: Turn[] = [];
/** A step still running after this long is flagged red. */
const SLOW_MS = 120_000;
/** A thinking block older than this is an idle gap, not a thought: no duration. */
const THINK_CAP_MS = 10 * 60_000;

/**
 * The conversation as the provider's transcript records it, folded into
 * provider-neutral events. Newest at the bottom; scrolling to the top pages
 * older history in, anchored so the reader does not lose their place.
 */
export function Timeline({ session }: { session: Session }) {
  const { events, ready, loadingOlder, exhausted, error, loadOlder } = useTimeline(session.id);
  const btw = useBtw(session.id);
  const rows = useMemo(() => withBtw(groupTimeline(events), btw, exhausted), [events, btw, exhausted]);
  const echoes = useEchoes(session.id, events);
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
    const shown = rows.filter((r) => r.type === "btw").map((r) => r.btw);
    const ids = new Set(shown.map((b) => b.id));
    return [...shown, ...btw.filter((b) => b.status === "asking" && !ids.has(b.id))];
  }, [rows, btw]);
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
  }, [events, pinned, echoes.length, btw, thinking]);

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
    if (!jump || !ready) return;
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
  }, [jump, ready, events, exhausted, error, loadingOlder, loadOlder, rowOf]);

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
            r.type === "tools" ? (
              <ToolRun key={r.id} events={r.events} now={now} />
            ) : r.type === "idle" ? (
              <IdleRow key={r.id} events={r.events} />
            ) : r.type === "btw" ? (
              <BtwCard key={`btw-${r.btw.id}`} btw={r.btw} />
            ) : r.type === "ask" ? (
              <AskRow key={r.event.id} ev={r.event} live={session.question?.id === r.event.ask.id} />
            ) : (
              <EventRow key={r.event.id} ev={r.event} dur={thinkDur.get(r.event.id)} />
            ),
          )}
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
  );
}

/** Messages sent from here that the transcript has not caught up with. */
function useEchoes(sessionId: string, events: readonly TimelineEvent[]): Echo[] {
  const [sent, setSent] = useState<Echo[]>([]);
  useEffect(() => onEcho((e) => e.sessionId === sessionId && setSent((xs) => [...xs, e])), [sessionId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (sent.length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [sent.length]);
  const users = useMemo(() => events.filter((e): e is Extract<TimelineEvent, { kind: "user" }> => e.kind === "user").slice(-20), [events]);
  const live = sent.filter((e) => Date.now() - e.at < ECHO_TTL_MS && !landed(e, users));
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
      return (
        <div className="tl-user" title={fmtClock(ev.at)} data-ev={ev.id}>
          <div className="tl-who">
            <Icon.user size={13} /> You
            {ev.images ? <span className="faint"> · {ev.images} image{ev.images === 1 ? "" : "s"}</span> : null}
            <time className="tl-time">{fmtClock(ev.at)}</time>
          </div>
          <Markdown text={ev.text} />
        </div>
      );
    case "assistant":
      return (
        <div className="tl-assistant" title={fmtClock(ev.at)}>
          <Markdown text={ev.text} />
          <Stamp at={ev.at} float />
        </div>
      );
    case "thinking":
      return <Thinking text={ev.text} at={ev.at} dur={dur} />;
    case "meta":
      if (ev.mate) return <MateRow mate={ev.mate} at={ev.at} />;
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
 * A message from another member of the agent team. The name opens its
 * session; what it said opens in place. An idle notice that reported nothing
 * is one quiet line — a lead hears one every time a teammate's turn ends.
 */
function MateRow({ mate, at }: { mate: MateMessage; at: number }) {
  const [open, setOpen] = useState(false);
  const { byName, tab } = useFamily();
  const to = byName.get(mate.name) ?? null;
  const failed = mate.idle?.startsWith("failed") ?? false;
  const name = to && mate.name === "team-lead" ? `${titleOf(to)} (lead)` : mate.name;
  const who = (
    <span className="tl-mate-who" data-color={mate.color}>
      {to ? <StatusDot status={to.status} /> : <span className="tl-mate-swatch" aria-hidden="true" />}
      {to ? (
        <a href={hrefOf({ page: "session", id: to.id, tab })} title={`Open ${titleOf(to)}`} onClick={(e) => e.stopPropagation()}>
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
      <div className={`tl-mate tl-mate-quiet${failed ? " is-failed" : ""}`} title={fmtClock(at)}>
        {who}
        <span className="tl-mate-said">{mate.idle !== undefined ? (failed ? mate.idle.replace(/^failed: ?/, "stopped: ") : "is idle") : said}</span>
        <Stamp at={at} />
      </div>
    );
  }
  return (
    <div className={`tl-mate${failed ? " is-failed" : ""}`}>
      <button className="tl-mate-head" aria-expanded={open} onClick={() => setOpen(!open)} title={fmtClock(at)}>
        {who}
        <span className="tl-mate-said">
          {mate.idle !== undefined ? <span className="faint">finished · </span> : null}
          {said}
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
function BtwCard({ btw }: { btw: Btw }) {
  return (
    <div className={`tl-btw is-${btw.status}`} title={fmtClock(btw.askedAt)}>
      <div className="tl-who">
        <span className="tl-btw-tag">/btw</span> You
        {btw.source === "terminal" ? <span className="faint"> · in the terminal</span> : null}
        <time className="tl-time">{fmtClock(btw.askedAt)}</time>
      </div>
      <div className="tl-btw-q">{btw.question}</div>
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

function Thinking({ text, at, dur }: { text: string; at: number; dur?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tl-thinking">
      <button className="tl-thinking-head" aria-expanded={open} onClick={() => setOpen(!open)} title={fmtClock(at)}>
        <Icon.brain size={13} />
        <span className="tl-thinking-label">Thinking</span>
        {dur !== undefined ? <span className="tl-dur">{fmtDur(dur)}</span> : null}
        {!open ? <span className="tl-thinking-peek">{firstLine(text)}</span> : null}
        <Stamp at={at} />
        <Icon.chevronDown size={12} className={open ? "rot" : undefined} />
      </button>
      {open ? <div className="tl-thinking-body">{text}</div> : null}
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
        <span className="sx-tool-sub">{ev.summary}</span>
        <span className={`sx-tool-status ${ev.status}${slow ? " is-slow" : ""}`}>
          {running ? (now > 0 ? fmtDur(now - ev.at) : "running") : ev.status === "error" ? `error${ev.endedAt && ev.endedAt > ev.at ? ` · ${fmtDur(ev.endedAt - ev.at)}` : ""}` : typeof ev.endedAt === "number" && ev.endedAt > ev.at ? fmtDur(ev.endedAt - ev.at) : ""}
        </span>
        {hasDetail ? <Icon.chevronDown size={12} className={open ? "rot" : undefined} /> : null}
      </button>
      {open && hasDetail ? (
        <div className="sx-tool-detail">
          {ev.input ? (
            <div>
              <h4>Input</h4>
              <pre className="sx-pre">{ev.input}</pre>
            </div>
          ) : null}
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
