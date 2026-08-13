import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session, ToolCall, ToolKind, TranscriptEvent } from "../../../../src/core/types";
import { Button, Empty, Icon, type IconComponent } from "../../components";
import { fmtDuration, useSessionEvents } from "../../api";
import { callDurationMs, formatInput, KIND_LABEL, toolSummary } from "./format";
import { activityEmptyReason, collapseRun, groupEvents, runSummary, type ToolEntry } from "./transcript";
import { isPinnedToBottom, shouldAutoScroll } from "./scroll";

export function Activity({ session }: { session: Session }) {
  const sessionId = session.id;
  const { events, live } = useSessionEvents(sessionId);
  const rows = useMemo(() => groupEvents(events), [events]);

  const boxRef = useRef<HTMLDivElement>(null);
  // `pinned` is only ever written from a scroll event, so it describes where
  // the reader was *before* new events landed — which is the question
  // shouldAutoScroll needs answered.
  const [pinned, setPinned] = useState(true);
  const prevCount = useRef(0);
  const prevSession = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const initial = prevSession.current !== sessionId;
    const grew = events.length > prevCount.current;
    if (shouldAutoScroll({ wasPinned: pinned, grew, initial })) {
      el.scrollTop = el.scrollHeight;
      setPinned(true);
    }
    prevCount.current = events.length;
    prevSession.current = sessionId;
    // `pinned` is deliberately read but not a dependency: re-running when it
    // flips would jerk the reader back to the tail the moment they scrolled.
  }, [events.length, sessionId]);

  function jumpToLatest() {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }

  return (
    <div
      className="sx-panel"
      ref={boxRef}
      onScroll={() => {
        const el = boxRef.current;
        if (el) setPinned(isPinnedToBottom(el));
      }}
    >
      {events.length === 0 && <EmptyActivity session={session} live={live} />}

      <div className="sx-stream">
        {rows.map((row) => {
          if (row.kind === "toolRun") return <ToolRun key={row.key} entries={row.entries} />;
          if (row.kind === "prose") return <div key={row.key} className="sx-assistant">{row.text}</div>;
          return <EventRow key={row.key} event={row.event} />;
        })}
      </div>

      {!pinned && events.length > 0 && (
        <div className="sx-jump">
          <Button size="sm" icon={Icon.arrowDown} onClick={jumpToLatest}>
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyActivity({ session, live }: { session: Session; live: boolean }) {
  const reason = activityEmptyReason(session, live);

  switch (reason.kind) {
    case "disconnected":
      return (
        <Empty title="Not streaming">
          The event stream for this session is not connected, so this is not
          "nothing happened" — it is "we cannot see". It reconnects automatically; if it does not,
          the server is down.
        </Empty>
      );

    case "missing":
      // A log that exists but cannot be parsed now says so itself, as an error
      // event from the server. Reaching here means the file is not there at all.
      return (
        <Empty title="This session's log is missing">
          It ran{" "}
          {reason.toolCalls > 0
            ? `${reason.toolCalls} tool call${reason.toolCalls === 1 ? "" : "s"}`
            : "to completion"}
          , so it had a history — but the log file is gone or unreadable, and a transcript cannot
          be rebuilt from anything else. The <strong>Diff</strong> tab still shows what it changed
          and <strong>Task</strong> still shows what it was asked to do
          {reason.hasMessage ? ", including the last thing it said" : ""}.
        </Empty>
      );

    case "starting":
      return (
        <Empty title="Waiting for the first event">
          The session is live and has not emitted anything yet. Assistant messages, every tool
          call, advisories and supervisor verdicts appear here as it works.
        </Empty>
      );

    case "silent":
      return (
        <Empty title="This session recorded nothing">
          It reached <strong>{session.status}</strong> without emitting a single event — usually a
          spawn that died before the agent opened a conversation. The exit code and any error are
          in the header; Resume re-runs the original task.
        </Empty>
      );
  }
}

// ------------------------------------------------------------- tool rows

function ToolRun({ entries }: { entries: ToolEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const folded = collapseRun(entries);
  const shown = expanded
    ? entries.map((entry) => ({ entry, hiddenBefore: 0 }))
    : folded.visible;
  const { errors } = runSummary(entries);

  return (
    <div className="sx-run">
      {shown.map(({ entry, hiddenBefore }) => (
        <Fragment key={`${entry.seq}-${entry.call.id}`}>
          {/* The fold sits exactly where the hidden calls were, so the run
              still reads in stream order. */}
          {hiddenBefore > 0 && (
            <button className="sx-fold" onClick={() => setExpanded(true)}>
              ⋯ show {hiddenBefore} more tool call{hiddenBefore === 1 ? "" : "s"}
              {errors > 0 ? " — every failure is already shown" : ""}
            </button>
          )}
          <ToolRow call={entry.call} />
        </Fragment>
      ))}
      {expanded && folded.hiddenCount > 0 && (
        <button className="sx-fold" onClick={() => setExpanded(false)}>
          Collapse {entries.length} tool calls
        </button>
      )}
    </div>
  );
}

/** ACP gives no tool name, so `kind` is the only thing an icon can key off. */
const KIND_ICON: Record<ToolKind, IconComponent> = {
  read: Icon.file,
  edit: Icon.edit,
  delete: Icon.trash,
  move: Icon.move,
  execute: Icon.terminal,
  search: Icon.search,
  fetch: Icon.download,
  think: Icon.brain,
  other: Icon.settings,
};

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const sub = toolSummary(call);
  const ms = callDurationMs(call);
  const KindIcon = KIND_ICON[call.kind];

  return (
    <>
      <button
        className={`sx-tool ${call.status}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`${KIND_LABEL[call.kind]} — ${call.title}`}
      >
        <span className="sx-tool-glyph">
          <KindIcon size={13} />
        </span>
        <span className="sx-tool-title">{call.title || KIND_LABEL[call.kind]}</span>
        {sub && <span className="sx-tool-sub">{sub}</span>}
        {!sub && <span className="sx-tool-sub" />}
        {ms != null && <span className="sx-tool-dur">{fmtDuration(ms)}</span>}
        <span className={`sx-tool-status ${call.status}`}>
          {call.status === "ok" ? "ok" : call.status === "error" ? "error" : "…"}
        </span>
      </button>

      {open && (
        <div className="sx-tool-detail">
          <div>
            <h4>Input</h4>
            <pre className="sx-pre">{formatInput(call.input)}</pre>
          </div>
          {call.locations.length > 0 && (
            <div>
              <h4>Touched</h4>
              <pre className="sx-pre">{call.locations.join("\n")}</pre>
            </div>
          )}
          <div>
            <h4>Output</h4>
            <pre className="sx-pre">
              {call.output ??
                (call.status === "running" || call.status === "pending"
                  ? "(still running)"
                  : "(no output recorded)")}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------- other rows

function EventRow({ event }: { event: TranscriptEvent }) {
  switch (event.type) {
    case "assistant":
      // Merged into a `prose` row by groupEvents; never reaches here.
      return null;

    case "user":
      // A supervisor nudge is not the human talking — the agent was steered by
      // a machine, and reading the two as the same thing hides that.
      return (
        <div className={`sx-block ${event.from === "human" ? "human" : "supervisor-msg"}`}>
          <div className="sx-block-head">
            {event.from === "human" ? "You" : "Supervisor nudge"}
          </div>
          <div className="sx-block-body">{event.text}</div>
        </div>
      );

    case "advisory":
      return (
        <div className={`sx-block advisory-${event.severity}`}>
          <div className="sx-block-head">Advisor · {event.severity}</div>
          <div className="sx-block-body">{event.text}</div>
        </div>
      );

    case "supervisor":
      return (
        <div className={`sx-block verdict-${event.verdict.state}`}>
          <div className="sx-block-head">
            Supervisor · {event.verdict.state} · {event.verdict.source} · at call{" "}
            {event.verdict.atToolCall}
          </div>
          <div className="sx-block-body">{event.verdict.reason}</div>
          {event.verdict.nudge && (
            <div className="sx-block-body" style={{ marginTop: 6, color: "var(--muted)" }}>
              Sent to the agent: {event.verdict.nudge}
            </div>
          )}
        </div>
      );

    case "permission":
      return (
        <div className="sx-block permission">
          <div className="sx-block-head">
            Permission ·{" "}
            {event.approved === null ? "awaiting you" : event.approved ? "approved" : "denied"}
          </div>
          <div className="sx-block-body">{event.title}</div>
        </div>
      );

    case "turn":
      return <div className="sx-turn">turn ended · {event.stopReason}</div>;

    case "error":
      return (
        <div className="sx-block error">
          <div className="sx-block-head">Error</div>
          <div className="sx-block-body">{event.message}</div>
        </div>
      );

    case "tool":
      // Grouped into runs by groupEvents; never reaches here.
      return null;
  }
}
