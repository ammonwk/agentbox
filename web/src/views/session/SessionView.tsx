import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AccountView, AppState, Schedule } from "../../../../src/core/types";
import { api, fmtCost, fmtTokens, guessHome, tildify, useNow } from "../../api";
import { AccountChip, ContextBar, PROVIDER_LABEL, UsageBar } from "../../bits";
import { Button, Confirm, Empty, Icon, type IconComponent } from "../../components";
import {
  descendantsOf,
  filterSessions,
  neighbourId,
  parentsOf,
  runningDescendants,
  runningSubagents,
  sectionsOf,
  shownStatus,
  splitActive,
  titleOf,
  type SessionRow,
} from "../../lib/board";
import { closedSessions, Rail, useListState } from "./Rail";
import { closeNow, forget, hideWhile, useClosing } from "./closing";
import { toggleBookmark, togglePin, usePinned } from "./pins";
import { justStarted } from "./started";
import { ScheduledDetail, scheduleTitle } from "./Scheduled";
import { isRecurring } from "../../../../src/core/schedule";
import { go, hrefOf, SESSION_TABS, type SessionTab } from "../../route";
import { Composer } from "./Composer";
import { WorkStrip } from "./WorkStrip";
import { DiffPanel } from "./DiffPanel";
import { LoadPanel } from "./LoadPanel";
import { useAction } from "./useAction";
import { useIsNarrow } from "./useIsNarrow";
import { isInstalledApp, useIsPhone } from "../../lib/phone";
import { useSysbarSlot } from "../../sysbarslot";
import { prBaseFor } from "../../lib/prlinks";
import { repoOfSession, skillsFor } from "../../lib/newsession";
import { useScope, useProjectData, sessionProject } from "../../lib/projects";
import { selectScope } from "../../route";
import { ago, fmtRetryAt } from "../../lib/format";
import { outstandingOf, sortWindows } from "../../lib/usage";
import { useDismiss, useFloating } from "../newsession/popover";
import { buildSessionIndex } from "../../lib/sessionrefs";
import { PrBase } from "./prbase";
import { SessionLinks } from "./sessionlinks";
import { TermRail } from "./MessageRail";
import { jumpInTimeline } from "./jump";
import { FamilyContext, FamilyStrip, useFamilyOf } from "./family";
import "./session.css";

const Terminal = lazy(() => import("./Terminal"));
// The timeline carries the markdown renderer, the second-heaviest dependency.
const Timeline = lazy(() => import("./Timeline").then((m) => ({ default: m.Timeline })));

