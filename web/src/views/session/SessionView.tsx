import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AppState, ProviderId, Schedule } from "../../../../src/core/types";
import { api, fmtCost, fmtTokens, guessHome, tildify } from "../../api";
import {
  AccountChip,
  ContextBar,
  CopyButton,
  HostBadge,
  PROVIDER_LABEL,
  ProviderBadge,
  StatusPill,
} from "../../bits";
import { Button, Confirm, Empty, Icon } from "../../components";
import { filterSessions, neighbourId, sectionsOf, titleOf, type SessionRow } from "../../lib/board";
import { closedSessions, Rail, useListState } from "./Rail";
import { closeNow, forget, hideWhile, useClosing } from "./closing";
import { ScheduledDetail, scheduleTitle } from "./Scheduled";
import { isRecurring } from "../../../../src/core/schedule";
import { hrefOf, SESSION_TABS, type SessionTab } from "../../route";
import { Composer } from "./Composer";
import { DiffPanel } from "./DiffPanel";
import { LoadPanel } from "./LoadPanel";
import { useAction } from "./useAction";
import { useIsNarrow } from "./useIsNarrow";
import { prBaseFor } from "../../lib/prlinks";
import { PrBase } from "./prbase";
import { TermRail } from "./MessageRail";
import { jumpInTimeline } from "./jump";
import "./session.css";

const Terminal = lazy(() => import("./Terminal"));
// The timeline carries the markdown renderer, the second-heaviest dependency.
const Timeline = lazy(() => import("./Timeline").then((m) => ({ default: m.Timeline })));

const TAB_LABEL: Record<SessionTab, string> = {
  terminal: "Terminal",
  timeline: "Timeline",
  diff: "Diff",
  load: "Load",
};

/**
 * The Sessions page: the list down the side and the open session beside it —
 * or, with none open, an empty pane. On a narrow screen one of the two at a
 * time: the list until you pick a session, then the session.
 */
