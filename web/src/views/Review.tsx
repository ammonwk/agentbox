/**
 * Review: the cards sessions handed you (src/core/cards.ts), one at a time.
 *
 * A stack, decisions you owe first and newest first, then what happened, then
 * what you kept for later. The card on top takes three gestures, each with a
 * button under it and a Shift+arrow shortcut (plain arrows navigate):
 *   right (Shift+→) — answer it: a sheet with a text box. Empty, on a card that
 *               only wanted seeing, means "seen".
 *   left  (Shift+←) — keep it for later: to the back of the stack and the Later list.
 *   up    (Shift+↑) — the long version, from which the others work.
 *   down  (Shift+↓) — approve: the asker's recommendation is your answer. On a card
 *               that only wanted seeing, seen. A decision with no
 *               recommendation has nothing to approve, and springs back.
 * The last one can be taken back (u): an answer is held a few seconds before
 * it is typed into the session that asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AppState, Card } from "../../../src/core/types";
import { describeAt } from "../../../src/core/schedule";
import { api } from "../api";
import { laterOf, stackOf } from "../lib/cardorder";
import { Button, Empty, Icon, Modal, RelativeTime } from "../components";
import { hrefOf } from "../route";
import { Markdown } from "./session/Markdown";
import { PrBase } from "./session/prbase";
import { SessionLinks } from "./session/sessionlinks";
import { buildSessionIndex, withResolved } from "../lib/sessionrefs";
import { useResolvedSessions } from "../lib/sessionresolve";
import { prBaseFor } from "../lib/prlinks";
import "./review.css";

type Tab = "stack" | "later" | "done";
/** How long the last gesture can be taken back; the server holds an answer this long (UNDO_MS). */
const UNDO_SHOWN_MS = 8_000;
/** How far a card is dragged before letting go means it. */
const SWIPE_X = 84;
const SWIPE_UP = 72;
const SWIPE_DOWN = 72;
/** What approving a recommendation types into the session that asked. */
const APPROVE = "Go with your recommendation.";

/** What a down swipe does to this card: approve its recommendation, mark it seen, or nothing. */
function downOf(card: Card): "approve" | "seen" | null {
  if (card.kind !== "decision") return "seen";
  return card.recommend ? "approve" : null;
}

const KIND: Record<Card["kind"], string> = { decision: "Decision", merged: "Merged", note: "Note" };