const NONE: SessionRow[] = [];
/** Pin and bookmark drawn filled while on. */
const PinOn: IconComponent = (p) => <Icon.pin {...p} weight="fill" />;
const BookmarkOn: IconComponent = (p) => <Icon.bookmark {...p} weight="fill" />;

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
  state: given,
  visible: scoped = given,
  id,
  tab,
  onTab,
  onOpen,
  onNew,
}: {
  state: AppState;
  /** Scope the list without hiding running descendants from close/stop warnings. */
  visible?: AppState;
  id: string | null;
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  // Pins and bookmarks just asked for, shown before the server's state has them.
  const pinned = usePinned(given.sessions);
  const state = useMemo(() => (pinned === given.sessions ? given : { ...given, sessions: [...pinned] }), [given, pinned]);
  const visiblePinned = usePinned(scoped.sessions);
  const visible = useMemo(() => (visiblePinned === scoped.sessions ? scoped : { ...scoped, sessions: [...visiblePinned] }), [scoped, visiblePinned]);
  // One closed too long ago to be in the state comes from the closed list's
  // fetches, or is looked up by id for a link straight to it.
  const [, found] = useState(0);
  const old = id && !state.sessions.some((s) => s.id === id) ? closedSessions.get(id) : undefined;
  const [oldShown] = usePinned(old ? [old] : NONE);
  const session = id ? state.sessions.find((s) => s.id === id) ?? oldShown ?? justStarted(id) : null;
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
  const scope = useScope();
  const projectData = useProjectData();
  const { filter, sort, view, open, setOpen, hovered, focused } = list;
  // Moves a session to Inactive once its last activity is 3 hours old, with no new state frame.
  const now = useNow(60_000);
  const closing = useClosing().pending;

  // Keep the current, hovered and focused branches open while moving into their children.
  const above = useMemo(() => {
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    const set = new Set<string>();
    for (const start of [session?.id, hovered, focused]) {
      for (let p = start; p && !set.has(p); p = byId.get(p)?.parent) set.add(p);
    }
    return set;
  }, [state.sessions, session?.id, hovered, focused]);

  // Folded as the user left it, but never with the open session folded out of
  // sight. Closed ones are not here: they have their own list under Inactive,
  // unless pinned: a pin holds its place closed or not.
  const { sections, counts } = useMemo(() => {
    const rows = filterSessions(
      visible.sessions.filter((s) => s.pinOrder !== null || (s.status !== "closed" && !closing.has(s.id))),
      filter,
    );
    const tabs = splitActive(rows, now);
    const roots = (r: SessionRow[]) => r.length - parentsOf(r).size;
    return {
      sections: sectionsOf(tabs[view], (x) => open.has(x) || above.has(x), sort),
      counts: { active: roots(tabs.active), inactive: roots(tabs.inactive) },
    };
  }, [visible.sessions, above, filter, sort, view, now, open, closing]);
  const ordered = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const scheduled = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return visible.schedules
      .filter((s) => !isRecurring(s.rule) && !closing.has(s.id))
      .filter((s) => !q || `${s.label ?? ""} ${s.spec.prompt ?? ""} ${s.id}`.toLowerCase().includes(q))
      .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  }, [visible.schedules, filter.query, closing]);
  const cancelSchedule = (sc: Schedule) => {
    hideWhile(sc.id, scheduleTitle(sc), "cancel", api.deleteSchedule(sc.id));
    if (sc.id !== id) return;
    // On a phone the list is where you go back to, so it is where you land.
    const next = narrow ? null : (scheduled.find((s) => s.id !== sc.id)?.id ?? ordered[0]?.id);
    if (next) onOpen(next);
    else go({ page: "sessions" });
  };

  // Closing one that runs sessions of its own stops them mid-task, so that is asked first.
  const [closingParent, setClosingParent] = useState<SessionRow | null>(null);
  // Alt+W on a mid-turn session asks first, as the Close button does.
  const [confirmCloseRow, setConfirmCloseRow] = useState<SessionRow | null>(null);
  const close = (s: SessionRow) => (runningDescendants(s, state.sessions).length > 0 ? setClosingParent(s) : closeRow(s));
  // Closing the open one opens the row that takes its place: the one below
  // it, or the one above at the bottom of the list. On a phone, the list.
  const closeRow = (s: SessionRow) => {
    const i = ordered.findIndex((x) => x.id === s.id);
    const next = i === -1 || narrow ? null : (ordered[i + 1] ?? ordered[i - 1] ?? null);
    closeNow(s.id, titleOf(s), descendantsOf(s, state.sessions).map((c) => c.id));
    if (s.id !== id) return;
    if (next) onOpen(next.id);
    else go({ page: "sessions" });
  };

  // Alt+Shift+T: the most recently closed session, from all of history —
  // reopen it and open it. Pressed again it reopens the one before, since
  // the one just reopened is closed no more.
  const reopenLast = () => {
    api.closed("", 0, 1, scope.project).then((page) => {
      const s = page.sessions[0];
      if (!s) return;
      forget(s.id);
      api.close(s.id, false).then(
        () => onOpen(s.id),
        () => undefined,
      );
    }, () => undefined);
  };

  // Alt+W closes the open session and Alt+Shift+T reopens the most recently
  // closed one; in the installed app Ctrl does too, and Ctrl+Tab and
  // Ctrl+Shift+Tab step through the sessions like a browser's tabs. Capture
  // these before the terminal handles its own keys (so there Ctrl+W no longer
  // deletes a word: Ctrl+Backspace still does). Shift+Tab in the terminal is
  // taken here too: it steps back a tab as it does everywhere else, and never
  // reaches the agent, where it would change the permission mode.
  useEffect(() => {
    const onShortcut = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && id && (e.target as HTMLElement | null)?.closest(".xterm")) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.isComposing && !document.querySelector(".modal-backdrop")) {
          onTab(SESSION_TABS[(SESSION_TABS.indexOf(tab) - 1 + SESSION_TABS.length) % SESSION_TABS.length]);
        }
        return;
      }
      const app = e.ctrlKey && !e.altKey && isInstalledApp();
      if ((app || (e.altKey && !e.ctrlKey)) && !e.metaKey && !e.defaultPrevented && !document.querySelector(".modal-backdrop")) {
        if (app && e.key === "Tab") {
          if (ordered.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          const i = ordered.findIndex((s) => s.id === id);
          const step = e.shiftKey ? -1 : 1;
          onOpen(ordered[i === -1 ? (step === 1 ? 0 : ordered.length - 1) : (i + step + ordered.length) % ordered.length].id);
        } else if (e.key.toLowerCase() === "w" && !e.shiftKey) {
          const row = id ? state.sessions.find((s) => s.id === id) : null;
          if (!row || row.status === "closed") return;
          e.preventDefault();
          e.stopPropagation();
          if (row.status === "running" && runningDescendants(row, state.sessions).length === 0) setConfirmCloseRow(row);
          else close(row);
        } else if (e.shiftKey && e.key.toLowerCase() === "t") {
          e.preventDefault();
          e.stopPropagation();
          reopenLast();
        }
      }
    };
    // j/k switch sessions and l/h fold within this page, outside text fields
    // and the terminal; 1–4 pick a tab. Tab reaches controls normally, except
    // Shift+Tab in the terminal, which is reserved above. Pane navigation
    // lives in the shared keyboard handler.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest(".sv")) return;
      if (t.closest(".xterm") || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (document.querySelector(".modal-backdrop")) return;
      const row = ordered.find((s) => s.id === id);
      if (e.key === "j" || e.key === "k") {
        const next = neighbourId(ordered, id, e.key === "j" ? 1 : -1);
        if (next && next !== id) {
          e.preventDefault();
          onOpen(next);
        }
      } else if (e.key === "l" && row?.kids && !open.has(row.id)) {
        e.preventDefault();
        setOpen(row.id, true);
      } else if (e.key === "h" && row) {
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
    addEventListener("keydown", onShortcut, true);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onShortcut, true);
      removeEventListener("keydown", onKey);
    };
  });

  const [railW, setRailW] = useRailWidth();
  const showRail = !narrow || !id;
  const showMain = !narrow || !!id;
  if (session && scope.project && sessionProject(projectData.repos, projectData.agents, session) !== scope.project) return <Empty title="This session belongs to another project"><Button onClick={() => selectScope("project", sessionProject(projectData.repos, projectData.agents, session), { page: "session", id: session.id, tab })}>Open in its project</Button></Empty>;
  return (
    <div className="sv" data-rail={!showRail ? "off" : showMain ? "on" : "full"} style={{ "--rail-w": `${railW}px` } as CSSProperties}>
      {showRail && showMain ? <RailResizer width={railW} onWidth={setRailW} /> : null}
      {showRail ? <Rail sections={sections} counts={counts} state={state} current={id} forcedOpen={above} list={list} onOpenFirst={() => ordered[0] && onOpen(ordered[0].id)} onClose={close} scheduled={scheduled} onCancelSchedule={cancelSchedule} /> : null}
      {!showMain ? null : session ? (
        <Detail key={session.id} session={session} state={state} tab={tab} onTab={onTab} onClose={close} />
      ) : sched ? (
        <ScheduledDetail key={sched.id} sc={sched} state={state} onCancel={cancelSchedule} />
      ) : id ? (
        <div data-nav-region="detail" tabIndex={-1} aria-label="Session" className="sv-main">
          <Empty title="No such session" action={<a className="btn" href={hrefOf({ page: "sessions" })}>Back to sessions</a>}>
            <p>
              Nothing on the board has the id <code>{id}</code>. It may have been older than the board&apos;s{" "}
              {state.settings.boardDays}-day window, or the link is from another machine.
            </p>
          </Empty>
        </div>
      ) : (
        <div data-nav-region="detail" tabIndex={-1} aria-label="Session" className="sv-main sv-none">
          {visible.sessions.length === 0 && scheduled.length === 0 ? (
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
      {closingParent ? (
        <Confirm
          title={`Close “${titleOf(closingParent)}”?`}
          confirmLabel="Close"
          body={
            <p>
              Closing takes it, and every session it started, off the board. <RunningFamily session={closingParent} sessions={state.sessions} />
              The conversations are kept, and See closed finds them.
            </p>
          }
          onCancel={() => setClosingParent(null)}
          onConfirm={() => {
            closeRow(closingParent);
            setClosingParent(null);
          }}
        />
      ) : null}
      {confirmCloseRow ? (
        <ConfirmClose
          session={confirmCloseRow}
          onCancel={() => setConfirmCloseRow(null)}
          onConfirm={() => {
            closeRow(confirmCloseRow);
            setConfirmCloseRow(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Asked before closing a session that is mid-turn: the turn would be cut short. */
function ConfirmClose({ session, onCancel, onConfirm }: { session: SessionRow; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm
      title={`Close “${titleOf(session)}”?`}
      confirmLabel="Close"
      body={<p>It is mid-turn. Closing stops it now, so this turn is cut short. The conversation is kept, and See closed finds it to reopen or resume.</p>}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** "3 subagents (a, b, c)" — what stops with `session`. */
function SubagentNames({ session, sessions }: { session: SessionRow; sessions: AppState["sessions"] }) {
  const subs = runningSubagents(session, sessions);
  return (
    <>
      {subs.length === 1 ? "a subagent" : `${subs.length} subagents`} ({subs.map((c) => c.subagent?.name ?? c.title).join(", ")})
    </>
  );
}

/** "2 of them (a, b) are still running — closing stops them mid-task…" — the
 *  sessions a close would cut short, at any depth under `session`. */
function RunningFamily({ session, sessions }: { session: SessionRow; sessions: AppState["sessions"] }) {
  const rows = runningDescendants(session, sessions);
  const one = rows.length === 1;
  return (
    <>
      {one ? "One of them" : `${rows.length} of them`} ({rows.map((c) => c.subagent?.name ?? c.title).join(", ")}) {one ? "is" : "are"} still
      running — closing stops {one ? "it" : "them"} mid-task, and answers {one ? "it has" : "they have"} not handed back are lost.{" "}
    </>
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

/**
 * The session's account, and under a press its usage: each limit window as
 * the Accounts page draws it, the weekly one with what sessions still claim.
 */
function AccountUsage({ accountId, accounts, cold }: { accountId: string | null; accounts: readonly AccountView[]; cold: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [wrap, pop]);
  const style = useFloating(wrap, open, 420, 280);
  const a = accounts.find((x) => x.id === accountId) ?? null;
  const toAccounts = hrefOf({ page: "accounts", sub: "accounts" });
  if (!a) return <AccountChip accountId={accountId} accounts={accounts} cold={cold} onClick={() => (location.hash = toAccounts)} />;
  const now = Date.now();
  const outstanding = outstandingOf(a.claims);
  const windows = sortWindows(a.usage.windows);
  return (
    <span className="sx-usage-wrap" ref={wrap}>
      <AccountChip accountId={accountId} accounts={accounts} cold={cold} onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div className="sx-usage" ref={pop} style={style} role="group" aria-label={`Usage of ${a.label}`} onClick={(e) => e.stopPropagation()}>
          <div className="sx-usage-head">
            <strong>{a.label}</strong>
            {a.plan ? <span className="muted">{a.plan}</span> : null}
          </div>
          {windows.length === 0 ? (
            <div className="faint">{a.usage.source === "none" ? "This provider reports no usage." : "No usage read yet."}</div>
          ) : (
            windows.map((w) => <UsageBar key={w.id} window={w} now={now} outstanding={w.kind === "weekly" && !w.scope ? outstanding : 0} />)
          )}
          {a.usage.stale ? (
            <div className="sx-usage-stale">
              <Icon.alert size={12} /> {a.usage.stale}
            </div>
          ) : null}
          <div className="sx-usage-foot">
            <span className="faint">{a.usage.at ? `as of ${ago(a.usage.at)}` : ""}</span>
            <a href={toAccounts}>All accounts</a>
          </div>
        </div>
      ) : null}
    </span>
  );
}

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
  const subagents = runningSubagents(session, state.sessions);
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home).concat(state.sessions.map((s) => s.cwd))), [state.accounts, state.sessions]);
  // openPrs (src/core/prs.ts) matched it by branch; the newest-updated one wins if there are several.
  const pr = state.prs.find((p) => p.sessionId === session.id) ?? null;
  const links = useMemo(() => buildSessionIndex(state.sessions), [state.sessions]);
  const linkCtx = useMemo(() => ({ index: links, self: session.id }), [links, session.id]);
  const prBase = useMemo(() => prBaseFor(session, state), [session, state]);
  const flashRow = useRef<((row: number) => void) | null>(null);
  const [termScrolled, setTermScrolled] = useState(0);
  const family = useFamilyOf(session, state.sessions, tab);
  // The list beside the session shows the family as a tree; a phone has no room for it.
  const narrow = useIsNarrow();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Opening a session — from the list, Ctrl+Tab, a link — and coming back to
  // the window put the cursor in its box, ready to type. Not on a phone,
  // where it would put the keyboard up over what you came to read.
  useEffect(() => {
    if (narrow) return;
    composerRef.current?.focus({ preventScroll: true });
    const onFocus = () => {
      if (document.activeElement === document.body) composerRef.current?.focus({ preventScroll: true });
    };
    addEventListener("focus", onFocus);
    return () => removeEventListener("focus", onFocus);
  }, [session.id, narrow]);
  const skills = useMemo(
    () => skillsFor(state.skills, session.provider, repoOfSession(state.repos, session)),
    [state.skills, state.repos, session.provider, session.repoRoot, session.cwd],
  );

  // What it runs as and on, and what it has spent.
  const sysbarSlot = useSysbarSlot();
  const phone = useIsPhone();
  // The bar is one line beside the machine's figures: there the context is a
  // percentage, the cache reads are in the tooltip, and the account chip says
  // the provider, so a Claude model is "opus-5-5".
  const inBar = !!sysbarSlot && !phone;
  const facts = (
    <div className="sx-facts">
      <span className="fact">
        <AccountUsage accountId={session.accountId} accounts={state.accounts} cold={session.cold} />
      </span>
      <span className="fact mono fact-cwd" title={session.cwd}>
        <Icon.folder size={12} />
        <span className="fact-cwd-text">
          <span dir="ltr">{tildify(session.cwd, home)}</span>
        </span>
      </span>
      {session.branch ? (
        <span className="fact mono" title={session.cwd}>
          <Icon.branch size={12} /> {session.branch}
        </span>
      ) : null}
      {session.model ? (
        <span className="fact mono" title={session.model}>
          {inBar ? session.model.replace(/^claude-/, "") : session.model}
          {session.effort ? <span className="muted"> · {session.effort}</span> : null}
        </span>
      ) : null}
      <span className="fact">
        <ContextBar used={session.contextUsed} limit={session.contextLimit} wide={!inBar} />
      </span>
      <span
        className="fact"
        title={`input ${session.tokens.input.toLocaleString()} · output ${session.tokens.output.toLocaleString()} · cache read ${session.tokens.cacheRead.toLocaleString()} · cache write ${session.tokens.cacheWrite.toLocaleString()}\nCost is what these tokens would cost at API prices — the common unit usage is apportioned in.\nStarted ${new Date(session.startedAt).toLocaleString()}`}
      >
        {fmtTokens(session.tokens.input + session.tokens.output)} tok · {inBar ? null : <>{fmtTokens(session.tokens.cacheRead)} cached · </>}
        <span className="muted">≈{fmtCost(session.tokens.costEquiv)}</span>
      </span>
      {pr && (
        <a className="fact" href={pr.url} target="_blank" rel="noreferrer">
          <Icon.prs size={12} /> #{pr.number}
          {pr.isDraft ? " (draft)" : ""}
        </a>
      )}
    </div>
  );

  // Pin and bookmark: in the tabs' row on a computer, beside the name on a phone.
  const marks = (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={session.pinOrder !== null ? PinOn : Icon.pin}
        className="sx-mark"
        aria-pressed={session.pinOrder !== null}
        aria-label={session.pinOrder !== null ? "Unpin" : "Pin to the top of the list"}
        title={session.pinOrder !== null ? "Unpin it from the top of the list" : "Pin it to the top of the list, open or closed; drag pinned sessions to reorder them"}
        onClick={() => togglePin(session, state.sessions)}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={session.bookmarkedAt !== null ? BookmarkOn : Icon.bookmark}
        className="sx-mark"
        aria-pressed={session.bookmarkedAt !== null}
        aria-label={session.bookmarkedAt !== null ? "Remove bookmark" : "Bookmark"}
        title={session.bookmarkedAt !== null ? "Remove it from the bookmarks" : "Bookmark it: the bookmarks menu beside the list's sort finds it, open or closed"}
        onClick={() => toggleBookmark(session)}
      />
    </>
  );

  return (
    <div data-nav-region="detail" tabIndex={-1} aria-label="Session" className="sv-main" onClick={(e) => {
      if (e.defaultPrevented || e.button !== 0 || e.detail > 1 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target as Element;
      if (target.closest('a, button, input, textarea, select, label, summary, audio, video, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="tab"], [role="dialog"], [tabindex]:not([tabindex="-1"]):not(.tl), .xterm')) return;
      // Selecting transcript text is still reading, and focusing must not
      // scroll the timeline away from the message just clicked.
      if (window.getSelection()?.isCollapsed === false) return;
      composerRef.current?.focus({ preventScroll: true });
    }}>
      {/* No title, ids or status: the list shows which session is open and
          what it is doing. The facts, then the tabs with the actions. */}
      <header className="sx-header">
        {/* A phone shows no list beside the session: name it, and rename it, here.
            On a computer the list's right-click menu renames. */}
        {narrow ? (
          <div className="sx-title-row">
            <TitleEdit session={session} />
            {marks}
          </div>
        ) : null}
        {/* On a computer the facts go in the system bar along the bottom. A
            phone hides that bar in a session, so there they stay here. */}
        {inBar && sysbarSlot ? createPortal(facts, sysbarSlot) : facts}

        {/* A question is the Timeline's last row, and the status says Blocked: no line for it. */}
        {(session.status === "blocked" && !session.question && shownStatus(session) !== "retrying") || error ? (
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
                The Terminal tab shows the prompt.
              </>
            )}
          </div>
        ) : session.status === "blocked" && !session.question ? (
          <div className="sx-attention-line info" role="status">
            <Icon.refresh size={13} /> {session.attention.reason}. Nothing for you to do; the Terminal tab shows the error.
          </div>
        ) : session.status === "waiting" && session.turnError ? (
          <TurnErrorLine session={session} />
        ) : null}

        <div className="sx-tabbar">
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
          <div className="sx-tabbar-actions">
            {narrow ? null : marks}
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
            {session.host === "tmux" || session.host === "external" ? (
              <Button size="sm" icon={Icon.stop} disabled={busy} onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
            ) : null}
            {session.host === "subagent" ? null : session.status === "closed" ? (
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
                onClick={() => (session.status === "running" && subagents.length === 0 ? setConfirmClose(true) : void close())}
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </header>

      <FamilyContext.Provider value={family}>
      {narrow ? <FamilyStrip /> : null}
      <PrBase.Provider value={prBase}>
      <SessionLinks.Provider value={linkCtx}>
      <div className="sv-body" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "terminal" ? (
          session.host === "tmux" ? (
            <div className="sv-split">
              <Suspense fallback={<Empty title="Loading the terminal…" />}>
                <Terminal
                  sessionId={session.id}
                  index={links}
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
      </SessionLinks.Provider>
      </PrBase.Provider>
      </FamilyContext.Provider>

      {/* What it waits on: a tab on the composer, and a list that rises from
          it while you point at the tab. The terminal shows that itself. */}
      <div className="cmp-dock">
        {tab === "terminal" ? null : <WorkStrip session={session} sessions={state.sessions} />}
        {/* Keyed by session: each one keeps its own draft (see drafts.ts),
            rather than one box carrying its text into the next session. */}
        <Composer
          key={session.id}
          session={session}
          accounts={state.accounts}
          skills={skills}
          textareaRef={composerRef}
        />
      </div>

      {confirmClose ? (
        <ConfirmClose
          session={session}
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
              {subagents.length > 0 ? (
                <>
                  {" "}
                  It also stops <SubagentNames session={session} sessions={state.sessions} /> mid-task; answers they have not handed
                  back are lost.
                </>
              ) : null}
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
  if (session.host === "subagent") {
    return (
      <div className="term-transcript">
        <div className="term-transcript-bar">
          <Icon.terminal size={13} />
          <span>
            Run by its parent session&apos;s subagent MCP, so there is no terminal here — this is its transcript. It can be resumed here
            once it stops.
          </span>
        </div>
        <Suspense fallback={<Empty title="Loading the transcript…" />}>
          <Timeline session={session} />
        </Suspense>
      </div>
    );
  }
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

/** A turn the provider ended — the output cap cut its reply off, or an API
 *  error stopped it — so it sits at the prompt without meaning to. Retryable
 *  kinds get the button that sends the message the CLI asks for; a fatal one
 *  only says what is wrong, since a retry cannot fix it. When the fleet will
 *  retry it by itself it says when; the button, or anything you send, does it
 *  now instead. */
function TurnErrorLine({ session }: { session: SessionRow }) {
  const { run, busy, error, clear } = useAction();
  const now = useNow(15_000);
  const err = session.turnError!;
  const auto = session.autoResume;
  const retryable = err.kind !== "fatal";
  const nudge =
    err.kind === "output-cap"
      ? "[agentbox: your last reply was cut off by the output token limit. Continue where you left off.]"
      : "[agentbox: your turn stopped on an error; this message retries it. Carry on where you left off.]";
  const said =
    err.kind === "output-cap"
      ? "Its reply was cut off by the output token limit"
      : err.kind === "transient"
        ? "Stopped on an error"
        : "Stopped on an error a retry cannot fix";
  return (
    <div className={`sx-attention-line warn${auto ? " info" : ""}`} role="status">
      {auto ? <Icon.refresh size={13} /> : <Icon.alert size={13} />}
      <span>
        {said}
        {session.lastActivityAt ? ` ${ago(err.at || session.lastActivityAt)}` : ""}
        {err.kind !== "output-cap" ? `: ${err.detail}${auto && !/[.!?]$/.test(err.detail) ? "." : ""}` : " — it stopped without meaning to."}
        {auto ? <AutoResumeNote auto={auto} now={now} what={err.kind === "output-cap" ? "continues it" : "retries it"} /> : null}
        {error ? (
          <>
            {" "}
            {error}{" "}
            <button className="linkish" onClick={clear}>
              dismiss
            </button>
          </>
        ) : null}
      </span>
      {retryable ? (
        <Button size="sm" variant="ghost" icon={Icon.play} loading={busy} onClick={() => void run(() => api.send(session.id, nudge))}>
          {auto ? (err.kind === "output-cap" ? "Continue now" : "Retry now") : err.kind === "output-cap" ? "Continue" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

/** " agentbox retries it at 1:51 AM (in 4m), try 2 of 3 — or send it something yourself." */
export function AutoResumeNote({ auto, now, what }: { auto: NonNullable<SessionRow["autoResume"]>; now: number; what: string }) {
  const nth = auto.of === 1 ? "" : auto.of === null ? (auto.attempt > 1 ? `, try ${auto.attempt}` : "") : `, try ${auto.attempt} of ${auto.of}`;
  return (
    <span className="sx-auto-resume">
      {" "}
      agentbox {what} {fmtRetryAt(auto.at, now)}
      {nth} — or send it something yourself.
    </span>
  );
}
