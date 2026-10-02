/** The session list beside whatever session is open: search, a sort, and one
 *  row per session. It is the whole Sessions page's list; on a narrow screen
 *  with nothing open it is the page. */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import type { AppState, ProviderId, Schedule } from "../../../../src/core/types";
import { ProviderBadge, ShapeMark, StatusDot } from "../../bits";
import { Icon, RelativeTime } from "../../components";
import {
  descendantsOf,
  EMPTY_FILTER,
  repoKey,
  repoShapes,
  SORT_LABEL,
  sortTime,
  sentTip,
  titleOf,
  usualProvider,
  type BoardFilter,
  type Nested,
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
import { ScheduledRow } from "./Scheduled";

// ------------------------------------------------------------------- state

const SORT_KEY = "agentbox.sort";
const SORTS: readonly SortKey[] = ["mine", "all", "status", "repo"];

function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.includes(v as SortKey) ? (v as SortKey) : "mine";
  } catch {
    return "mine";
  }
}

/** Survive a trip to Accounts and back: a list that forgets its search every
 *  time you look away is a list you stop searching. The sort is a preference,
 *  so it outlives the tab too. */
let rememberedFilter: BoardFilter = EMPTY_FILTER;
/** Parents whose children are shown. Folded by default: a lead with nine
 *  teammates is one row until you open it. */
let openParents: ReadonlySet<string> = new Set();

export function useListState() {
  const [filter, setFilterState] = useState<BoardFilter>(rememberedFilter);
  const [sort, setSortState] = useState<SortKey>(readSort);
  const [open, setOpenState] = useState(openParents);
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
  state,
  current,
  forcedOpen,
  list,
  onOpenFirst,
  onClose,
  scheduled,
  onCancelSchedule,
}: {
  sections: Section<Nested<SessionRow>>[];
  state: AppState;
  current: string | null;
  /** Ancestors of the open session, held open so it is never folded away. */
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
  const { filter, setFilter, sort } = list;
  const cur = useRef<HTMLAnchorElement>(null);
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
  const [drag, setDrag] = useState<{ s: SessionRow; banned: ReadonlySet<string> } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const move = (s: SessionRow, parent: string | null) => {
    endDrag();
    if (parent) list.setOpen(parent, true);
    api.patchSession(s.id, { parent }).catch((e: Error) => reportFailure(s.id, titleOf(s), "move", e.message));
  };
  const toRoot = drag?.s.parent != null;
  const dropping: DropProps = {
    start: (s) => setDrag({ s, banned: new Set([s.id, ...descendantsOf(s, state.sessions).map((c) => c.id)]) }),
    end: endDrag,
    can: (s) => !!drag && !drag.banned.has(s.id) && drag.s.parent !== s.id,
    over: (id) => setOver(id),
    drop: (s) => drag && move(drag.s, s.id),
  };

  // The arrows walk the list as a tree: ↑/↓ from row to row (↓ from the
  // search box to the open one, ↑ from the top row back to it), → unfolds a
  // parent, ← folds it or goes to its parent. Enter opens a row, as any link.
  const onArrow = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !e.key.startsWith("Arrow")) return;
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
      else if (e.key === "ArrowRight") {
        if (s?.kids && !unfolded) list.setOpen(s.id, true);
      } else if (s?.kids && unfolded && !forcedOpen.has(s.id)) list.setOpen(s.id, false);
      else if (s?.parent) nav.querySelector<HTMLElement>(`.rail-row[data-id="${CSS.escape(s.parent)}"]`)?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <nav className="rail" aria-label="Sessions" onKeyDown={onArrow}>
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
        <SortMenu list={list} />
      </div>

      <div
        className="rail-scroll"
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
        {scheduled.length ? (
          <div className="rail-sec" data-kind="scheduled">
            <div className="rail-label">
              Scheduled <span>{scheduled.length}</span>
            </div>
            {scheduled.map((sc) => (
              <ScheduledRow key={sc.id} sc={sc} current={sc.id === current} onCancel={onCancelSchedule} />
            ))}
          </div>
        ) : null}
        {rows.length === 0 && scheduled.length === 0 ? (
          <p className="rail-none">{filter.query ? "Nothing open matches." : state.sessions.length ? "Nothing open." : "No sessions yet."}</p>
        ) : null}
        {sections.map((sec) => (
          <div key={sec.key} className="rail-sec" data-kind={sec.kind}>
            {sec.label ? (
              <div className="rail-label" title={sort === "repo" ? sec.key : undefined}>
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
                shape={shapes.get(repoKey(s))}
                open={list.open.has(s.id) || forcedOpen.has(s.id)}
                onToggle={() => {
                  // A parent held open only because the open session is under it
                  // cannot fold while that session stays open: deselect it first.
                  if (forcedOpen.has(s.id)) location.hash = hrefOf({ page: "sessions" });
                  list.setOpen(s.id, !(list.open.has(s.id) || forcedOpen.has(s.id)));
                }}
                onClose={onClose}
                dnd={dropping}
                target={over === s.id}
              />
            ))}
          </div>
        ))}
        <ClosedList query={filter.query} current={current} stamp={closedStamp} shapes={shapes} />
      </div>
      {drag ? (
        <div className="rail-drophint" data-active={over === "root" || undefined} aria-hidden="true">
          {toRoot ? "Drop on a session to put it under that one, or anywhere else for the top level" : "Drop on a session to put it under that one"}
        </div>
      ) : null}
    </nav>
  );
}

