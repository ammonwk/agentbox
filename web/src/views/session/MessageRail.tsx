import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import type { Session, Turn, TurnList } from "../../../../src/core/types";
import { ago, api } from "../../api";
import { Icon } from "../../components";

/**
 * Everything you said to a session, as dots down the side of the terminal or
 * the timeline: where each sits in the conversation, what it said on hover,
 * one click to go there. ↑ and ↓ step through them from where you are.
 * On a touch screen there is no hover: press the rail and drag to read them,
 * and let go to go there (or slide off it to change your mind).
 *
 * The rail only draws and reports; the view beside it does the going, since
 * a timeline scrolls itself and a terminal is paged by the server.
 */

const KIND_LABEL: Record<Turn["kind"], string> = {
  prompt: "You",
  answer: "Your answer",
  agent: "From another session",
  command: "Command",
};

/** A dot is never closer to its neighbour than this, until there are too many to fit. */
const MIN_GAP = 9;
const PAD = 10;
/** How far from a dot the pointer still means that dot. */
const REACH = 14;
/** How far sideways a finger can slide off the rail before letting go means nothing. */
const LET_GO = 60;

/** Refetch as the session moves, at most this often. */
const REFRESH_MS = 2_000;

/** The session's turns, kept current while it runs. `activity` is anything that changes when it does. */
export function useTurns(sessionId: string, activity: number): TurnList | null {
  const [list, setList] = useState<{ id: string; list: TurnList } | null>(null);
  const last = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const wait = Math.max(0, last.current + REFRESH_MS - Date.now());
    const t = setTimeout(() => {
      last.current = Date.now();
      api.turns(sessionId).then(
        (l) => !cancelled && setList({ id: sessionId, list: l }),
        () => undefined, // no rail beats a broken one; the views work without it
      );
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [sessionId, activity]);
  return list?.id === sessionId ? list.list : null;
}

/**
 * Where each dot goes: its place in the conversation, then pushed apart to at
 * least `MIN_GAP` (or evenly, when there are too many for that) without
 * leaving the track.
 */
export function layoutDots(seqs: readonly number[], total: number, height: number): number[] {
  const n = seqs.length;
  const span = Math.max(0, height - 2 * PAD);
  if (n === 0) return [];
  const gap = Math.min(MIN_GAP, n > 1 ? span / (n - 1) : MIN_GAP);
  const ys = seqs.map((s) => PAD + (total > 1 ? s / (total - 1) : 0) * span);
  for (let i = 1; i < n; i++) ys[i] = Math.max(ys[i]!, ys[i - 1]! + gap);
  ys[n - 1] = Math.min(ys[n - 1]!, PAD + span);
  for (let i = n - 2; i >= 0; i--) ys[i] = Math.min(ys[i]!, ys[i + 1]! - gap);
  return ys;
}

/** "3:42 PM" today, "Sep 25, 3:42 PM" before. */
function when(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function MessageRail({
  turns,
  total,
  current,
  busy,
  dark,
  onJump,
  onStep,
}: {
  turns: readonly Turn[];
  total: number;
  /** The message you are reading, or null at the latest. */
  current: string | null;
  /** A jump underway, to this message. */
  busy: string | null;
  /** Beside the terminal, which is dark whatever the theme. */
  dark?: boolean;
  onJump: (t: Turn) => void;
  onStep: (dir: -1 | 1) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  /** A finger on the rail, and the dot it is reading. */
  const scrub = useRef<{ i: number | null } | null>(null);
  /** The click that follows a scrub's release is the scrub's, already acted on. */
  const swallow = useRef(false);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [turns.length > 0]);

  const ys = useMemo(() => layoutDots(turns.map((t) => t.seq), total, height), [turns, total, height]);
  const currentIdx = current === null ? -1 : turns.findIndex((t) => t.id === current);
  const shown = hover ?? focus;

  const nearest = (clientY: number): number | null => {
    const top = trackRef.current?.getBoundingClientRect().top ?? 0;
    const y = clientY - top;
    let best: number | null = null;
    ys.forEach((dy, i) => {
      if (Math.abs(dy - y) <= REACH && (best === null || Math.abs(dy - y) < Math.abs(ys[best]! - y))) best = i;
    });
    return best;
  };

  /** The dot nearest a finger, however far: a finger hides the dots it is on. */
  const closest = (clientY: number): number | null => {
    const y = clientY - (trackRef.current?.getBoundingClientRect().top ?? 0);
    let best: number | null = null;
    ys.forEach((dy, i) => {
      if (best === null || Math.abs(dy - y) < Math.abs(ys[best]! - y)) best = i;
    });
    return best;
  };

  const onKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? turns.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    trackRef.current?.querySelectorAll<HTMLButtonElement>(".mr-dot")[Math.max(0, Math.min(turns.length - 1, to))]?.focus();
  };

  if (turns.length === 0) return null;
  const atLatest = currentIdx === -1 || currentIdx === turns.length - 1;

  return (
    <nav className={`mr${dark ? " mr-dark" : ""}`} aria-label="Your messages">
      <button
        type="button"
        className="mr-step"
        title="Previous message"
        aria-label="Previous message"
        disabled={currentIdx === 0}
        onClick={() => onStep(-1)}
      >
        <Icon.chevronUp size={14} />
      </button>
      <div
        className="mr-track"
        ref={trackRef}
        onPointerDown={(e: PointerEvent) => {
          swallow.current = false;
          if (e.pointerType === "mouse") return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* a pointer already gone */
          }
          scrub.current = { i: closest(e.clientY) };
          setHover(scrub.current.i);
        }}
        onPointerMove={(e: PointerEvent) => {
          if (e.pointerType === "mouse") setHover(nearest(e.clientY));
          else if (scrub.current) setHover((scrub.current.i = closest(e.clientY)));
        }}
        onPointerUp={(e: PointerEvent) => {
          const s = scrub.current;
          if (!s) return;
          scrub.current = null;
          swallow.current = true;
          setHover(null);
          const box = e.currentTarget.getBoundingClientRect();
          const off = Math.max(box.left - e.clientX, e.clientX - box.right);
          if (s.i !== null && off < LET_GO) onJump(turns[s.i]!);
        }}
        onPointerCancel={() => {
          scrub.current = null;
          setHover(null);
        }}
        onPointerLeave={(e: PointerEvent) => e.pointerType === "mouse" && setHover(null)}
        onClick={(e) => {
          if (swallow.current) {
            swallow.current = false;
            return;
          }
          // Anywhere near a dot is that dot: the dots are small, the rail is not.
          if ((e.target as HTMLElement).closest(".mr-dot")) return;
          const i = nearest(e.clientY);
          if (i !== null) onJump(turns[i]!);
        }}
      >
        <div className="mr-line" aria-hidden="true" />
        {turns.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={`mr-dot${i === currentIdx ? " is-current" : ""}${i === shown ? " is-hover" : ""}${t.id === busy ? " is-busy" : ""}`}
            data-kind={t.kind}
            style={{ top: ys[i] }}
            aria-label={`${KIND_LABEL[t.kind]}, ${when(t.at)}: ${t.text.slice(0, 120)}`}
            aria-current={i === currentIdx ? "location" : undefined}
            tabIndex={i === (currentIdx === -1 ? turns.length - 1 : currentIdx) ? 0 : -1}
            onClick={() => !swallow.current && onJump(t)}
            // A click focuses the dot too; only a keyboard's focus keeps its card up.
            onFocus={(e) => e.currentTarget.matches(":focus-visible") && setFocus(i)}
            onBlur={() => setFocus(null)}
            onKeyDown={(e) => onKey(e, i)}
          />
        ))}
        {shown !== null && turns[shown] ? <Card turn={turns[shown]} index={shown} count={turns.length} y={ys[shown] ?? 0} height={height} /> : null}
      </div>
      <button
        type="button"
        className="mr-step"
        title={atLatest ? "Latest" : "Next message"}
        aria-label={atLatest ? "Latest" : "Next message"}
        disabled={currentIdx === -1}
        onClick={() => onStep(1)}
      >
        <Icon.chevronDown size={14} />
      </button>
    </nav>
  );
}

