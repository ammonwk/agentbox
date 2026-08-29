import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { AttentionBadge, Button, Empty, Icon, RelativeTime, StatusPill } from "../../components";
import { repoShort, type SessionRow } from "../../api";
import type { SubagentProgress } from "../../../../src/core/types";
import { flatten, neighbourId, sectionsFor } from "./list";
import { LoadCell } from "./load";

/**
 * The board row's subagent line — "4 subs · 2 running" — rendered from the
 * session's latest progress snapshot. Renders nothing for a run that never
 * dispatched one, so ordinary rows keep the height they always had.
 */
function SubsMeta({ subs }: { subs: SubagentProgress[] | null }) {
  if (!subs || subs.length === 0) return null;
  // `pending` is not running — see the note on `rosterCounts`.
  const running = subs.filter((s) => s.status === "running").length;
  const failed = subs.filter((s) => s.status === "failed").length;
  return (
    <span className={`sx-row-subs${failed > 0 ? " failed" : ""}`}>
      <span>·</span>
      {subs.length} sub{subs.length === 1 ? "" : "s"}
      {running > 0 && <span> · {running} running</span>}
      {failed > 0 && <span> · {failed} failed</span>}
    </span>
  );
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onNew,
}: {
  sessions: SessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const sections = useMemo(() => sectionsFor(sessions), [sessions]);
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

  return (
    <div className="sx-list">
      <div className="sx-list-head">
        <span className="sx-list-count">
          {ordered.length} session{ordered.length === 1 ? "" : "s"}
        </span>
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
                : "Every open session is on the board."}
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
                  <SubsMeta subs={s.subs} />
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
