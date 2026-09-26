import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AppState, ProviderId } from "../../../src/core/types";
import { AccountChip, BigBadge, ContextBar, HostBadge, PROVIDER_LABEL, ProviderBadge, StatusDot, StatusPill } from "../bits";
import { Button, Empty, Icon, RelativeTime, Spinner } from "../components";
import {
  EMPTY_FILTER,
  filterSessions,
  neighbourId,
  repoKey,
  sectionsOf,
  sentTip,
  titleOf,
  usualProvider,
  whereOf,
  type BoardFilter,
  type Nested,
  type SessionRow,
} from "../lib/board";
import { baseName } from "../lib/format";
import { hrefOf } from "../route";
import { LoadCell } from "./session/load";
import { useOpenProject } from "./project";
import "./board.css";

/** Survives a trip into a session and back; a board that forgets its filter
 *  every time you look at a row is a board you stop filtering. */
let rememberedFilter: BoardFilter = EMPTY_FILTER;
let rememberedCursor: string | null = null;
/** Parents whose children are shown. Folded by default: a lead with nine
 *  teammates is one row until you open it. The rail beside a session reads
 *  this too, so the two lists agree. */
export let openParents: ReadonlySet<string> = new Set();

/**
 * Every session on the machine, most urgent first: blocked, then your turn,
 * then running, then stopped. Archived are hidden unless asked for.
 */