function Card({ turn, index, count, y, height }: { turn: Turn; index: number; count: number; y: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(y);
  // Centred on its dot, but never off the end of the track.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(0, Math.min(y - h / 2, height - h)));
  }, [y, height, turn.id]);

  const lines = turn.text.split("\n");
  return (
    <div className="mr-card" data-kind={turn.kind} ref={ref} style={{ top }} role="tooltip">
      <div className="mr-card-head">
        <span className="mr-swatch" aria-hidden="true" />
        <span className="mr-card-kind">{KIND_LABEL[turn.kind]}</span>
        <span className="mr-card-when">
          {when(turn.at)} · {ago(turn.at)}
        </span>
      </div>
      <div className="mr-card-body">
        {turn.kind === "answer"
          ? lines.map((l, i) => (
              <p key={i} className={l.startsWith("→ ") ? "mr-answer" : "mr-question"}>
                {l}
              </p>
            ))
          : turn.text}
      </div>
      <div className="mr-card-foot">
        {index + 1} of {count}
      </div>
    </div>
  );
}

/**
 * The rail beside the live terminal. Claude Code and Codex scroll their own
 * history, so the server pages the TUI to the message and says which row it
 * landed on (src/core/termseek.ts). A message it cannot find there — or any,
 * for a TUI it cannot page — is opened in the timeline instead.
 */
