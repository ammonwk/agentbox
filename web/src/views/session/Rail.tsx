/** The session list beside whatever session is open: search, a sort, the
 *  Active and Inactive tabs, and one row per session. It is the whole
 *  Sessions page's list; on a narrow screen with nothing open it is the page. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { AppState, ProviderId, Schedule } from "../../../../src/core/types";
import { ProviderBadge, ShapeMark, StatusDot } from "../../bits";
import { Icon, RelativeTime, Spinner } from "../../components";
import {
  descendantsOf,
  EMPTY_FILTER,
  projectOf,
  repoKey,
  repoShapes,
  SORT_LABEL,
  sortTime,
  sentTip,
  shownStatus,
  titleOf,
  usualProvider,
  type BoardFilter,
  type Nested,
  type RailView,
  type Section,
  type SessionRow,
  type Shape,
  type SortKey,
} from "../../lib/board";
import { baseName, fmtBytes } from "../../lib/format";
import { openingTab } from "../../lib/phone";
import { api, useMetrics } from "../../api";
import { hrefOf } from "../../route";
import { useDismiss } from "../newsession/popover";
import { reportFailure, useClosing } from "./closing";
import { movePin, toggleBookmark, togglePin } from "./pins";
import { ScheduledRow } from "./Scheduled";

// ------------------------------------------------------------------- state

const SORT_KEY = "agentbox.sort";
const SORTS: readonly SortKey[] = ["mine", "all", "status", "repo"];
const VIEW_KEY = "agentbox.railView";

function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.includes(v as SortKey) ? (v as SortKey) : "mine";
  } catch {
    return "mine";
  }
}

function readView(): RailView {
  try {
    return localStorage.getItem(VIEW_KEY) === "inactive" ? "inactive" : "active";
  } catch {
    return "active";
  }
}

/** Survive a trip to Accounts and back: a list that forgets its search every
 *  time you look away is a list you stop searching. The sort and the
 *  Active/Inactive tab are preferences, so they outlive the browser tab too. */
let rememberedFilter: BoardFilter = EMPTY_FILTER;
/** Parents kept expanded after selection and hover move elsewhere. */
let openParents: ReadonlySet<string> = new Set();
/** How far down the list was scrolled. On a phone the list is not mounted
 *  while a session is open, and going back to it should find it where it was. */
let railTop = 0;

export function useListState() {
  const [filter, setFilterState] = useState<BoardFilter>(rememberedFilter);
  const [sort, setSortState] = useState<SortKey>(readSort);
  const [view, setViewState] = useState<RailView>(readView);
  const [open, setOpenState] = useState(openParents);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  return {
    filter,
    setFilter: (f: BoardFilter) => {
      rememberedFilter = f;
      setFilterState(f);
    },
    sort,
    setSort: (s: SortKey) => {
      try {
        localStorage.setItem(SORT_KEY, s);
      } catch {
        /* private mode: this tab remembers it */
      }
      setSortState(s);
    },
    view,
    setView: (v: RailView) => {
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        /* private mode: this tab remembers it */
      }
      setViewState(v);
    },
    hovered,
    setHovered,
    focused,
    setFocused,
    open,
    setOpen: (id: string, on: boolean) => {
      const next = new Set(openParents);
      if (on) next.add(id);
      else next.delete(id);
      openParents = next;
      setOpenState(next);
    },
  };
}

export type ListState = ReturnType<typeof useListState>;

// -------------------------------------------------------------------- rail