export function Board({ state, onOpen, onNew }: { state: AppState; onOpen: (id: string) => void; onNew: () => void }) {
  const [filter, setFilterState] = useState<BoardFilter>(rememberedFilter);
  const [cursor, setCursorState] = useState<string | null>(rememberedCursor);
  const setFilter = (f: BoardFilter) => {
    rememberedFilter = f;
    setFilterState(f);
  };
  const setCursor = (id: string | null) => {
    rememberedCursor = id;
    setCursorState(id);
  };
  const [open, setOpenState] = useState(openParents);
  const setOpen = (id: string, on: boolean) => {
    const next = new Set(open);
    if (on) next.add(id);
    else next.delete(id);
    openParents = next;
    setOpenState(next);
  };

  // The Project session is pinned above the list, not sorted into it.
  const rows = useMemo(
    () => filterSessions(state.sessions.filter((s) => s.id !== state.project.sessionId), filter),
    [state.sessions, state.project.sessionId, filter],
  );
  const sections = useMemo(() => sectionsOf(rows, (id) => open.has(id)), [rows, open]);
  const ordered = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const usual = useMemo(() => usualProvider(ordered), [ordered]);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());

  const providers = useMemo(() => {
    const seen = new Map<ProviderId, number>();
    for (const s of state.sessions) if (filter.showArchived || s.status !== "archived") seen.set(s.provider, (seen.get(s.provider) ?? 0) + 1);
    return [...seen.entries()];
  }, [state.sessions, filter.showArchived]);

  const repos = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of state.sessions) m.set(repoKey(s), (m.get(repoKey(s)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [state.sessions]);

  const archivedCount = state.sessions.filter((s) => s.status === "archived").length;
  const filtered = filter.query || filter.provider !== "all" || filter.account !== "all" || filter.repo !== "all";

  // j/k and Enter, anywhere on the page that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
        // From the search box, ↓ drops into the list.
        if (t.dataset.search !== undefined && e.key === "ArrowDown" && ordered[0]) {
          e.preventDefault();
          setCursor(ordered[0].id);
          rowRefs.current.get(ordered[0].id)?.focus();
        }
        return;
      }
      if (document.querySelector(".modal-backdrop")) return;
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (down || up) {
        e.preventDefault();
        const next = neighbourId(ordered, cursor, down ? 1 : -1);
        if (next) {
          setCursor(next);
          rowRefs.current.get(next)?.focus();
        }
      } else if ((e.key === "ArrowRight" || e.key === "l" || e.key === "ArrowLeft" || e.key === "h") && cursor) {
        // Open a parent, fold it, or from a child step out to its parent.
        const row = ordered.find((s) => s.id === cursor);
        if (!row) return;
        e.preventDefault();
        if (e.key === "ArrowRight" || e.key === "l") {
          if (row.kids) setOpen(row.id, true);
        } else if (row.kids && open.has(row.id)) setOpen(row.id, false);
        else if (row.depth > 0 && row.parent) {
          setCursor(row.parent);
          rowRefs.current.get(row.parent)?.focus();
        }
      } else if (e.key === "Enter" && cursor && !(t && t.tagName === "A")) {
        e.preventDefault();
        onOpen(cursor);
      } else if (e.key === "Escape" && filtered) {
        setFilter(EMPTY_FILTER);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (cursor) rowRefs.current.get(cursor)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <div className="bd">
      <div className="bd-bar">
        <label className="bd-search">
          <Icon.search size={14} />
          <span className="sr-only">Search sessions</span>
          <input
            data-search
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (filter.query) {
                  e.stopPropagation();
                  setFilter({ ...filter, query: "" });
                } else (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search title, path, branch, message…"
            spellCheck={false}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>

        <div className="bd-chips" role="group" aria-label="Filter by provider">
          <button className={`chip ${filter.provider === "all" ? "on" : ""}`} aria-pressed={filter.provider === "all"} onClick={() => setFilter({ ...filter, provider: "all" })}>
            All
          </button>
          {providers.map(([p, n]) => (
            <button key={p} className={`chip ${filter.provider === p ? "on" : ""}`} aria-pressed={filter.provider === p} onClick={() => setFilter({ ...filter, provider: filter.provider === p ? "all" : p })}>
              {PROVIDER_LABEL[p]} <span className="n">{n}</span>
            </button>
          ))}
        </div>

        <label className="bd-select">
          <span className="sr-only">Filter by account</span>
          <select value={filter.account} onChange={(e) => setFilter({ ...filter, account: e.target.value })}>
            <option value="all">All accounts</option>
            {state.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {PROVIDER_LABEL[a.provider]} · {a.label}
              </option>
            ))}
            <option value="none">No account</option>
          </select>
        </label>

        <label className="bd-select">
          <span className="sr-only">Filter by repository</span>
          <select value={filter.repo} onChange={(e) => setFilter({ ...filter, repo: e.target.value })}>
            <option value="all">All folders</option>
            {repos.map(([r, n]) => (
              <option key={r} value={r} title={r}>
                {baseName(r)} ({n})
              </option>
            ))}
          </select>
        </label>

        <span className="bd-spacer" />
        {archivedCount > 0 ? (
          <button
            className={`chip ${filter.showArchived ? "on" : ""}`}
            aria-pressed={filter.showArchived}
            onClick={() => setFilter({ ...filter, showArchived: !filter.showArchived })}
          >
            <Icon.archive size={12} /> Archived <span className="n">{archivedCount}</span>
          </button>
        ) : null}
        <Button size="sm" variant="primary" icon={Icon.plus} onClick={onNew} title="New session (n)">
          New session
        </Button>
      </div>

      <div className="bd-scroll">
        <ProjectRow state={state} onOpen={onOpen} />
        {state.sessions.length === 0 ? (
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
        ) : ordered.length === 0 ? (
          <Empty
            title="Nothing matches"
            action={
              <Button onClick={() => setFilter({ ...EMPTY_FILTER, showArchived: filter.showArchived })}>Clear filters</Button>
            }
          >
            {filter.showArchived ? "No session fits these filters." : "No session fits these filters. Archived sessions are hidden — the chip above shows them."}
          </Empty>
        ) : (
          <div className="bd-table" role="list" aria-label="Sessions">
            <div className="bd-head" aria-hidden="true">
              <span />
              <span>Session</span>
              <span className="bd-c-where">Where</span>
              <span className="bd-c-acct">Account</span>
              <span className="bd-c-ctx">Context</span>
              <span className="bd-c-load">Load</span>
              <span className="bd-c-when" title="When you last sent it something — what the rows are sorted by within each section">
                Sent
              </span>
            </div>
            {sections.map((sec) => (
              <section key={sec.kind} className="bd-section" data-kind={sec.kind} aria-label={sec.label}>
                <h2 className="bd-section-label">
                  {sec.label} <span className="n">{sec.rows.filter((s) => s.depth === 0).length}</span>
                </h2>
                {sec.rows.map((s) => (
                  <Row
                    key={s.id}
                    s={s}
                    state={state}
                    usual={usual}
                    cursor={cursor === s.id}
                    open={open.has(s.id)}
                    onToggle={() => setOpen(s.id, !open.has(s.id))}
                    refFn={(el) => {
                      if (el) rowRefs.current.set(s.id, el);
                      else rowRefs.current.delete(s.id);
                    }}
                    onFocus={() => setCursor(s.id)}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="bd-foot">
        <span>
          {rows.length === state.sessions.length ? `${rows.length} sessions` : `${rows.length} of ${state.sessions.length} sessions`}
        </span>
        <span className="bd-spacer" />
        <span className="bd-keys">
          <kbd>j</kbd>
          <kbd>k</kbd> move · <kbd>←</kbd>
          <kbd>→</kbd> fold · <kbd>Enter</kbd> open · <kbd>/</kbd> search · <kbd>n</kbd> new
        </span>
      </div>
    </div>
  );
}

/**
 * The Project session: one agent whose job is the other sessions, always
 * here. Opening it starts it (or resumes it) when it is not running.
 */
function ProjectRow({ state, onOpen }: { state: AppState; onOpen: (id: string) => void }) {
  const { session: s, running, busy, error, open } = useOpenProject(state, onOpen);
  const snippet = s?.status === "blocked" ? s.attention.reason : s?.lastMessage ?? s?.lastPrompt ?? null;

  return (
    <button type="button" className="bd-project" data-status={s?.status ?? "none"} onClick={() => void open()} disabled={busy}>
      <span className="bd-project-mark" aria-hidden="true">
        <Icon.sessions size={15} />
      </span>
      <span className="bd-c-main">
        <span className="bd-title-line">
          <span className="bd-title">Project</span>
          <ProviderBadge provider={state.project.provider} />
          {s && running ? <StatusPill status={s.status} /> : <span className="faint bd-project-off">{s ? "stopped — opens where it left off" : "not started"}</span>}
        </span>
        <span className={`bd-snippet${error ? " blocked" : ""}`}>
          {error ?? (snippet ? snippet.replace(/\s+/g, " ") : "Sees and manages every session through the agentbox CLI. Open it to ask.")}
        </span>
      </span>
      <span className="bd-project-go">{busy ? <Spinner size={13} /> : <Icon.chevronRight size={15} />}</span>
    </button>
  );
}

function Row({
  s,
  state,
  usual,
  cursor,
  open,
  onToggle,
  refFn,
  onFocus,
}: {
  s: Nested<SessionRow>;
  state: AppState;
  usual: ProviderId | null;
  cursor: boolean;
  open: boolean;
  onToggle: () => void;
  refFn: (el: HTMLAnchorElement | null) => void;
  onFocus: () => void;
}) {
  const where = whereOf(s);
  const snippet = s.status === "blocked" ? s.attention.reason : s.lastMessage ?? s.lastPrompt ?? s.firstPrompt;
  return (
    <a
      ref={refFn}
      role="listitem"
      className="bd-row"
      data-status={s.status}
      data-cursor={cursor || undefined}
      data-depth={s.depth || undefined}
      style={s.depth ? ({ "--depth": s.depth } as CSSProperties) : undefined}
      href={hrefOf({ page: "session", id: s.id, tab: "terminal" })}
      onFocus={onFocus}
    >
      <span className="bd-c-status">
        <StatusDot status={s.status} />
      </span>

      <span className="bd-c-main">
        <span className="bd-title-line">
          {s.provider !== usual ? <ProviderBadge provider={s.provider} /> : null}
          <span className="bd-title">{titleOf(s)}</span>
          {s.kids ? (
            <button
              type="button"
              className="bd-kids"
              aria-expanded={open}
              title={`${open ? "Hide" : "Show"} the ${s.kids === 1 ? "session" : `${s.kids} sessions`} it started (← →)`}
              onClick={(e) => {
                // Inside the row's link: fold, do not open.
                e.preventDefault();
                e.stopPropagation();
                onToggle();
              }}
            >
              {open ? <Icon.chevronDown size={11} /> : <Icon.chevronRight size={11} />}
              {s.kids}
            </button>
          ) : null}
          {s.big ? <BigBadge /> : null}
          {s.host === "external" ? <HostBadge host="external" /> : null}
          <span className="bd-inline-acct">
            <AccountChip accountId={s.accountId} accounts={state.accounts} cold={s.cold} />
          </span>
        </span>
        {snippet ? (
          <span className={`bd-snippet${s.status === "blocked" ? " blocked" : ""}`}>
            {s.status === "blocked" ? <Icon.alert size={12} /> : null}
            {snippet.replace(/\s+/g, " ")}
          </span>
        ) : null}
      </span>

      <span className="bd-c-where" title={s.cwd}>
        <span className="bd-repo">{where.name}</span>
        {where.branch ? (
          <span className="bd-branch">
            <Icon.branch size={11} />
            {where.branch}
          </span>
        ) : null}
      </span>

      <span className="bd-c-acct">
        <AccountChip accountId={s.accountId} accounts={state.accounts} cold={s.cold} plain />
      </span>

      <span className="bd-c-ctx">
        <ContextBar used={s.contextUsed} limit={s.contextLimit} />
      </span>

      <span className="bd-c-load">
        <LoadCell sessionId={s.id} />
      </span>

      <span className="bd-c-when">
        <RelativeTime ts={s.lastPromptAt} title={sentTip(s)} />
      </span>
    </a>
  );
}