export function TermRail({
  session,
  flash,
  scrolled,
  onElsewhere,
}: {
  session: Session;
  flash: MutableRefObject<((row: number) => void) | null>;
  /** Changes each time you scroll the terminal yourself. */
  scrolled: number;
  /** Show it in the timeline, saying why. */
  onElsewhere: (turn: Turn, why: string) => void;
}) {
  const list = useTurns(session.id, session.lastActivityAt);
  const turns = list?.turns ?? [];
  const seekable = session.provider === "claude" || session.provider === "codex";
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The newest request; an older one landing late is ignored. */
  const latest = useRef(0);
  const loaded = list !== null;

  // Where you are after scrolling it yourself (and on opening: it may already be scrolled).
  useEffect(() => {
    if (!seekable || !loaded) return;
    let cancelled = false;
    api.termWhere(session.id).then(
      (w) => !cancelled && setCurrent(w.bottom ? null : w.turnId),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [session.id, seekable, loaded, scrolled]);

  const go = (t: Turn) => {
    if (!seekable) {
      onElsewhere(t, `The ${session.provider} terminal cannot be scrolled from here.`);
      return;
    }
    const mine = ++latest.current;
    setBusy(t.id);
    api.termSeek(session.id, t.id).then(
      (r) => {
        if (mine !== latest.current) return;
        setBusy(null);
        if (r.found) {
          setCurrent(t.id);
          flash.current?.(r.row);
        } else onElsewhere(t, r.reason);
      },
      (e: Error) => {
        if (mine !== latest.current) return;
        setBusy(null);
        onElsewhere(t, e.message);
      },
    );
  };

  const step = (dir: -1 | 1) => {
    const at = current === null ? turns.length : turns.findIndex((t) => t.id === current);
    const to = at + dir;
    if (to < 0) return;
    if (to < turns.length) return go(turns[to]!);
    latest.current++;
    setBusy(null);
    setCurrent(null);
    if (seekable) void api.termBottom(session.id).catch(() => undefined);
  };

  return <MessageRail dark turns={turns} total={list?.total ?? 0} current={current} busy={busy} onJump={go} onStep={step} />;
}
