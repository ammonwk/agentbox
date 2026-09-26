/** The session list beside whatever session is open: search, a sort, and one
 *  row per session. It is the whole Sessions page's list; on a narrow screen
 *  with nothing open it is the page. */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import type { AppState, ProviderId } from "../../../../src/core/types";
import { ProviderBadge, ShapeMark, StatusDot } from "../../bits";
import { Icon, RelativeTime } from "../../components";
import {
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
import { baseName } from "../../lib/format";
import { openingTab } from "../../lib/phone";
import { api } from "../../api";
import { hrefOf } from "../../route";
import { useDismiss } from "../newsession/popover";
import { useOpenProject } from "../project";
import { closeNow, useClosing } from "./closing";

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
  list,
  onOpenFirst,
}: {
  sections: Section<Nested<SessionRow>>[];
  state: AppState;
  current: string | null;
  list: ListState;
  onOpenFirst: () => void;
}) {
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const usual = useMemo(() => usualProvider(rows), [rows]);
  const shapes = useMemo(() => repoShapes(state.sessions), [state.sessions]);
  // Changes whenever something is closed or reopened, so an open closed list refetches.
  const closedStamp = useMemo(
    () => state.sessions.reduce((n, s) => (s.status === "closed" ? n + 1 + (s.closedAt ?? 0) : n), 0),
    [state.sessions],
  );
  const { filter, setFilter, sort } = list;
  const cur = useRef<HTMLAnchorElement>(null);
  // A block body, not `() => el.scrollIntoView()`: newer browsers return a
  // Promise from scrollIntoView, and React calls whatever an effect returns as
  // its cleanup — `destroy is not a function` took the whole app down.
  useEffect(() => {
    cur.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <nav className="rail" aria-label="Sessions">
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

      <RailProject state={state} current={current} />

      <div className="rail-scroll">
        <CloseFailure />
        {rows.length === 0 ? (
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
                open={list.open.has(s.id)}
                onToggle={() => list.setOpen(s.id, !list.open.has(s.id))}
              />
            ))}
          </div>
        ))}
        <ClosedList query={filter.query} current={current} stamp={closedStamp} shapes={shapes} />
      </div>
    </nav>
  );
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
}: {
  s: Nested<SessionRow>;
  current: boolean;
  refFn?: Ref<HTMLAnchorElement>;
  usual: ProviderId | null;
  sort: SortKey;
  shape: Shape | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const said = snippetOf(s);
  return (
    <a
      ref={refFn}
      className="rail-row"
      href={hrefOf({ page: "session", id: s.id, tab: openingTab(s.status) })}
      aria-current={current ? "page" : undefined}
      data-status={s.status}
      data-depth={s.depth || undefined}
      style={s.depth ? ({ "--depth": s.depth } as CSSProperties) : undefined}
      title={[titleOf(s), said ? said.slice(0, 240) : null].filter(Boolean).join("\n\n")}
    >
      <StatusDot status={s.status} shape={shape} repo={baseName(repoKey(s))} />
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
      <CloseX s={s} current={current} />
    </a>
  );
}

/**
 * The ✕ that takes the time's place under the pointer: Close, straight from
 * the list. One mid-turn asks first — a second click within a few seconds —
 * since closing stops it and cuts the turn short.
 */
function CloseX({ s, current }: { s: SessionRow; current: boolean }) {
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
        closeNow(s.id, titleOf(s));
        if (current) location.hash = hrefOf({ page: "sessions" });
      }}
    >
      {armed ? "Stop?" : <Icon.x size={12} />}
    </button>
  );
}

/** A close the server refused: the row is back, and this says why. */
function CloseFailure() {
  const { failure, dismiss } = useClosing();
  if (!failure) return null;
  return (
    <p className="rail-err" role="alert">
      Could not close “{failure.title}”: {failure.message}{" "}
      <button type="button" className="linkish" onClick={dismiss}>
        dismiss
      </button>
    </p>
  );
}

/** What it last said, or what it is asking. */
function snippetOf(s: SessionRow): string {
  const said = s.status === "blocked" ? s.attention.reason : s.lastMessage ?? s.lastPrompt ?? s.firstPrompt;
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
              <StatusDot status={s.status} shape={shapes.get(repoKey(s))} repo={baseName(repoKey(s))} />
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

/** The Project session, pinned above the list's scroll so it is one click
 *  from anywhere. */
function RailProject({ state, current }: { state: AppState; current: string | null }) {
  const p = useOpenProject(state, (id) => (location.hash = hrefOf({ page: "session", id, tab: openingTab(p.session?.status) })));
  return (
    <button
      type="button"
      className="rail-project"
      aria-current={p.session && p.session.id === current ? "page" : undefined}
      disabled={p.busy}
      title={p.error ?? "The Project session: sees and manages every session"}
      onClick={() => void p.open()}
    >
      <StatusDot status={p.running ? p.session!.status : "stopped"} />
      <Icon.sessions size={13} />
      <span className="rail-title">Project</span>
      <ProviderBadge provider={state.project.provider} short />
    </button>
  );
}