/** `owner/repo#12` from a pull request's URL, else the URL's last part. */
function prLabel(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `#${m[3]}` : url.replace(/^https?:\/\//, "").slice(0, 40);
}

export function Review({ state }: { state: AppState }) {
  const [tab, setTab] = useState<Tab>("stack");
  // What was just done here, shown at once: the server's copy follows within a moment.
  const [local, setLocal] = useState<Map<number, Partial<Card>>>(new Map());
  const cards = useMemo(() => state.cards.map((c) => (local.has(c.id) ? { ...c, ...local.get(c.id) } : c)), [state.cards, local]);
  useEffect(() => {
    // Once the server says the same, its word is the one kept.
    setLocal((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const c of state.cards) if (next.get(c.id)?.state === c.state) next.delete(c.id);
      return next.size === prev.size ? prev : next;
    });
  }, [state.cards]);

  const stack = useMemo(() => stackOf(cards), [cards]);
  const later = useMemo(() => laterOf(cards), [cards]);
  const done = useMemo(
    () => cards.filter((c) => c.state === "answered" || c.state === "closed").sort((a, b) => (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt)),
    [cards],
  );

  const [answering, setAnswering] = useState<Card | null>(null);
  const [reading, setReading] = useState<Card | null>(null);
  const [leaving, setLeaving] = useState<{ id: number; to: "left" | "right" | "down" } | null>(null);
  const [last, setLast] = useState<{ card: Card; what: "answered" | "approved" | "seen" | "later"; at: number } | null>(null);
  /** Said for a moment when a gesture had nothing to do. */
  const [nothing, setNothing] = useState<string | null>(null);
  useEffect(() => {
    if (!nothing) return;
    const t = setTimeout(() => setNothing(null), 2600);
    return () => clearTimeout(t);
  }, [nothing]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setLast((l) => (l === last ? null : l)), UNDO_SHOWN_MS);
    return () => clearTimeout(t);
  }, [last]);

  /** Do it: the card leaves in the gesture's direction, then is gone from the stack. */
  const act = useCallback((card: Card, what: "answered" | "approved" | "seen" | "later", text = "") => {
    setError(null);
    setNothing(null);
    setReading(null);
    setAnswering(null);
    const onStack = card.state === "open" || card.state === "later";
    if (onStack) setLeaving({ id: card.id, to: what === "later" ? "left" : what === "answered" ? "right" : "down" });
    const patch: Partial<Card> = what === "later" ? { state: "later", laterAt: Date.now() } : { state: "answered", answer: text, answeredAt: Date.now() };
    setTimeout(
      () => {
        setLocal((prev) => new Map(prev).set(card.id, patch));
        setLeaving(null);
      },
      onStack ? 190 : 0,
    );
    setLast({ card, what, at: Date.now() });
    (what === "later" ? api.laterCard(card.id) : api.answerCard(card.id, text)).catch((e: Error) => {
      setError(e.message);
      setLast(null);
      setLocal((prev) => {
        const next = new Map(prev);
        next.delete(card.id);
        return next;
      });
    });
  }, []);

  const undo = useCallback(() => {
    if (!last) return;
    const { card } = last;
    setLast(null);
    setError(null);
    setLocal((prev) => new Map(prev).set(card.id, { state: card.state, answer: null, answeredAt: null, laterAt: card.laterAt }));
    api.undoCard(card.id).catch((e: Error) => {
      setError(e.message);
      setLocal((prev) => {
        const next = new Map(prev);
        next.delete(card.id);
        return next;
      });
    });
  }, [last]);

  /** Down: the recommendation is the answer, or the card is seen; a decision without one stays. */
  const approve = useCallback(
    (card: Card) => {
      const does = downOf(card);
      if (does === "approve") act(card, "approved", APPROVE);
      else if (does === "seen") act(card, "seen");
      else setNothing("This one has no recommendation to approve: answer it, or keep it for later.");
    },
    [act],
  );

  const top = tab === "stack" ? (stack.find((c) => c.id !== leaving?.id) ?? null) : null;
  const shownTop = stack[0] ?? null;

  // The keys, while no sheet has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (answering || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // Review's own keys: not from the sidebar or a pane outside it. A card
      // that leaves takes the focus with it, to the page or the body.
      if (!el || !(el === document.body || el.id === "content" || el.closest(".review"))) return;
      if (e.key.startsWith("Arrow") && !e.shiftKey) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const card = reading ?? (tab === "stack" ? shownTop : null);
      if (e.key === "u") undo();
      else if (!card || card.state === "answered" || card.state === "closed") return;
      else if (e.key === "ArrowRight") setAnswering(card);
      else if (e.key === "ArrowLeft") act(card, "later");
      else if (e.key === "ArrowUp" && !reading) setReading(card);
      else if (e.key === "ArrowDown" && !reading) approve(card);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [answering, reading, tab, shownTop, act, undo, approve]);

  return (
    <div className="review">
      <header className="review-head">
        <h2 className="review-title">Review</h2>
        <div className="review-tabs" role="tablist" aria-label="Cards">
          {(
            [
              ["stack", "To review", stack.length],
              ["later", "Later", later.length],
              ["done", "Done", done.length],
            ] as const
          ).map(([id, label, n]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="review-tab" onClick={() => setTab(id)}>
              {label}
              {n > 0 ? <span className="review-tab-n">{n}</span> : null}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <p className="error review-error" role="alert">
          {error}
        </p>
      ) : null}

      {tab === "stack" ? (
        stack.length === 0 ? (
          <Empty title="Nothing to review">
            {done.length ? "Everything a session handed you has an answer. They are under Done." : "When a session needs a decision from you, or wants you to know something merged, it shows here as a card."}
          </Empty>
        ) : (
          <>
            <div className="review-stack">
              {stack
                .slice(0, 3)
                .reverse()
                .map((c) => {
                  const depth = stack.indexOf(c) - (leaving && stack[0]?.id === leaving.id ? 1 : 0);
                  return (
                    <SwipeCard
                      key={c.id}
                      card={c}
                      state={state}
                      depth={Math.max(depth, 0)}
                      leaving={leaving?.id === c.id ? leaving.to : null}
                      onRight={() => setAnswering(c)}
                      onLeft={() => act(c, "later")}
                      onUp={() => setReading(c)}
                      onDown={() => approve(c)}
                    />
                  );
                })}
            </div>
            <p className={`review-count${nothing ? " review-nothing" : ""}`} aria-live="polite">
              {nothing ?? (
                <>
                  {stack.length === 1 ? "The last one" : `1 of ${stack.length}`}
                  {shownTop?.state === "later" ? " · kept for later" : ""}
                </>
              )}
            </p>
            <Actions card={top ?? shownTop!} onLater={(c) => act(c, "later")} onRead={setReading} onApprove={approve} onAnswer={setAnswering} />
          </>
        )
      ) : (
        <CardList cards={tab === "later" ? later : done} state={state} empty={tab === "later" ? "Nothing kept for later." : "Nothing answered yet."} onOpen={setReading} />
      )}

      {last ? (
        <div className="review-undo" role="status">
          <span>
            {last.what === "later" ? "Kept for later" : last.what === "seen" ? "Marked seen" : last.what === "approved" ? "Recommendation approved" : "Answer on its way"}
            <span className="faint"> · {last.card.title}</span>
          </span>
          <Button size="sm" icon={Icon.undo} onClick={undo}>
            Undo
          </Button>
        </div>
      ) : null}

      {reading ? (
        <LongView
          card={cards.find((c) => c.id === reading.id) ?? reading}
          state={state}
          onClose={() => setReading(null)}
          onLater={(c) => act(c, "later")}
          onApprove={approve}
          onAnswer={setAnswering}
        />
      ) : null}
      {answering ? <AnswerSheet card={answering} onClose={() => setAnswering(null)} onSend={(text) => act(answering, text.trim() ? "answered" : "seen", text.trim())} /> : null}
    </div>
  );
}