export function Rail({
  sections,
  counts,
  state,
  current,
  forcedOpen,
  list,
  onOpenFirst,
  onClose,
  scheduled,
  onCancelSchedule,
}: {
  /** The sections of the tab `list.view` names. */
  sections: Section<Nested<SessionRow>>[];
  /** Top-level rows in each tab, after the search. */
  counts: Record<RailView, number>;
  state: AppState;
  current: string | null;
  /** Selected, hovered and focused sessions and their ancestors stay expanded. */
  forcedOpen: ReadonlySet<string>;
  list: ListState;
  onOpenFirst: () => void;
  onClose: (s: SessionRow) => void;
  /** One-time scheduled sessions, soonest first. */
  scheduled: Schedule[];
  onCancelSchedule: (sc: Schedule) => void;
}) {
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const usual = useMemo(() => usualProvider(rows), [rows]);
  const shapes = useMemo(() => repoShapes(state.sessions), [state.sessions]);
  // Changes whenever something is closed or reopened, so an open closed list refetches.
  const closedStamp = useMemo(
    () => state.closedStamp ?? state.sessions.reduce((n, s) => (s.status === "closed" ? n + 1 + (s.closedAt ?? 0) : n), 0),
    [state.closedStamp, state.sessions],
  );
  const { filter, setFilter, sort, view } = list;
  const cur = useRef<HTMLAnchorElement>(null);
  // Before paint, and before the effect below brings the open session into view.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = railTop;
  }, []);
  // A block body, not `() => el.scrollIntoView()`: newer browsers return a
  // Promise from scrollIntoView, and React calls whatever an effect returns as
  // its cleanup — `destroy is not a function` took the whole app down.
  useEffect(() => {
    cur.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // Dragging a row: onto another row puts it under that one; anywhere else in
  // the list, when it is under one now, takes it out to the top level. It
  // cannot go under itself or a session it started (a loop), and a subagent
  // stays with the session whose MCP runs it.
  //
  // A pinned session dragged among the pinned is put in a new place there
  // instead: before the row it is dropped on, or after it, by which half.
  const [drag, setDrag] = useState<{ s: SessionRow; banned: ReadonlySet<string>; pin: boolean } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pos, setPos] = useState<DropPos | null>(null);
  const endDrag = () => {
    setDrag(null);
    setOver(null);
    setPos(null);
  };
  const move = (s: SessionRow, parent: string | null) => {
    endDrag();
    if (parent) list.setOpen(parent, true);
    api.patchSession(s.id, { parent }).catch((e: Error) => reportFailure(s.id, titleOf(s), "move", e.message));
  };
  const toRoot = !drag?.pin && drag?.s.parent != null;
  const dropping: DropProps = {
    start: (s, pin) => setDrag({ s, banned: new Set([s.id, ...descendantsOf(s, state.sessions).map((c) => c.id)]), pin }),
    end: endDrag,
    can: (s, pin) =>
      !!drag && (drag.pin ? pin && s.id !== drag.s.id : !drag.banned.has(s.id) && drag.s.parent !== s.id),
    reordering: !!drag?.pin,
    over: (id, p = null) => {
      setOver(id);
      setPos(p);
    },
    drop: (s, p) => {
      if (!drag) return;
      if (!drag.pin) return move(drag.s, s.id);
      endDrag();
      movePin(drag.s, s, p, state.sessions);
    },
  };

  // Right-click on a row: pin it, bookmark it.
  const [menu, setMenu] = useState<{ id: string; fallback: SessionRow; x: number; y: number } | null>(null);
  const onMenu = (s: SessionRow, x: number, y: number) => setMenu({ id: s.id, fallback: s, x, y });

  // Tree expansion stays local. At the root ← reaches application navigation;
  // → on an expanded parent or leaf opens the conversation.
  const onArrow = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing || !e.key.startsWith("Arrow")) return;
    const t = e.target as HTMLElement;
    const nav = e.currentTarget;
    const all = [...nav.querySelectorAll<HTMLElement>(".rail-row")];
    const search = nav.querySelector<HTMLElement>("[data-search]");
    if (t === search) {
      if (e.key !== "ArrowDown") return;
      (nav.querySelector<HTMLElement>('.rail-row[aria-current="page"]') ?? all[0])?.focus();
    } else if (t.classList.contains("rail-row")) {
      const i = all.indexOf(t);
      const s = rows.find((r) => r.id === t.dataset.id);
      const unfolded = !!s && (list.open.has(s.id) || forcedOpen.has(s.id));
      if (e.key === "ArrowDown") all[i + 1]?.focus();
      else if (e.key === "ArrowUp") (all[i - 1] ?? search)?.focus();
      else if (e.key === "ArrowRight" && s?.kids && !unfolded) list.setOpen(s.id, true);
      else if (e.key === "ArrowLeft" && s?.kids && unfolded && !forcedOpen.has(s.id)) list.setOpen(s.id, false);
      else if (e.key === "ArrowLeft" && s?.parent) nav.querySelector<HTMLElement>(`.rail-row[data-id="${CSS.escape(s.parent)}"]`)?.focus();
      else return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <nav className="rail" data-nav-region="list" tabIndex={-1} aria-label="Sessions" onKeyDown={onArrow}>
      <div className="rail-top">
        <label className="rail-search">
          <Icon.search size={13} />
          <span className="sr-only">Search sessions</span>
          <input
            data-search
            value={filter.query}
            placeholder="Search"
            spellCheck={false}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onOpenFirst();
              } else if (e.key === "Escape") {
                if (filter.query) {
                  e.stopPropagation();
                  setFilter({ ...filter, query: "" });
                } else (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <BookmarksMenu sessions={state.sessions} current={current} shapes={shapes} />
        <SortMenu list={list} />
      </div>
      <div className="rail-views" role="tablist" aria-label="Which sessions">
        {(["active", "inactive"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            className="rail-view"
            aria-selected={view === v}
            title={v === "active" ? "Running, or did something in the last 3 hours" : "Nothing in the last 3 hours"}
            onClick={() => list.setView(v)}
          >
            {v === "active" ? "Active" : "Inactive"} <span>{counts[v]}</span>
          </button>
        ))}
      </div>

      <div
        className="rail-scroll"
        ref={scroller}
        onScroll={(e) => (railTop = e.currentTarget.scrollTop)}
        onMouseOver={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>(".rail-row");
          list.setHovered(row?.dataset.id ?? null);
        }}
        onMouseLeave={() => list.setHovered(null)}
        onFocus={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>(".rail-row");
          list.setFocused(row?.dataset.id ?? null);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) list.setFocused(null);
        }}
        data-drop={over === "root" || undefined}
        onDragOver={(e) => {
          if (!drag || !toRoot) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver("root");
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(e) => {
          if (!drag || !toRoot) return;
          e.preventDefault();
          move(drag.s, null);
        }}
      >
        <CloseFailure />
        {view === "active" && scheduled.length ? (
          <div className="rail-sec" data-kind="scheduled">
            <div className="rail-label">
              Scheduled <span>{scheduled.length}</span>
            </div>
            {scheduled.map((sc) => (
              <ScheduledRow key={sc.id} sc={sc} current={sc.id === current} onCancel={onCancelSchedule} />
            ))}
          </div>
        ) : null}
        {rows.length === 0 && (view === "inactive" || scheduled.length === 0) ? (
          <p className="rail-none">
            {filter.query ? `Nothing ${view} matches.` : state.sessions.length ? `Nothing ${view}.` : "No sessions yet."}
          </p>
        ) : null}
        {sections.map((sec) => (
          <div key={sec.key} className="rail-sec" data-kind={sec.kind}>
            {sec.label ? (
              <div className="rail-label" title={sec.key === "pinned" ? "Drag a pinned session to reorder them" : sort === "repo" ? sec.key : undefined}>
                {sec.key === "pinned" ? <Icon.pin size={11} /> : null}
                {sort === "repo" && shapes.has(sec.key) ? <ShapeMark shape={shapes.get(sec.key)!} /> : null}
                {sec.label} <span>{sec.rows.filter((s) => s.depth === 0).length}</span>
              </div>
            ) : null}
            {sec.rows.map((s) => (
              <Row
                key={s.id}
                s={s}
                current={s.id === current}
                refFn={s.id === current ? cur : undefined}
                usual={usual}
                sort={sort}
                open={list.open.has(s.id) || forcedOpen.has(s.id)}
                held={list.open.has(s.id)}
                onToggle={() => {
                  list.setOpen(s.id, !list.open.has(s.id));
                }}
                onClose={onClose}
                onMenu={onMenu}
                dnd={dropping}
                pinned={sec.key === "pinned" && s.depth === 0}
                target={over === s.id ? (drag?.pin ? pos : "under") : null}
              />
            ))}
          </div>
        ))}
        {view === "inactive" ? <ClosedList query={filter.query} current={current} stamp={closedStamp} onMenu={onMenu} /> : null}
      </div>
      {drag ? (
        <div className="rail-drophint" data-active={over === "root" || undefined} aria-hidden="true">
          {drag.pin
            ? "Drop on a pinned session to put it before or after that one"
            : toRoot
              ? "Drop on a session to put it under that one, or anywhere else for the top level"
              : "Drop on a session to put it under that one"}
        </div>
      ) : null}
      {menu ? (
        <RowMenu
          s={state.sessions.find((x) => x.id === menu.id) ?? menu.fallback}
          sessions={state.sessions}
          x={menu.x}
          y={menu.y}
          onDone={() => setMenu(null)}
        />
      ) : null}
    </nav>
  );
}

