/**
 * Review: the cards sessions handed you (src/core/cards.ts), one at a time.
 *
 * A stack (cardorder.ts): what you have never put off, decisions before what
 * happened, then what you kept for later. The card on top takes three gestures, each with a
 * button under it and a Shift+arrow shortcut (plain arrows navigate):
 *   right (Shift+→) — answer it: a sheet with a text box. Empty, on a card that
 *               only wanted seeing, means "seen".
 *   left  (Shift+←) — keep it for later: behind the others of its kind, and on the Later list.
 *   up    (Shift+↑) — the long version, from which the others work.
 *   down  (Shift+↓) — approve: the asker's recommendation is your answer. On a card
 *               that only wanted seeing, seen. A decision with no
 *               recommendation has nothing to approve, and springs back.
 * The last one can be taken back (u): an answer is held a few seconds before
 * it is typed into the session that asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { type AppState, type Card, type Repo, type Session, AttachButton, AttachFrame, Button, call, describeAt, Empty, go, href, Icon, Markdown, MarkdownLinks, Modal, RelativeTime, useDraft } from "agentbox/client";
import { laterOf, stackOf } from "./cardorder";
import "./review.css";

const api = {
  card: (id: number) => call<Card>("GET", `/api/cards/${id}`),
  answerCard: (id: number, text: string) => call<Card>("POST", `/api/cards/${id}/answer`, { text }),
  laterCard: (id: number) => call<Card>("POST", `/api/cards/${id}/later`),
  undoCard: (id: number) => call<Card>("POST", `/api/cards/${id}/undo`),
  sendCard: (id: number) => call<Card>("POST", `/api/cards/${id}/send`),
  start: (body: { provider: string; cwd: string; prompt: string }) => call<{ session: Session }>("POST", "/api/sessions", body),
};

/** How long "catching you up" stays, with its link to the session. */
const CAUGHT_UP_SHOWN_MS = 15_000;
/** How many cards are marked seen at once when a catch-up takes them. */
const SEEN_AT_ONCE = 8;

