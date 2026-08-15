import { useEffect, useMemo, useState } from "react";
import type { AppState, SessionRow } from "../api";
import { Button, Empty, Icon } from "../components";
import { SessionList } from "./session/SessionList";
import { SessionDetail } from "./session/SessionDetail";
import { NewSession } from "./session/NewSession";
import { sortSessions } from "./session/list";
import { useIsNarrow } from "./session/useIsNarrow";
import "./session/session.css";

/**
 * The board: session list on the left, everything about one session on the
 * right. The shell owns the route (`#/sessions/<id>`) and hands the selection
 * in and out, so a deep link, the Inbox and a click here all land in the same
 * place.
 */
export function Sessions({
  state,
  selectedId,
  onSelect,
}: {
  state: AppState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const narrow = useIsNarrow();
  const sessions: SessionRow[] = state.sessions;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  // Nothing selected (or the selection was deleted elsewhere): fall to the most
  // urgent session so the screen is never a blank right-hand pane by default.
  //
  // Never when narrow. There the two panes take turns, so auto-selecting would
  // replace the list with a detail view the moment it rendered, and the list
  // would be unreachable.
  const fallback = useMemo(() => sortSessions(sessions.filter((s) => s.closedAt == null))[0] ?? null, [sessions]);
  useEffect(() => {
    if (!narrow && !selected && fallback) onSelect(fallback.id);
  }, [narrow, selected, fallback, onSelect]);

  // An closed session reached by deep link must still be visible in the list.
  useEffect(() => {
    if (selected?.closedAt != null) setShowClosed(true);
  }, [selected]);

  // Narrow: one pane at a time. Splitting 720px of height between a list and a
  // detail leaves the detail ~70px of transcript under its own header, tabs and
  // composer — a pane too small to use, not a tight one.
  const showList = !narrow || !selected;
  const showDetail = !narrow || selected != null;

  return (
    <div className="sx-wrap" data-panes={narrow ? "one" : "two"}>
      {showList && (
        <SessionList
          sessions={sessions}
          selectedId={selected?.id ?? null}
          onSelect={onSelect}
          onNew={() => setShowNew(true)}
          showClosed={showClosed}
          onToggleClosed={setShowClosed}
        />
      )}

      {showDetail && selected ? (
        <SessionDetail
          key={selected.id}
          session={selected}
          attention={selected.attention}
          onBack={narrow ? () => onSelect(null) : undefined}
          onClosed={() => onSelect(null)}
        />
      ) : showDetail && (
        <div className="sx-detail">
          <div className="sx-panel">
            <Empty
              title={sessions.length === 0 ? "No sessions yet" : "Nothing selected"}
              action={
                <Button variant="primary" icon={Icon.plus} onClick={() => setShowNew(true)}>
                  New session
                </Button>
              }
            >
              {sessions.length === 0
                ? "Spawn one and this pane fills with what the agent is doing: every tool call, the diff it is building, and a box to correct it in."
                : "Pick a session on the left to see its activity, its diff, and the task it was given."}
            </Empty>
          </div>
        </div>
      )}

      {showNew && (
        <NewSession
          repos={state.repos}
          settings={state.settings}
          onClose={() => setShowNew(false)}
          onCreated={(session) => {
            setShowNew(false);
            onSelect(session.id);
          }}
        />
      )}
    </div>
  );
}