type DropPos = "before" | "after";

/** What a row needs to be dragged, and dropped on. */
interface DropProps {
  /** `pin`: it is a pinned row, dragged to a new place among the pinned. */
  start: (s: SessionRow, pin: boolean) => void;
  end: () => void;
  /** Whether the row being dragged may go under `s`, or, reordering the
   *  pinned, beside it; `pin` says `s` is a pinned row. */
  can: (s: SessionRow, pin: boolean) => boolean;
  /** The drag is one among the pinned: a drop goes before or after. */
  reordering: boolean;
  over: (id: string | null, pos?: DropPos | null) => void;
  drop: (s: SessionRow, pos: DropPos) => void;
}

/** Which half of the row the pointer is over. */
const halfOf = (e: { clientY: number; currentTarget: Element }): DropPos => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
};

function Row({
  s,
  current,
  refFn,
  usual,
  sort,
  open,
  held,
  onToggle,
  onClose,
  onMenu,
  dnd,
  pinned,
  target,
}: {
  s: Nested<SessionRow>;
  current: boolean;
  refFn?: Ref<HTMLAnchorElement>;
  usual: ProviderId | null;
  sort: SortKey;
  open: boolean;
  /** You expanded it, rather than its being open because a row under it is. */
  held: boolean;
  onToggle: () => void;
  onClose: (s: SessionRow) => void;
  onMenu: (s: SessionRow, x: number, y: number) => void;
  dnd: DropProps;
  /** A top-level row of the Pinned section: dragging it reorders the pinned. */
  pinned: boolean;
  /** A dragged row is over this one, and may go under it, or before or after it. */
  target: "under" | DropPos | null;
}) {
  const said = snippetOf(s);
  const movable = pinned || s.host !== "subagent";
  const row = (
    <a
      ref={refFn}
      className="rail-row"
      href={hrefOf({ page: "session", id: s.id, tab: openingTab(s) })}
      aria-current={current ? "page" : undefined}
      data-id={s.id}
      data-nav-item
      data-nav-id={`session:${s.id}`}
      data-status={s.status}
      data-depth={s.depth || undefined}
      style={s.depth ? ({ "--depth": s.depth } as CSSProperties) : undefined}
      title={[namedTitle(s), said ? said.slice(0, 240) : null].filter(Boolean).join("\n\n")}
      draggable={movable}
      data-drop={target ?? undefined}
      onDragStart={(e) => {
        if (!movable) return e.preventDefault();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-agentbox-session", s.id);
        dnd.start(s, pinned);
      }}
      onDragEnd={dnd.end}
      onDragOver={(e) => {
        // A row is never the list's top-level target, even one it cannot go under.
        e.stopPropagation();
        if (!dnd.can(s, pinned)) return dnd.over(null);
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        dnd.over(s.id, dnd.reordering ? halfOf(e) : null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dnd.can(s, pinned)) dnd.drop(s, halfOf(e));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(s, e.clientX, e.clientY);
      }}
    >
      <span className="rail-text">
        <RowTitle s={s} />
        {said ? <span className={`rail-snippet${s.attention.kind === "blocked" ? " blocked" : ""}`}>{said}</span> : null}
      </span>
      {s.kids ? (
        <button
          type="button"
          className="rail-kids"
          aria-expanded={open}
          title={`${held ? "Stop keeping" : "Keep"} the ${s.kids === 1 ? "session" : `${s.kids} sessions`} it started expanded after leaving this session (← →)`}
          onClick={(e) => {
            // Keep expansion separate from opening the session.
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }}
        >
          {open ? <Icon.chevronDown size={10} /> : <Icon.chevronRight size={10} />}
          {s.kids}
        </button>
      ) : null}
      {s.provider !== usual ? <ProviderBadge provider={s.provider} short /> : null}
      <span className="rail-when">
        <RelativeTime ts={sortTime(s, sort)} short title={sentTip(s)} />
      </span>
      <RowLoad id={s.id} />
      {s.host === "subagent" || s.status === "closed" ? null : <CloseX s={s} onClose={onClose} />}
      <RowState s={s} />
    </a>
  );
  return s.depth ? <div className="rail-reveal"><div>{row}</div></div> : row;
}