export function SessionView({
  state,
  id,
  tab,
  onTab,
  onOpen,
  onNew,
}: {
  state: AppState;
  id: string | null;
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  // One closed too long ago to be in the state comes from the closed list's
  // fetches, or is looked up by id for a link straight to it.
  const [, found] = useState(0);
  const session = id ? state.sessions.find((s) => s.id === id) ?? closedSessions.get(id) ?? null : null;
  // Not started yet: the same id, before there is a session under it.
  const sched = id && !session ? state.schedules.find((s) => s.id === id && !isRecurring(s.rule)) ?? null : null;
  const missing = !!id && !session && !sched;
  useEffect(() => {
    if (!missing || !id) return;
    let live = true;
    api.closed(id, 0, 5).then(
      (page) => {
        const s = page.sessions.find((x) => x.id === id);
        if (s && live) {
          closedSessions.set(id, s);
          found((n) => n + 1);
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [missing, id]);
  const narrow = useIsNarrow();
  const list = useListState();
  const { filter, sort, open, setOpen } = list;
  const closing = useClosing().pending;

  // Folded as the user left it, but never with the open session folded out of
  // sight. Closed ones are not here: they have their own list at the bottom.
  const sections = useMemo(() => {
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    const above = new Set<string>();
    for (let p = session?.parent; p && !above.has(p); p = byId.get(p)?.parent) above.add(p);
    const rows = filterSessions(
      state.sessions.filter((s) => s.id !== state.project.sessionId && s.status !== "closed" && !closing.has(s.id)),
      filter,
    );
    return sectionsOf(rows, (x) => open.has(x) || above.has(x), sort);
  }, [state.sessions, state.project.sessionId, session?.parent, filter, sort, open, closing]);
  const ordered = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const scheduled = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return state.schedules
      .filter((s) => !isRecurring(s.rule) && !closing.has(s.id))
      .filter((s) => !q || `${s.label ?? ""} ${s.spec.prompt ?? ""} ${s.id}`.toLowerCase().includes(q))
      .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  }, [state.schedules, filter.query, closing]);
  const cancelSchedule = (sc: Schedule) => {
    hideWhile(sc.id, scheduleTitle(sc), "cancel", api.deleteSchedule(sc.id));
    if (sc.id !== id) return;
    const next = scheduled.find((s) => s.id !== sc.id)?.id ?? ordered[0]?.id;
    if (next) onOpen(next);
    else location.hash = hrefOf({ page: "sessions" });
  };

  // Closing the open one opens the row that takes its place: the one below
  // it, or the one above at the bottom of the list.
  const close = (s: SessionRow) => {
    const i = ordered.findIndex((x) => x.id === s.id);
    const next = i === -1 ? null : (ordered[i + 1] ?? ordered[i - 1] ?? null);
    closeNow(s.id, titleOf(s));
    if (s.id !== id) return;
    if (next) onOpen(next.id);
    else location.hash = hrefOf({ page: "sessions" });
  };

  // j/k switch sessions and ←/→ fold, from anywhere that is not a text field
  // or the terminal; 1–4 pick a tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest(".xterm") || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector(".modal-backdrop")) return;
      const row = ordered.find((s) => s.id === id);
      if (e.key === "j" || e.key === "k") {
        const next = neighbourId(ordered, id, e.key === "j" ? 1 : -1);
        if (next && next !== id) {
          e.preventDefault();
          onOpen(next);
        }
      } else if ((e.key === "l" || e.key === "ArrowRight") && row?.kids && !open.has(row.id)) {
        e.preventDefault();
        setOpen(row.id, true);
      } else if ((e.key === "h" || e.key === "ArrowLeft") && row) {
        if (row.kids && open.has(row.id)) {
          e.preventDefault();
          setOpen(row.id, false);
        } else if (row.depth > 0 && row.parent) {
          e.preventDefault();
          onOpen(row.parent);
        }
      } else if (id && /^[1-4]$/.test(e.key)) {
        onTab(SESSION_TABS[Number(e.key) - 1]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const [railW, setRailW] = useRailWidth();
  const showRail = !narrow || !id;
  const showMain = !narrow || !!id;
  return (
    <div className="sv" data-rail={!showRail ? "off" : showMain ? "on" : "full"} style={{ "--rail-w": `${railW}px` } as CSSProperties}>
      {showRail && showMain ? <RailResizer width={railW} onWidth={setRailW} /> : null}
      {showRail ? <Rail sections={sections} state={state} current={id} list={list} onOpenFirst={() => ordered[0] && onOpen(ordered[0].id)} onClose={close} scheduled={scheduled} onCancelSchedule={cancelSchedule} /> : null}
      {!showMain ? null : session ? (
        <Detail key={session.id} session={session} state={state} tab={tab} onTab={onTab} onClose={close} />
      ) : sched ? (
        <ScheduledDetail key={sched.id} sc={sched} state={state} onCancel={cancelSchedule} />
      ) : id ? (
        <div className="sv-main">
          <Empty title="No such session" action={<a className="btn" href={hrefOf({ page: "sessions" })}>Back to sessions</a>}>
            <p>
              Nothing on the board has the id <code>{id}</code>. It may have been older than the board&apos;s{" "}
              {state.settings.boardDays}-day window, or the link is from another machine.
            </p>
          </Empty>
        </div>
      ) : (
        <div className="sv-main sv-none">
          {state.sessions.length === 0 && scheduled.length === 0 ? (
            <Empty
              title="No sessions yet"
              action={
                <Button variant="primary" icon={Icon.plus} onClick={onNew}>
                  New session
                </Button>
              }
            >
              Start one here, or run <code>agentbox claude</code> in a terminal. Sessions you start with plain{" "}
              <code>claude</code> or <code>codex</code> show up too, read-only until you adopt them.
            </Empty>
          ) : (
            <Empty title="Click a session to begin" />
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ rail width

const RAIL_W_KEY = "agentbox.railWidth";
const RAIL_W = 264;
const clampRail = (w: number) => Math.round(Math.max(200, Math.min(w, 640, innerWidth * 0.6)));

/** The list's width, as you last dragged it. */
function useRailWidth(): [number, (w: number, save?: boolean) => void] {
  const [w, setW] = useState(() => {
    const v = Number(localStorage.getItem(RAIL_W_KEY));
    return v > 0 ? clampRail(v) : RAIL_W;
  });
  const set = (next: number, save = true) => {
    const c = clampRail(next);
    setW(c);
    if (!save) return;
    if (c === RAIL_W) localStorage.removeItem(RAIL_W_KEY);
    else localStorage.setItem(RAIL_W_KEY, String(c));
  };
  return [w, set];
}

/**
 * The list's right edge, draggable. Double-click puts it back; ← → nudge it
 * when focused. Saved when the drag ends, not on every move.
 */
function RailResizer({ width, onWidth }: { width: number; onWidth: (w: number, save?: boolean) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className="rail-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the session list"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onWidth(d.w + e.clientX - d.x, false);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        setDragging(false);
        onWidth(d.w + e.clientX - d.x);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => onWidth(RAIL_W)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        // Not the page's h/l, j/k handling: this is a control of its own.
        e.stopPropagation();
        onWidth(width + (e.key === "ArrowLeft" ? -16 : 16));
      }}
    />
  );
}

// ------------------------------------------------------------------ detail

function Detail({
  session,
  state,
  tab,
  onTab,
  onClose,
}: {
  session: SessionRow;
  state: AppState;
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  onClose: (s: SessionRow) => void;
}) {
  const { run, busy, error, clear } = useAction();
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const close = () => onClose(session);
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home).concat(state.sessions.map((s) => s.cwd))), [state.accounts, state.sessions]);
  // listPrs matched it by branch; the newest-updated one wins if there are several.
  const pr = state.prs.find((p) => p.sessionId === session.id) ?? null;
  const attach = `agentbox attach ${session.id}`;
  const isProject = session.id === state.project.sessionId;
  const sessionIds = useMemo(() => new Set(state.sessions.map((s) => s.id)), [state.sessions]);
  const openSession = (id: string) => (location.hash = hrefOf({ page: "session", id, tab }));
  const prBase = useMemo(() => prBaseFor(session, state), [session, state]);
  const flashRow = useRef<((row: number) => void) | null>(null);
  const [termScrolled, setTermScrolled] = useState(0);

  return (
    <div className="sv-main">
      <header className="sx-header">
        <div className="sx-header-top">
          <ProviderBadge provider={session.provider} />
          <TitleEdit session={session} />
          <CopyButton text={session.id} label={session.id} className="sx-id" />
          <StatusPill status={session.status} />
          {/* tmux is the normal case; only say where it runs when it is not ours. */}
          {session.host === "external" ? <HostBadge host={session.host} /> : null}

          <div className="sx-header-actions">
            {isProject ? (
              <>
                <select
                  className="sx-harness"
                  aria-label="Project harness"
                  title="Which agent runs the Project. Changing it starts a fresh one."
                  value={state.project.provider}
                  disabled={busy}
                  onChange={(e) => void run(async () => openSession((await api.project(e.target.value as ProviderId)).id))}
                >
                  {state.providers.filter((p) => p.installed).map((p) => (
                    <option key={p.id} value={p.id}>
                      {PROVIDER_LABEL[p.id]}
                    </option>
                  ))}
                </select>
                {state.project.canCompact && session.host === "tmux" ? (
                  <Button size="sm" icon={Icon.move} disabled={busy} title="Summarise the conversation so far to free context" onClick={() => void run(() => api.compactProject())}>
                    Compact
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  icon={Icon.refresh}
                  disabled={busy}
                  title="Start a fresh Project conversation; this one is closed"
                  onClick={() => void run(async () => openSession((await api.clearProject()).id))}
                >
                  Clear
                </Button>
              </>
            ) : null}
            {session.host === "tmux" ? <CopyButton text={attach} label={attach} className="attach-copy" /> : null}
            <button
              type="button"
              className="sx-big"
              aria-pressed={session.big}
              disabled={busy}
              title={session.big ? "Big session: claims the larger share of the account's weekly. Click to make it normal." : "Mark as Big: claims the larger share of the account's weekly"}
              onClick={() => void run(() => api.patchSession(session.id, { big: !session.big }))}
            >
              <Icon.bolt size={12} /> Big
            </button>
            {session.host === "external" ? (
              <Button size="sm" variant="primary" icon={Icon.link} loading={busy} onClick={() => void run(() => api.adopt(session.id))}>
                Adopt
              </Button>
            ) : null}
            {session.host === "none" ? (
              <Button size="sm" variant="primary" icon={Icon.play} loading={busy} onClick={() => void run(() => api.resume(session.id))}>
                Resume
              </Button>
            ) : null}
            {session.host !== "none" ? (
              <Button size="sm" icon={Icon.stop} disabled={busy} onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
            ) : null}
            {isProject ? null : session.status === "closed" ? (
              <Button
                size="sm"
                variant="ghost"
                icon={Icon.undo}
                disabled={busy}
                title="Put it back on the list. It stays stopped until you resume it or send it something."
                onClick={() => {
                  forget(session.id);
                  void run(() => api.close(session.id, false));
                }}
              >
                Reopen
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={Icon.x}
                disabled={busy}
                title="Stop it and take it off the list. The transcript and worktree stay; See closed finds it, and it can be resumed."
                onClick={() => (session.status === "running" ? setConfirmClose(true) : void close())}
              >
                Close
              </Button>
            )}
          </div>
        </div>

        <div className="sx-facts">
          <span className="fact">
            <AccountChip
              accountId={session.accountId}
              accounts={state.accounts}
              cold={session.cold}
              onClick={() => (location.hash = hrefOf({ page: "accounts", sub: "accounts" }))}
            />
          </span>
          <span className="fact mono fact-cwd" title={session.cwd}>
            <Icon.folder size={12} />
            <span className="fact-cwd-text">
              <span dir="ltr">{tildify(session.cwd, home)}</span>
            </span>
          </span>
          {session.branch ? (
            <span className="fact mono">
              <Icon.branch size={12} /> {session.branch}
            </span>
          ) : null}
          {session.model ? (
            <span className="fact mono">
              {session.model}
              {session.effort ? <span className="muted"> · {session.effort}</span> : null}
            </span>
          ) : null}
          <span className="fact">
            <ContextBar used={session.contextUsed} limit={session.contextLimit} wide />
          </span>
          <span
            className="fact"
            title={`input ${session.tokens.input.toLocaleString()} · output ${session.tokens.output.toLocaleString()} · cache read ${session.tokens.cacheRead.toLocaleString()} · cache write ${session.tokens.cacheWrite.toLocaleString()}\nCost is what these tokens would cost at API prices — the common unit usage is apportioned in.\nStarted ${new Date(session.startedAt).toLocaleString()}`}
          >
            {fmtTokens(session.tokens.input + session.tokens.output)} tok · {fmtTokens(session.tokens.cacheRead)} cached ·{" "}
            <span className="muted">≈{fmtCost(session.tokens.costEquiv)}</span>
          </span>
          {pr && (
            <a className="fact" href={pr.url} target="_blank" rel="noreferrer">
              <Icon.prs size={12} /> #{pr.number}
              {pr.isDraft ? " (draft)" : ""}
            </a>
          )}
        </div>

        {session.status === "blocked" || error ? (
          <div className="sx-attention-line bad" role={error ? "alert" : undefined}>
            {error ? (
              <>
                That did not work: {error}{" "}
                <button className="linkish" onClick={clear}>
                  dismiss
                </button>
              </>
            ) : (
              <>
                <Icon.alert size={13} /> {session.attention.reason}.{" "}
                {session.question ? "Answer it below." : "The Terminal tab shows the prompt."}
              </>
            )}
          </div>
        ) : null}

        <div className="sx-tabs" role="tablist" aria-label="Session views">
          {SESSION_TABS.map((t, i) => (
            <button
              key={t}
              className="sx-tab"
              role="tab"
              aria-selected={tab === t}
              title={`${TAB_LABEL[t]} (${i + 1})`}
              onClick={() => onTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </header>

      <PrBase.Provider value={prBase}>
      <div className="sv-body" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "terminal" ? (
          session.host === "tmux" ? (
            <div className="sv-split">
              <Suspense fallback={<Empty title="Loading the terminal…" />}>
                <Terminal
                  sessionId={session.id}
                  sessionIds={sessionIds}
                  prBase={prBase}
                  flashRef={flashRow}
                  onScrolled={() => setTermScrolled((n) => n + 1)}
                />
              </Suspense>
              <TermRail
                session={session}
                flash={flashRow}
                scrolled={termScrolled}
                onElsewhere={(t, why) => {
                  jumpInTimeline(session.id, { turnId: t.id, note: `${why} Showing it in the timeline instead.` });
                  onTab("timeline");
                }}
              />
            </div>
          ) : (
            <TranscriptInstead session={session} busy={busy} onAdopt={() => void run(() => api.adopt(session.id))} onResume={() => void run(() => api.resume(session.id))} />
          )
        ) : tab === "timeline" ? (
          <Suspense fallback={<Empty title="Loading the timeline…" />}>
            <Timeline session={session} />
          </Suspense>
        ) : tab === "diff" ? (
          <DiffPanel sessionId={session.id} active={session.status === "running"} />
        ) : (
          <LoadPanel sessionId={session.id} />
        )}
      </div>
      </PrBase.Provider>

      <Composer session={session} accounts={state.accounts} claimIdleMin={state.settings.balancer.claimIdleMin} />

      {confirmClose ? (
        <Confirm
          title={`Close “${titleOf(session)}”?`}
          confirmLabel="Close"
          body={<p>It is mid-turn. Closing stops it now, so this turn is cut short. The conversation is kept, and See closed finds it to reopen or resume.</p>}
          onCancel={() => setConfirmClose(false)}
          onConfirm={() => {
            setConfirmClose(false);
            void close();
          }}
        />
      ) : null}
      {confirmStop ? (
        <Confirm
          title={`Stop “${titleOf(session)}”?`}
          confirmLabel="Stop"
          body={
            <p>
              Ends the {PROVIDER_LABEL[session.provider]} process
              {session.host === "external" ? " running in your other terminal" : " and its tmux session"}. The conversation is kept and Resume
              continues it — on the same account while its cache is warm, on whichever has room once it has been idle an hour.
            </p>
          }
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            void run(() => api.stop(session.id));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The Terminal tab when there is no terminal to attach to: the conversation
 * itself, under one line saying why it is not live and how to make it so.
 * Reading a stopped session should not cost a resume.
 */
function TranscriptInstead({
  session,
  busy,
  onAdopt,
  onResume,
}: {
  session: SessionRow;
  busy: boolean;
  onAdopt: () => void;
  onResume: () => void;
}) {
  const external = session.host === "external";
  return (
    <div className="term-transcript">
      <div className="term-transcript-bar">
        <Icon.terminal size={13} />
        {external ? (
          <span>
            Running in a terminal agentbox did not start, so there is no live terminal here — this is its transcript. Adopt it to take it over:
            agentbox proves the conversation resumes, stops that process, and continues it in its own tmux.
          </span>
        ) : (
          <span>
            {session.status === "closed" ? "Closed" : "Stopped"} — this is its transcript. Resume, or type a prompt below, to get the live
            terminal back
            {session.cold ? " on whichever account has room (its cache is cold)" : " on the same account"}.
          </span>
        )}
        {external ? (
          <Button size="sm" variant="primary" icon={Icon.link} loading={busy} onClick={onAdopt}>
            Adopt
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Icon.play} loading={busy} onClick={onResume}>
            Resume
          </Button>
        )}
      </div>
      <Suspense fallback={<Empty title="Loading the transcript…" />}>
        <Timeline session={session} />
      </Suspense>
    </div>
  );
}

/** The title, click to rename. Clearing it falls back to the derived title. */
function TitleEdit({ session }: { session: SessionRow }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { run, busy } = useAction();
  const title = titleOf(session);

  if (!editing) {
    return (
      <h2 className="sx-title">
        <button
          className="sx-title-btn"
          title="Rename"
          onClick={() => {
            setDraft(session.label ?? title);
            setEditing(true);
          }}
        >
          <span className="sx-title-text">{title}</span>
          <Icon.edit size={13} className="sx-title-pen" />
        </button>
      </h2>
    );
  }

  const commit = async () => {
    const next = draft.trim();
    if (next === (session.label ?? title)) {
      setEditing(false);
      return;
    }
    if (await run(() => api.patchSession(session.id, { label: next || null }))) setEditing(false);
  };

  return (
    <input
      className="sx-title-input"
      aria-label="Session label"
      autoFocus
      value={draft}
      disabled={busy}
      placeholder={session.title || "Label"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}
