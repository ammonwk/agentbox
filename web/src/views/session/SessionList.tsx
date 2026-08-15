import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { AttentionBadge, Button, Empty, Icon, RelativeTime, StatusPill } from "../../components";
import { repoShort, type SessionRow } from "../../api";
import { flatten, neighbourId, sectionsFor } from "./list";
import { LoadCell } from "./load";

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onNew,
  showClosed,
  onToggleClosed,
}: {
  sessions: SessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  showClosed: boolean;
  onToggleClosed: (next: boolean) => void;
}) {
  const sections = useMemo(() => sectionsFor(sessions, showClosed), [sessions, showClosed]);
  const ordered = useMemo(() => flatten(sections), [sections]);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // Deep links and Inbox hand-offs select a row we may never have rendered in
  // view; bring it on screen without stealing focus from wherever the user is.
  useEffect(() => {
    if (!selectedId) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = neighbourId(ordered, selectedId, e.key === "ArrowDown" ? 1 : -1);
    if (!next) return;
    onSelect(next);
    rowRefs.current.get(next)?.focus();
  }

  const closedCount = sessions.filter((s) => s.closedAt != null).length;

  return (
    <div className="sx-list">
      <div className="sx-list-head">
        <span className="sx-list-count">
          {ordered.length} session{ordered.length === 1 ? "" : "s"}
        </span>
        {closedCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onToggleClosed(!showClosed)}
            aria-pressed={showClosed}
            title={showClosed ? "Hide closed sessions" : `Show ${closedCount} closed`}
          >
            {showClosed ? "Hide closed" : `Closed ${closedCount}`}
          </Button>
        )}
        <Button variant="primary" size="sm" icon={Icon.plus} onClick={onNew}>
          New
        </Button>
      </div>

      <div
        className="sx-list-scroll"
        role="listbox"
        aria-label="Sessions"
        aria-activedescendant={selectedId ? `sx-row-${selectedId}` : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {ordered.length === 0 && (
          <div style={{ padding: 16 }}>
            <Empty
              title={sessions.length === 0 ? "No sessions yet" : "Nothing here"}
              action={
                <Button variant="primary" size="sm" icon={Icon.plus} onClick={onNew}>
                  New session
                </Button>
              }
            >
              {sessions.length === 0
                ? "Spawn one: pick a repo and describe the task. agentbox cuts a worktree, runs omp on it, and everything it does shows up here."
                : "Every session is closed. Show closed to bring them back into the list."}
            </Empty>
          </div>
        )}

        {sections.map((section) => (
          <div key={section.id}>
            <div className="sx-section-label">
              {section.label} · {section.sessions.length}
            </div>
            {section.sessions.map((s) => (
              <button
                key={s.id}
                id={`sx-row-${s.id}`}
                ref={(el) => {
                  if (el) rowRefs.current.set(s.id, el);
                  else rowRefs.current.delete(s.id);
                }}
                className="sx-row"
                role="option"
                aria-selected={selectedId === s.id}
                aria-current={selectedId === s.id}
                onClick={() => onSelect(s.id)}
              >
                <div className="sx-row-top">
                  {(s.status === "running" || s.status === "spawning") && (
                    <span className="sx-live" aria-label="running" />
                  )}
                  <span className="sx-row-title">{s.title}</span>
                  <StatusPill status={s.status} />
                </div>

                {s.attention.kind !== "none" && (
                  <div className="sx-row-attention">
                    <AttentionBadge attention={s.attention} />
                  </div>
                )}

                {/* A local repo's ref is an absolute path — ~90 chars for a
                    worktree under a temp dir, which would wrap and push the
                    branch out of the row. Shorten, but keep the full path
                    reachable on hover rather than throwing it away. */}
                <div className="sx-row-meta" title={`${s.repo} · ${s.branch}`}>
                  <span>{repoShort(s.repo)}</span>
                  <code>{s.branch}</code>
                  <span>·</span>
                  <RelativeTime ts={s.updatedAt} />
                </div>

                {/* Renders nothing when the session has no live process, so a
                    finished row keeps the height it always had. */}
                <LoadCell sessionId={s.id} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