/**
 * What it is doing, as one icon at the row's right end: a spinner while it
 * works, a pulse while it waits on work it left running, a clock when it is
 * your turn, and an alert while it waits for your approval or your answer, or
 * when its turn failed. Nothing once it is stopped. A click copies its id.
 */
function RowState({ s }: { s: SessionRow }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const st = stateOf(s);
  // An empty column keeps the times in line.
  if (!st) return <span className="rail-state" />;
  return (
    <button
      type="button"
      className="rail-state"
      data-state={st.kind}
      aria-label={`${st.label}. Copy ${s.id}`}
      title={`${st.label}\nClick to copy ${s.id}`}
      onClick={(e) => {
        // Inside the row's link: copy, do not open.
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(s.id).then(() => setCopied(true));
      }}
    >
      {copied ? <Icon.check size={13} /> : st.icon}
    </button>
  );
}

function stateOf(s: SessionRow): { kind: string; label: string; icon: ReactNode } | null {
  // An error agentbox retries by itself is work, not something for you to fix.
  if (shownStatus(s) === "retrying") return { kind: "working", label: "Retrying: agentbox retries it by itself", icon: <Spinner size={12} /> };
  if (s.status === "blocked") {
    return { kind: "approval", label: s.question ? "Asking you a question" : "Waiting for your approval", icon: <Icon.alert size={13} /> };
  }
  if (s.status === "running") {
    return s.background
      ? { kind: "background", label: "Its turn is over; it waits on work it left running", icon: <span className="rail-pulse" /> }
      : { kind: "working", label: "Working", icon: <Spinner size={12} /> };
  }
  if (s.status !== "waiting") return null;
  if (s.turnError) return { kind: "error", label: `Its turn failed: ${s.turnError.detail}`, icon: <Icon.alert size={13} /> };
  return { kind: "waiting", label: s.parkedAt ? "Your turn (parked: a message resumes it)" : "Your turn", icon: <Icon.clock size={13} /> };
}