/** What a row needs to be dragged, and dropped on. */
interface DropProps {
  start: (s: SessionRow) => void;
  end: () => void;
  /** Whether the row being dragged may go under `s`. */
  can: (s: SessionRow) => boolean;
  over: (id: string | null) => void;
  drop: (s: SessionRow) => void;
}

function Row({
  s,
  current,
  refFn,
  usual,
  sort,
  shape,
  open,
  onToggle,
  onClose,
  dnd,
  target,
}: {
  s: Nested<SessionRow>;
  current: boolean;
  refFn?: Ref<HTMLAnchorElement>;
  usual: ProviderId | null;
  sort: SortKey;
  shape: Shape | undefined;
  open: boolean;
  onToggle: () => void;
  onClose: (s: SessionRow) => void;
  dnd: DropProps;
  /** A dragged row is over this one, and may go under it. */
  target: boolean;
}) {
  const said = snippetOf(s);
  const movable = s.host !== "subagent";
  return (
    <a
      ref={refFn}
      className="rail-row"
      href={hrefOf({ page: "session", id: s.id, tab: openingTab(s.status) })}
      aria-current={current ? "page" : undefined}
      data-id={s.id}
      data-status={s.status}
      data-depth={s.depth || undefined}
      style={s.depth ? ({ "--depth": s.depth } as CSSProperties) : undefined}
      title={[titleOf(s), said ? said.slice(0, 240) : null].filter(Boolean).join("\n\n")}
      draggable={movable}
      data-drop={target || undefined}
      onDragStart={(e) => {
        if (!movable) return e.preventDefault();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-agentbox-session", s.id);
        dnd.start(s);
      }}
      onDragEnd={dnd.end}
      onDragOver={(e) => {
        // A row is never the list's top-level target, even one it cannot go under.
        e.stopPropagation();
        if (!dnd.can(s)) return dnd.over(null);
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        dnd.over(s.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dnd.can(s)) dnd.drop(s);
      }}
    >
      <StatusDot status={s.status} shape={shape} repo={baseName(repoKey(s))} copy={s.id} />
      <span className="rail-text">
        <span className="rail-title">{titleOf(s)}</span>
        {said ? <span className={`rail-snippet${s.status === "blocked" ? " blocked" : ""}`}>{said}</span> : null}
      </span>
      {s.kids ? (
        <button
          type="button"
          className="rail-kids"
          aria-expanded={open}
          title={`${open ? "Hide" : "Show"} the ${s.kids === 1 ? "session" : `${s.kids} sessions`} it started (← →)`}
          onClick={(e) => {
            // Inside the row's link: fold, do not open.
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
      {s.host === "subagent" ? null : <CloseX s={s} onClose={onClose} />}
    </a>
  );
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

/** A close the server refused: the row is back, and this says why. */
function CloseFailure() {
  const { failure, dismiss } = useClosing();
  if (!failure) return null;
  return (
    <p className="rail-err" role="alert">
      Could not {failure.verb ?? "close"} “{failure.title}”: {failure.message}{" "}
      <button type="button" className="linkish" onClick={dismiss}>
        dismiss
      </button>
    </p>
  );
}

/** What it last said, what it is asking, or that its answer is waiting. */
function snippetOf(s: SessionRow): string {
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

// ------------------------------------------------------------------ closed

const PAGE = 30;
/** Whether See closed is expanded; survives a trip to another page. */
let closedOpen = false;
/** Closed sessions fetched so far, by id: the session view falls back to
 *  these for one too old to be in the app state. */
export const closedSessions = new Map<string, SessionRow>();

/**
 * Closed sessions, below the rest, folded until asked for: the most recently
 * closed thirty, then thirty more each time the end scrolls into view. From
 * the server, so every session ever closed can be found and reopened, not
 * only those still inside the board's window.
 */
function ClosedList({ query, current, stamp, shapes }: { query: string; current: string | null; stamp: number; shapes: Map<string, Shape> }) {
  const [open, setOpenState] = useState(closedOpen);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  const gen = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  const load = async (offset: number) => {
    if (loading.current) return;
    loading.current = true;
    const mine = gen.current;
    try {
      const page = await api.closed(query.trim(), offset, PAGE);
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
    const t = setTimeout(() => void load(0), query ? 200 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, stamp]);

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
              href={hrefOf({ page: "session", id: s.id, tab: openingTab(s.status) })}
              aria-current={s.id === current ? "page" : undefined}
              data-status={s.status}
              title={titleOf(s)}
            >
              <StatusDot status={s.status} shape={shapes.get(repoKey(s))} repo={baseName(repoKey(s))} copy={s.id} />
              <span className="rail-text">
                <span className="rail-title">{titleOf(s)}</span>
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