/** The three gestures as buttons: for a desk, and for when a swipe misfires. */
function Actions({
  card,
  onLater,
  onRead,
  onApprove,
  onAnswer,
  long,
}: {
  card: Card;
  onLater: (c: Card) => void;
  onRead?: (c: Card) => void;
  onApprove: (c: Card) => void;
  onAnswer: (c: Card) => void;
  long?: boolean;
}) {
  const does = downOf(card);
  return (
    <div className={`review-actions${long ? " review-actions-long" : ""}`}>
      <button type="button" className="review-act review-act-later" onClick={() => onLater(card)} title="Keep it for later (Shift+←)" disabled={card.state === "later" && long}>
        <Icon.chevronLeft size={18} />
        <span>Later</span>
      </button>
      {onRead ? (
        <button type="button" className="review-act review-act-more" onClick={() => onRead(card)} title="The long version (Shift+↑)">
          <Icon.chevronUp size={18} />
          <span>More</span>
        </button>
      ) : null}
      <button
        type="button"
        className="review-act review-act-approve"
        onClick={() => onApprove(card)}
        aria-disabled={does === null || undefined}
        title={does === "approve" ? "Approve the recommendation (Shift+↓)" : does === "seen" ? "Seen, fine (Shift+↓)" : "It has no recommendation to approve"}
      >
        <Icon.check size={18} />
        <span>{does === "seen" ? "Seen" : "Approve"}</span>
      </button>
      <button type="button" className="review-act review-act-answer" onClick={() => onAnswer(card)} title="Answer it (Shift+→)">
        <span>{card.kind === "decision" ? "Answer" : "Respond"}</span>
        <Icon.chevronRight size={18} />
      </button>
    </div>
  );
}