/**
 * The ✕ that takes the time's place under the pointer: Close, straight from
 * the list. One mid-turn asks first — a second click within a few seconds —
 * since closing stops it and cuts the turn short.
 */
function CloseX({ s, onClose }: { s: SessionRow; onClose: (s: SessionRow) => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className="rail-x"
      data-armed={armed || undefined}
      aria-label={`Close ${titleOf(s)}`}
      title={armed ? "It is mid-turn: click again to stop and close it" : "Close: stop it and take it off the list"}
      onClick={(e) => {
        // Inside the row's link: close, do not open.
        e.preventDefault();
        e.stopPropagation();
        if (s.status === "running" && !armed) return setArmed(true);
        onClose(s);
      }}
    >
      {armed ? "Stop?" : <Icon.x size={12} />}
    </button>
  );
}

/**
 * What its processes hold now: CPU over memory. A subscription of its own, so
 * a metrics frame (every 2s) re-renders these figures and not the list. A
 * session with no process has none.
 */
function RowLoad({ id }: { id: string }) {
  const load = useMetrics().metrics?.load[id];
  if (!load) return <span className="rail-load" />;
  const cpu = load.cpuPct < 1 ? "0%" : `${Math.round(load.cpuPct)}%`;
  const gb = load.memBytes / 2 ** 30;
  const mem = gb >= 1 ? `${gb.toFixed(1)}G` : `${Math.round(load.memBytes / 2 ** 20)}M`;
  return (
    <span
      className="rail-load"
      data-idle={load.cpuPct < 1 || undefined}
      data-hot={load.cpuPct >= 80 || undefined}
      title={`CPU ${cpu} (100% is one core) · memory ${fmtBytes(load.memBytes)}${load.memKind === "rss" ? " (RSS, overstated until the next measure)" : ""} · ${load.procs} process${load.procs === 1 ? "" : "es"}`}
    >
      <span>{cpu}</span>
      <span>{mem}</span>
    </span>
  );
}