/** Where a catch-up session runs: the checkout of the repo most of its pull requests are in, else home. */
function catchUpDir(cards: Card[], repos: Repo[]): string {
  const n = new Map<string, number>();
  for (const c of cards) {
    const slug = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(c.pr ?? "")?.[1]?.toLowerCase();
    const repo = slug && repos.find((r) => r.fullName?.toLowerCase() === slug && r.checkoutRoot);
    if (repo) n.set(repo.checkoutRoot!, (n.get(repo.checkoutRoot!) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "~";
}

/** What the catch-up session is asked, as you: read the reports, teach what changed in one page, hand it back as a card. */
function catchUpPrompt(cards: Card[]): string {
  const ids = cards.map((c) => c.id).sort((a, b) => a - b).join(" ");
  const merged = cards.filter((c) => c.kind === "merged").length;
  return `Catch me up on what happened while I wasn't keeping up: ${cards.length} Review cards, ${merged} of them pull requests that merged and the rest notes sessions left me (daily digests of what shipped, release notes, findings, account rates). They are cards ${ids}. Read them all with \`agentbox card show ${ids}\` (each has a title, a summary, often a PR link and a long version). Where a card doesn't tell you enough to explain the change, read the PR (\`gh pr view\`, \`gh pr diff\`) and the code it touched.

Then make me one HTML page that gets me up to date on how our system has changed. It is a lesson, not a changelog, and it need not mention every PR: use everything you know to teach me what changed in the way I'll understand and remember best. Group changes by the part of the system and the idea behind them, not by PR; lead with what changes most how the product behaves and how I'd work on it; say what it did before and what it does now, and why; use diagrams, worked examples, tables or whatever teaches each one best, and show each changed screen with the screenshots its PR links (an after, beside its before when there is one), downloaded and inlined as data URIs. Link each PR you draw on, so I can go deeper, and end with a short list of the minor ones. Digests and release notes overlap the PRs and each other: use them for what reached production and what went wrong, not as items of their own. It should read well on a phone and on a desk, in light and dark.

Write it to \`\${AGENTBOX_HOME:-$HOME/.local/share/agentbox}/catch-up/<YYYY-MM-DD-HHMM>.html\`, self-contained: inline CSS, scripts and images, no fetches, no CDNs. This is reading and writing that page only: change no code and no repo.

When the page is done, hand it to me as a card, last: \`agentbox card add --kind note --title "Catch up: <what changed, in a line>" --short "<the two or three biggest changes, in a sentence or two>. [Open the page](<the page's absolute path>)"\`. That card is how I'll find it.`;
}

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

export function Review({ state, rest }: { state: AppState; rest: string }) {
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
  /** Reports not yet seen (merged PRs and notes): a right swipe on one hands them all to a catch-up session. */
  const reports = useMemo(() => cards.filter((c) => c.kind !== "decision" && (c.state === "open" || c.state === "later")), [cards]);
  const [catchingUp, setCatchingUp] = useState(false);
  const [caughtUp, setCaughtUp] = useState<{ session: string; n: number } | null>(null);
  const respond = useCallback((c: Card) => (c.kind === "decision" ? setAnswering(c) : setCatchingUp(true)), []);
  const [reading, setReading] = useState<Card | null>(null);
  // `#/review/card/1160` (what "card 1160" in a card or a session links to)
  // opens that card whole, fetched when this project's list does not hold it.
  const linked = Number(/^card\/(\d+)$/.exec(rest)?.[1]) || null;
  useEffect(() => {
    if (!linked) return;
    const held = state.cards.find((c) => c.id === linked);
    if (held) setReading(held);
    else api.card(linked).then(setReading, (e: Error) => setError(e.message));
    // Once per link, not on every state push.
  }, [linked]);
  const [leaving, setLeaving] = useState<{ id: number; to: "left" | "right" | "down" } | null>(null);
  /** The last gesture, while Undo is offered; `done` is true once the server has it. */
  const [last, setLast] = useState<{ card: Card; what: "answered" | "approved" | "seen" | "later"; at: number; done: Promise<boolean> } | null>(null);
  /** The card Undo was pressed on, whose answer must not then be sent. */
  const undone = useRef<number | null>(null);
  /** Said for a moment when a gesture had nothing to do. */
  const [nothing, setNothing] = useState<string | null>(null);
  useEffect(() => {
    if (!nothing) return;
    const t = setTimeout(() => setNothing(null), 2600);
    return () => clearTimeout(t);
  }, [nothing]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!caughtUp) return;
    const t = setTimeout(() => setCaughtUp(null), CAUGHT_UP_SHOWN_MS);
    return () => clearTimeout(t);
  }, [caughtUp]);

  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setLast((l) => (l === last ? null : l)), UNDO_SHOWN_MS);
    return () => clearTimeout(t);
  }, [last]);

  // An answer whose Undo goes away other than by pressing it (another gesture,
  // leaving the page or the app) is sent then, not when the server's hold ends.
  useEffect(() => {
    if (!last || last.what === "later" || last.what === "seen") return;
    const hide = () => document.visibilityState === "hidden" && setLast((l) => (l === last ? null : l));
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      if (undone.current === last.card.id) return;
      void last.done.then((ok) => (ok ? api.sendCard(last.card.id) : null)).catch(() => {});
    };
  }, [last]);

  /** Do it: the card leaves in the gesture's direction, then is gone from the stack. True once the server has it. */
  const act = useCallback((card: Card, what: "answered" | "approved" | "seen" | "later", text = ""): Promise<boolean> => {
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
    undone.current = null;
    const done = (what === "later" ? api.laterCard(card.id) : api.answerCard(card.id, text)).then(
      () => true,
      (e: Error) => {
        setError(e.message);
        setLast(null);
        setLocal((prev) => {
          const next = new Map(prev);
          next.delete(card.id);
          return next;
        });
        return false;
      },
    );
    setLast({ card, what, at: Date.now(), done });
    return done;
  }, []);

  const undo = useCallback(() => {
    if (!last) return;
    const { card } = last;
    undone.current = card.id;
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

  /** Start the session that writes the catch-up page, then mark every card it took seen. */
  const catchUp = useCallback(
    async (list: Card[]) => {
      const { session } = await api.start({ provider: "claude", cwd: catchUpDir(list, state.repos), prompt: catchUpPrompt(list) });
      setCatchingUp(false);
      setReading(null);
      setLast(null);
      setError(null);
      setCaughtUp({ session: session.id, n: list.length });
      const at = Date.now();
      setLocal((prev) => {
        const next = new Map(prev);
        for (const c of list) next.set(c.id, { state: "answered", answer: "", answeredAt: at });
        return next;
      });
      const failed: Card[] = [];
      for (let i = 0; i < list.length; i += SEEN_AT_ONCE) {
        await Promise.all(list.slice(i, i + SEEN_AT_ONCE).map((c) => api.answerCard(c.id, "").catch(() => failed.push(c))));
      }
      if (!failed.length) return;
      setError(`The catch-up started, but ${failed.length} of its cards could not be marked seen.`);
      setLocal((prev) => {
        const next = new Map(prev);
        for (const c of failed) next.delete(c.id);
        return next;
      });
    },
    [state.repos],
  );

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
      if (answering || catchingUp || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (!el?.closest(".review")) return;
      if (e.key.startsWith("Arrow") && !e.shiftKey) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const card = reading ?? (tab === "stack" ? shownTop : null);
      if (e.key === "u") undo();
      else if (!card || card.state === "answered" || card.state === "closed") return;
      else if (e.key === "ArrowRight") respond(card);
      else if (e.key === "ArrowLeft") act(card, "later");
      else if (e.key === "ArrowUp" && !reading) setReading(card);
      else if (e.key === "ArrowDown" && !reading) approve(card);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [answering, catchingUp, reading, tab, shownTop, act, undo, approve, respond]);

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
                      onRight={() => respond(c)}
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
            <Actions card={top ?? shownTop!} reports={reports.length} onLater={(c) => act(c, "later")} onRead={setReading} onApprove={approve} onAnswer={respond} />
          </>
        )
      ) : (
        <CardList cards={tab === "later" ? later : done} state={state} empty={tab === "later" ? "Nothing kept for later." : "Nothing answered yet."} onOpen={setReading} />
      )}

      {caughtUp && !last ? (
        <div className="review-undo" role="status">
          <span>
            Catching you up on {caughtUp.n} card{caughtUp.n === 1 ? "" : "s"}
            <span className="faint"> · they are marked seen; the page comes back here as a card</span>
          </span>
          <a className="btn btn-default btn-sm" href={href({ page: "session", id: caughtUp.session, tab: "timeline" })}>
            Watch it
          </a>
        </div>
      ) : null}
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
          onClose={() => {
            setReading(null);
            if (linked) go({ page: "ext", id: "review", rest: "" }, true);
          }}
          onLater={(c) => act(c, "later")}
          onApprove={approve}
          onAnswer={respond}
          reports={reports.length}
        />
      ) : null}
      {catchingUp ? <CatchUpSheet cards={reports} onClose={() => setCatchingUp(false)} onStart={catchUp} /> : null}
      {answering ? <AnswerSheet card={answering} onClose={() => setAnswering(null)} onSend={(text) => act(answering, text ? "answered" : "seen", text)} /> : null}
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
  reports,
  long,
}: {
  card: Card;
  onLater: (c: Card) => void;
  onRead?: (c: Card) => void;
  onApprove: (c: Card) => void;
  onAnswer: (c: Card) => void;
  /** How many reports a catch-up would take. */
  reports: number;
  long?: boolean;
}) {
  const does = downOf(card);
  return (
    <div className={`review-actions${long ? " review-actions-long" : ""}`}>
      <button type="button" className="review-act review-act-later" onClick={() => onLater(card)} title="Keep it for later (Shift+←)">
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
      <button
        type="button"
        className="review-act review-act-answer"
        onClick={() => onAnswer(card)}
        title={card.kind === "decision" ? "Answer it (Shift+→)" : `Have a session write one page that catches you up on all ${reports} cards that only report (Shift+→)`}
      >
        <span>{card.kind === "decision" ? "Answer" : "Catch me up"}</span>
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
        <a className="card-from" href={href({ page: "session", id: card.sessionId, tab: "timeline" })} title={`The session that asked (${card.sessionId})`}>
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
 * What a card's words link to: a session it names opens that session, and
 * `#123` the pull request, in the repo of the card's own PR, else of the
 * session that made it.
 */
function CardLinks({ card, children }: { card: Card; children: ReactNode }) {
  return (
    <MarkdownLinks session={card.sessionId} pr={card.pr}>
      {children}
    </MarkdownLinks>
  );
}

/** What is being suggested: the choices, what the asker would do, and what it does unasked once its time passes. */
function Leaning({ card }: { card: Card }) {
  const passed = card.defaultAt !== null && card.defaultAt <= Date.now();
  if (!card.options.length && !card.recommend && !card.default) return null;
  return (
    <div className="card-leaning">
      {card.options.length ? (
        <div>
          <strong>Options</strong>
          <ol className="card-options">
            {card.options.map((o, i) => (
              <li key={i}>
                <Markdown inline text={o} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
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
    // A tap opens the long version, as an up swipe does.
    if (!d.moved) return onUp();
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
        {card.kind === "decision" ? "Answer" : "Catch me up"}
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
      <CardLinks card={card}>
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
  reports,
}: {
  card: Card;
  state: AppState;
  onClose: () => void;
  onLater: (c: Card) => void;
  onApprove: (c: Card) => void;
  onAnswer: (c: Card) => void;
  reports: number;
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
      <CardLinks card={card}>
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
      {open ? <Actions card={card} reports={reports} onLater={onLater} onApprove={onApprove} onAnswer={onAnswer} long /> : null}
    </div>
  );
}

/** The sheet a right swipe opens: a text box over the keyboard, which takes
 *  images and keeps what is typed until it is sent, as the composer does. */
function AnswerSheet({ card, onClose, onSend }: { card: Card; onClose: () => void; onSend: (text: string) => Promise<boolean> }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const { text, setText, images, body, discard } = useDraft(`card:${card.id}`, box);
  const [error, setError] = useState<string | null>(null);
  const decision = card.kind === "decision";
  const empty = !text.trim();
  // A restored draft is picked up where it ended.
  useEffect(() => {
    const el = box.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <Modal title={decision ? "Your answer" : "Respond"} hint={card.title} onClose={onClose}>
      <form
        className="review-answer"
        onSubmit={(e) => {
          e.preventDefault();
          if ((decision && empty) || images.uploading) return;
          body().then(
            (t) => onSend(t).then((ok) => ok && discard()),
            (e: Error) => setError(e.message),
          );
        }}
      >
        {card.recommend ? (
          <button type="button" className="review-take" onClick={() => setText(APPROVE)}>
            <Icon.check size={13} /> Go with the recommendation
          </button>
        ) : null}
        {card.options.map((o, i) => (
          <button key={i} type="button" className="review-take" onClick={() => setText(o)}>
            <span>
              {i + 1}. <Markdown inline text={o} />
            </span>
          </button>
        ))}
        <AttachFrame a={images} className="review-answer-frame">
          <textarea
            ref={box}
            className="input review-answer-box"
            autoFocus
            rows={4}
            value={text}
            placeholder={decision ? "What should it do? Paste or drop images too." : "Nothing to add? Send it empty: that means seen, fine."}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (images.onKeyDown(e)) return;
              if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </AttachFrame>
        <div className="review-answer-foot">
          <AttachButton a={images} />
          <span className="faint review-answer-note">
            {error ? <span className="error">{error}</span> : empty && !decision ? "Marks it seen; nothing is sent to the session." : "Typed into the session that asked, as you."}
          </span>
          <Button type="submit" variant="primary" icon={empty && !decision ? Icon.check : Icon.send} disabled={(decision && empty) || images.uploading}>
            {empty && !decision ? "Seen" : "Send"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** What a right swipe on a report opens: one go for all of them, said before it is done. */
function CatchUpSheet({ cards, onClose, onStart }: { cards: Card[]; onClose: () => void; onStart: (cards: Card[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = cards.length;
  return (
    <Modal title="Catch me up" hint={`${n} card${n === 1 ? "" : "s"} that only report`} onClose={onClose}>
      <form
        className="review-answer"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !n) return;
          setBusy(true);
          setError(null);
          onStart(cards).catch((e: Error) => {
            setError(e.message);
            setBusy(false);
          });
        }}
      >
        <p>
          A new Claude session reads {n === 1 ? "this card" : `all ${n} of them`} (merged PRs, digests, release notes, findings) and the PRs behind them, and writes you one page that teaches what changed in the system. When the page is done it comes back here as a card that opens it.
        </p>
        <p className="faint">Starting it marks {n === 1 ? "the card" : `all ${n}`} seen.</p>
        <div className="review-answer-foot">
          <span className="faint review-answer-note">{error ? <span className="error">{error}</span> : null}</span>
          <Button type="submit" variant="primary" icon={Icon.send} disabled={busy || !n} autoFocus>
            {busy ? "Starting…" : "Start"}
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