/** Who asked, the pull request, and when. */
function Source({ card, state }: { card: Card; state: AppState }) {
  const s = card.sessionId ? state.sessions.find((x) => x.id === card.sessionId) : null;
  return (
    <div className="card-source">
      {card.sessionId ? (
        <a className="card-from" href={hrefOf({ page: "session", id: card.sessionId, tab: "timeline" })} title={`The session that asked (${card.sessionId})`}>
          <Icon.sessions size={12} />
          <span>{s ? s.label || s.title : card.sessionId}</span>
        </a>
      ) : null}
      {card.pr ? (
        <a className="card-pr" href={card.pr} target="_blank" rel="noreferrer" title={card.pr}>
          <Icon.prs size={12} />
          <span>{prLabel(card.pr)}</span>
        </a>
      ) : null}
      <RelativeTime ts={card.createdAt} />
    </div>
  );
}

/**
 * What a card's words link to: a session it names (matched against the
 * board's, so a word that only looks like an id stays a word) opens that
 * session, and `#123` the pull request, in the repo of the card's own PR,
 * else of the session that made it.
 */
function CardLinks({ card, state, children }: { card: Card; state: AppState; children: ReactNode }) {
  const resolved = useResolvedSessions();
  const links = useMemo(() => ({ index: withResolved(buildSessionIndex(state.sessions), resolved), self: null }), [state.sessions, resolved]);
  const base = useMemo(() => {
    const own = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/.exec(card.pr ?? "")?.[1];
    const asker = state.sessions.find((x) => x.id === card.sessionId);
    return own ?? prBaseFor(asker ?? { repoRoot: null, prRepo: null }, state);
  }, [card.pr, card.sessionId, state]);
  return (
    <PrBase.Provider value={base}>
      <SessionLinks.Provider value={links}>{children}</SessionLinks.Provider>
    </PrBase.Provider>
  );
}

/** What the asker would do, and what it does unasked once its time passes. */
function Leaning({ card }: { card: Card }) {
  const passed = card.defaultAt !== null && card.defaultAt <= Date.now();
  if (!card.recommend && !card.default) return null;
  return (
    <div className="card-leaning">
      {card.recommend ? (
        <p>
          <strong>Recommended</strong> <Markdown inline text={card.recommend} />
        </p>
      ) : null}
      {card.default && card.state !== "answered" && card.state !== "closed" ? (
        <p className={passed ? "card-default-passed" : undefined}>
          <strong>{passed ? "Default time passed" : card.defaultAt ? `Unanswered by ${describeAt(card.defaultAt).replace(/^T/, "t")}` : "By default"}</strong> <Markdown inline text={card.default} />
        </p>
      ) : null}
    </div>
  );
}