/** A close the server refused: the row is back, and this says why. Or what a
 *  close left open: the sessions it started that hold work stay on the list. */
function CloseFailure() {
  const { failure, dismiss } = useClosing();
  if (!failure) return null;
  return (
    <p className="rail-err" role="alert">
      {failure.left ? `Closed “${failure.title}”: ` : `Could not ${failure.verb ?? "close"} “${failure.title}”: `}
      {failure.message}{" "}
      <button type="button" className="linkish" onClick={dismiss}>
        dismiss
      </button>
    </p>
  );
}

/** The session's name, after the project it works on, in quieter type. */
function RowTitle({ s }: { s: SessionRow }) {
  const project = projectOf(s);
  return (
    <span className="rail-title">
      {project ? <span className="rail-proj">{project}</span> : null}
      {titleOf(s)}
    </span>
  );
}

const namedTitle = (s: SessionRow) => [projectOf(s), titleOf(s)].filter(Boolean).join(" · ");

/** What it last said, what it is asking, or that its answer is waiting. */
function snippetOf(s: SessionRow): string {
  if (s.backgroundWork) return `Running ${s.backgroundWork}`;
  const said =
    s.status === "blocked" || (s.status === "waiting" && (s.subagent?.answerWaiting || s.turnError))
      ? s.attention.reason
      : s.lastMessage ?? s.lastPrompt ?? s.firstPrompt;
  return said ? said.replace(/\s+/g, " ").trim() : "";
}

/** The sort: one quiet button. */
function SortMenu({ list }: { list: ListState }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [wrap]);
  const { sort, setSort } = list;
  return (
    <div className="rail-sort" ref={wrap}>
      <button
        type="button"
        className="rail-sort-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort: ${SORT_LABEL[sort]}`}
        title={`Sorted by ${SORT_LABEL[sort].toLowerCase()}`}
        onClick={() => setOpen(!open)}
      >
        <Icon.sort size={14} />
      </button>
      {open ? (
        <div className="rail-menu" role="menu" aria-label="Sort sessions">
          <div className="rail-menu-label">Sort by</div>
          {SORTS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={sort === k}
              onClick={() => {
                setSort(k);
                setOpen(false);
              }}
            >
              <span className="rail-menu-check">{sort === k ? <Icon.check size={12} /> : null}</span>
              {SORT_LABEL[k]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A row's right-click menu: pin it, bookmark it. */
function RowMenu({ s, sessions, x, y, onDone }: { s: SessionRow; sessions: readonly SessionRow[]; x: number; y: number; onDone: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(true, onDone, [wrap]);
  // Kept on screen: a right-click near the foot or the edge opens it upward or leftward.
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    wrap.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const pick = (act: () => void) => () => {
    act();
    onDone();
  };
  // Rename turns the menu into the name's field; clearing it falls back to the derived title.
  const [draft, setDraft] = useState<string | null>(null);
  const rename = (next: string) => {
    onDone();
    if (next !== (s.label ?? titleOf(s))) api.patchSession(s.id, { label: next || null }).catch((e: Error) => reportFailure(s.id, titleOf(s), "rename", e.message));
  };
  if (draft !== null) {
    return (
      <div ref={wrap} className="rail-menu rail-rowmenu" style={{ position: "fixed", ...at }}>
        <input
          className="rail-rename"
          aria-label="Session name"
          autoFocus
          value={draft}
          placeholder={s.title || "Name"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              rename(draft.trim());
            } else if (e.key === "Escape") {
              e.stopPropagation();
              onDone();
            }
          }}
        />
      </div>
    );
  }
  return (
    <div ref={wrap} className="rail-menu rail-rowmenu" role="menu" aria-label={titleOf(s)} style={{ position: "fixed", ...at }}>
      <div className="rail-menu-label">{titleOf(s)}</div>
      <button type="button" role="menuitem" onClick={() => setDraft(s.label ?? titleOf(s))}>
        <span className="rail-menu-check">
          <Icon.edit size={12} />
        </span>
        Rename
      </button>
      <button type="button" role="menuitem" onClick={pick(() => togglePin(s, sessions))}>
        <span className="rail-menu-check">
          <Icon.pin size={12} />
        </span>
        {s.pinOrder !== null ? "Unpin" : "Pin to top"}
      </button>
      <button type="button" role="menuitem" onClick={pick(() => toggleBookmark(s))}>
        <span className="rail-menu-check">
          <Icon.bookmark size={12} />
        </span>
        {s.bookmarkedAt !== null ? "Remove bookmark" : "Bookmark"}
      </button>
    </div>
  );
}

/** The bookmarks, beside the sort: open or closed, running or not, the most
 *  recently bookmarked first, whatever the search says. */
function BookmarksMenu({ sessions, current, shapes }: { sessions: readonly SessionRow[]; current: string | null; shapes: Map<string, Shape> }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [wrap]);
  const marks = useMemo(
    () => sessions.filter((s) => s.bookmarkedAt !== null).sort((a, b) => b.bookmarkedAt! - a.bookmarkedAt!),
    [sessions],
  );
  // ↑/↓ walk the bookmarks, as they do the list.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...e.currentTarget.querySelectorAll<HTMLElement>("a[role=menuitem]")];
    if (!links.length) return;
    e.preventDefault();
    const i = links.indexOf(document.activeElement as HTMLElement);
    links[e.key === "ArrowDown" ? (i + 1) % links.length : (i <= 0 ? links.length : i) - 1].focus();
  };
  return (
    <div className="rail-sort rail-bm-wrap" ref={wrap}>
      <button
        type="button"
        className="rail-sort-btn"
        data-n={marks.length || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Bookmarks (${marks.length})`}
        title={marks.length ? `Bookmarks (${marks.length})` : "Bookmarks"}
        onClick={() => setOpen(!open)}
      >
        <Icon.bookmark size={14} />
        {marks.length ? <span className="rail-bm-n">{marks.length}</span> : null}
      </button>
      {open ? (
        <div className="rail-menu rail-bm" role="menu" aria-label="Bookmarked sessions" onKeyDown={onKey}>
          <div className="rail-menu-label">
            Bookmarks{marks.length ? <span className="rail-menu-n">{marks.length}</span> : null}
          </div>
          {marks.length === 0 ? (
            <p className="rail-bm-none">
              None yet. Bookmark a session with <Icon.bookmark size={11} /> in its header, or right-click it in the list. Bookmarks stay here after the session is
              closed.
            </p>
          ) : (
            marks.map((s) => (
              <div key={s.id} className="rail-bm-row" data-status={s.status} aria-current={s.id === current ? "page" : undefined}>
                <a role="menuitem" href={hrefOf({ page: "session", id: s.id, tab: openingTab(s) })} title={titleOf(s)} onClick={() => setOpen(false)}>
                  <StatusDot status={shownStatus(s)} shape={shapes.get(repoKey(s))} repo={baseName(repoKey(s))} />
                  <span className="rail-title">{titleOf(s)}</span>
                  <span className="rail-when">
                    {s.status === "closed" ? "closed " : null}
                    <RelativeTime ts={s.status === "closed" && s.closedAt ? s.closedAt : s.lastActivityAt} short />
                  </span>
                </a>
                <button type="button" className="rail-x" aria-label={`Remove the bookmark from ${titleOf(s)}`} title="Remove the bookmark" onClick={() => toggleBookmark(s)}>
                  <Icon.x size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ closed

const PAGE = 30;
/** Whether See closed is expanded; survives a trip to another page. */
let closedOpen = false;
/** The closed list as it was last shown, so it comes back as long as it was
 *  and the rail's scroll position can be put back inside it. */
let closedShown: { query: string; rows: SessionRow[]; total: number | null } | null = null;
/** Closed sessions fetched so far, by id: the session view falls back to
 *  these for one too old to be in the app state. */
export const closedSessions = new Map<string, SessionRow>();

/**
 * Closed sessions, below the rest, folded until asked for: the most recently
 * closed thirty, then thirty more each time the end scrolls into view. From
 * the server, so every session ever closed can be found and reopened, not
 * only those still inside the board's window.
 */
function ClosedList({
  query,
  current,
  stamp,
  onMenu,
}: {
  query: string;
  current: string | null;
  stamp: number;
  onMenu: (s: SessionRow, x: number, y: number) => void;
}) {
  const [open, setOpenState] = useState(closedOpen);
  const shown = closedShown?.query === query ? closedShown : null;
  const [rows, setRows] = useState<SessionRow[]>(shown?.rows ?? []);
  const [total, setTotal] = useState<number | null>(shown?.total ?? null);
  // The first refresh fetches as many as were shown, not just the first page.
  const keep = useRef(shown?.rows.length ?? 0);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  const gen = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  const load = async (offset: number, limit = PAGE) => {
    if (loading.current) return;
    loading.current = true;
    const mine = gen.current;
    try {
      const page = await api.closed(query.trim(), offset, limit);
      if (mine !== gen.current) return;
      for (const s of page.sessions) closedSessions.set(s.id, s);
      setRows((r) => (offset === 0 ? page.sessions : [...r, ...page.sessions]));
      setTotal(page.total);
      setError(null);
    } catch (e) {
      if (mine === gen.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      loading.current = false;
    }
  };

  // From the top whenever it opens, the search changes, or something is closed or reopened.
  useEffect(() => {
    if (!open) return;
    gen.current++;
    loading.current = false;
    const limit = Math.max(PAGE, keep.current);
    keep.current = 0;
    const t = setTimeout(() => void load(0, limit), query ? 200 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, stamp]);

  // Rows only change through load(), which drops a page fetched for an old search.
  useEffect(() => {
    closedShown = { query, rows, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, total]);

  // The next page when the end of the list comes into view.
  useEffect(() => {
    const el = end.current;
    if (!open || !el || total === null || rows.length >= total) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) void load(rows.length);
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows.length, total]);

  return (
    <div className="rail-closed">
      <button
        type="button"
        className="rail-closed-toggle"
        aria-expanded={open}
        onClick={() => {
          closedOpen = !open;
          setOpenState(!open);
        }}
      >
        {open ? <Icon.chevronDown size={12} /> : <Icon.chevronRight size={12} />}
        See closed
        {open && total !== null ? <span className="rail-menu-n">{total}</span> : null}
      </button>
      {open ? (
        <>
          {rows.map((s) => (
            <a
              key={s.id}
              className="rail-row"
              data-nav-item
              data-nav-id={`session:${s.id}`}
              href={hrefOf({ page: "session", id: s.id, tab: openingTab(s) })}
              aria-current={s.id === current ? "page" : undefined}
              data-status={s.status}
              title={namedTitle(s)}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu(s, e.clientX, e.clientY);
              }}
            >
              <span className="rail-text">
                <RowTitle s={s} />
              </span>
              <span className="rail-when">
                {s.closedAt ? <RelativeTime ts={s.closedAt} short title={`Closed ${new Date(s.closedAt).toLocaleString()}`} /> : null}
              </span>
            </a>
          ))}
          {error ? <p className="rail-none">Could not load closed sessions: {error}</p> : null}
          {total === 0 ? <p className="rail-none">{query ? "No closed session matches." : "Nothing closed yet."}</p> : null}
          <div ref={end} className="rail-closed-end" aria-hidden="true" />
        </>
      ) : null}
    </div>
  );
}