function SwipeCard({
  card,
  state,
  depth,
  leaving,
  onLeft,
  onRight,
  onUp,
  onDown,
}: {
  card: Card;
  state: AppState;
  depth: number;
  leaving: "left" | "right" | "down" | null;
  onLeft: () => void;
  onRight: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const top = depth === 0;

  const place = (dx: number, dy: number, moving: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = moving ? "none" : "";
    el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px) rotate(${dx / 28}deg)` : "";
    // Which gesture it is turning into, 0 to 1, for the label that fades in.
    const tall = Math.abs(dy) > Math.abs(dx);
    el.style.setProperty("--to-right", String(!tall && dx > 0 ? Math.min(1, dx / SWIPE_X) : 0));
    el.style.setProperty("--to-left", String(!tall && dx < 0 ? Math.min(1, -dx / SWIPE_X) : 0));
    el.style.setProperty("--to-up", String(tall && dy < 0 ? Math.min(1, -dy / SWIPE_UP) : 0));
    el.style.setProperty("--to-down", String(tall && dy > 0 ? Math.min(1, dy / SWIPE_DOWN) : 0));
  };

  const down = (e: ReactPointerEvent<HTMLElement>) => {
    if (!top || e.button !== 0 || (e.target as Element).closest("a, button")) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 8) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    place(dx, dy, true);
  };
  const up = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    place(0, 0, false);
    if (Math.abs(dy) > Math.abs(dx)) {
      if (-dy >= SWIPE_UP) onUp();
      else if (dy >= SWIPE_DOWN) onDown();
    } else if (dx >= SWIPE_X) onRight();
    else if (dx <= -SWIPE_X) onLeft();
  };

  return (
    <article
      ref={ref}
      className={`card card-review card-${card.kind}`}
      data-depth={depth}
      data-leaving={leaving ?? undefined}
      aria-hidden={top ? undefined : true}
      data-nav-item={top ? "" : undefined}
      data-nav-id={`card:${card.id}`}
      tabIndex={top ? 0 : -1}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
        if (e.key === "ArrowRight" || e.key === "Enter") {
          e.preventDefault();
          onUp();
        }
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null;
        place(0, 0, false);
      }}
    >
      <span className="card-hint card-hint-right" aria-hidden="true">
        Answer
      </span>
      <span className="card-hint card-hint-left" aria-hidden="true">
        Later
      </span>
      <span className="card-hint card-hint-up" aria-hidden="true">
        Long version
      </span>
      <span className={`card-hint card-hint-down${downOf(card) ? "" : " card-hint-none"}`} aria-hidden="true">
        {downOf(card) === "approve" ? "Approve the recommendation" : downOf(card) === "seen" ? "Seen" : "No recommendation to approve"}
      </span>
      <div className="card-kind">
        <span className="card-kind-chip">{KIND[card.kind]}</span>
        {card.state === "later" ? <span className="faint">kept for later</span> : null}
      </div>
      <CardLinks card={card} state={state}>
        <h3 className="card-title">
          <Markdown inline text={card.title} />
        </h3>
        <div className="card-short">
          <Markdown text={card.short} />
        </div>
        <Leaning card={card} />
      </CardLinks>
      <Source card={card} state={state} />
    </article>
  );
}

/** The long, extra clear version: the whole card, scrolling, with the same two ways out. */
function LongView({
  card,
  state,
  onClose,
  onLater,
  onApprove,
  onAnswer,
}: {
  card: Card;
  state: AppState;
  onClose: () => void;
  onLater: (c: Card) => void;
  onApprove: (c: Card) => void;
  onAnswer: (c: Card) => void;
}) {
  const longRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    longRef.current?.focus();
    const restore = restoreTo.current;
    return () => { if (restore?.isConnected) restore.focus(); };
  }, []);
  const [long, setLong] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLong(null);
    setFailed(null);
    if (card.hasLong) {
      api.card(card.id).then(
        (c) => live && setLong(c.long ?? ""),
        (e: Error) => live && setFailed(e.message),
      );
    }
    return () => {
      live = false;
    };
  }, [card.id, card.hasLong]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop") || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      if (e.key === "Tab") {
        const controls = [...(longRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]') ?? [])].filter((el) => el.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === longRef.current)) {
          e.preventDefault();
          (last ?? longRef.current)?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          (first ?? longRef.current)?.focus();
        }
        return;
      }
      if (e.key !== "Escape" && (e.key !== "ArrowLeft" || e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const open = card.state === "open" || card.state === "later";
  return (
    <div className="review-long" tabIndex={-1} ref={longRef} role="dialog" aria-modal="true" aria-label={card.title}>
      <div className="review-long-head">
        <span className={`card-kind-chip card-kind-${card.kind}`}>{KIND[card.kind]}</span>
        <span className="spacer" />
        <Button variant="ghost" size="sm" icon={Icon.chevronDown} onClick={onClose}>
          Back
        </Button>
      </div>
      <CardLinks card={card} state={state}>
      <div className="review-long-body">
        <h2 className="card-title">
          <Markdown inline text={card.title} />
        </h2>
        <Source card={card} state={state} />
        <div className="card-short">
          <Markdown text={card.short} />
        </div>
        <Leaning card={card} />
        {card.state === "answered" ? (
          <div className="card-answer">
            <strong>{card.answer ? "You said" : "Seen"}</strong>
            {card.answer ? <p>{card.answer}</p> : null}
            <p className="faint">
              {card.answeredAt ? <RelativeTime ts={card.answeredAt} /> : null}
              {card.answer ? (card.unread ? " · not read by a session yet" : " · sent to the session") : ""}
            </p>
          </div>
        ) : null}
        {card.state === "closed" ? (
          <div className="card-answer">
            <strong>Withdrawn</strong>
            <p>{card.closedWhy ?? "The question went away."}</p>
          </div>
        ) : null}
        {card.hasLong ? (
          <div className="review-long-text">{failed ? <p className="error">{failed}</p> : long === null ? <p className="faint">Loading…</p> : <Markdown text={long} />}</div>
        ) : null}
      </div>
      </CardLinks>
      {open ? <Actions card={card} onLater={onLater} onApprove={onApprove} onAnswer={onAnswer} long /> : null}
    </div>
  );
}

/** The sheet a right swipe opens: a text box over the keyboard. */
function AnswerSheet({ card, onClose, onSend }: { card: Card; onClose: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const decision = card.kind === "decision";
  const empty = !text.trim();
  return (
    <Modal title={decision ? "Your answer" : "Respond"} hint={card.title} onClose={onClose}>
      <form
        className="review-answer"
        onSubmit={(e) => {
          e.preventDefault();
          if (decision && empty) return;
          onSend(text);
        }}
      >
        {card.recommend ? (
          <button type="button" className="review-take" onClick={() => setText(APPROVE)}>
            <Icon.check size={13} /> Go with the recommendation
          </button>
        ) : null}
        <textarea
          className="input review-answer-box"
          autoFocus
          rows={4}
          value={text}
          placeholder={decision ? "What should it do?" : "Nothing to add? Send it empty: that means seen, fine."}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="review-answer-foot">
          <span className="faint review-answer-note">{empty && !decision ? "Marks it seen; nothing is sent to the session." : "Typed into the session that asked, as you."}</span>
          <Button type="submit" variant="primary" icon={empty && !decision ? Icon.check : Icon.send} disabled={decision && empty}>
            {empty && !decision ? "Seen" : "Send"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CardList({ cards, state, empty, onOpen }: { cards: Card[]; state: AppState; empty: string; onOpen: (c: Card) => void }) {
  if (cards.length === 0) return <Empty title={empty} />;
  return (
    <ul className="review-list">
      {cards.map((c) => (
        <li key={c.id}>
          <button type="button" className="review-row" data-nav-item data-nav-id={`card:${c.id}`} onKeyDown={(e) => { if (e.key === "ArrowRight" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); onOpen(c); } }} onClick={() => onOpen(c)}>
            <span className={`card-kind-chip card-kind-${c.kind}`}>{KIND[c.kind]}</span>
            <span className="review-row-text">
              <span className="review-row-title">{c.title}</span>
              {c.state === "answered" ? (
                <span className="review-row-said">{c.answer ? c.answer : "Seen"}</span>
              ) : c.state === "closed" ? (
                <span className="review-row-said">Withdrawn{c.closedWhy ? `: ${c.closedWhy}` : ""}</span>
              ) : (
                <span className="review-row-said">{c.short}</span>
              )}
            </span>
            <span className="review-row-when">
              <RelativeTime ts={c.answeredAt ?? c.laterAt ?? c.createdAt} short />
              {c.unread ? <span className="review-row-unread" title="No session has read this answer yet" /> : null}
            </span>
          </button>
          <Source card={c} state={state} />
        </li>
      ))}
    </ul>
  );
}
