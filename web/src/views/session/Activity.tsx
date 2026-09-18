import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  Session,
  SubagentProgress,
  SupervisorVerdict,
  ToolCall,
  ToolKind,
  TranscriptEvent,
} from "../../../../src/core/types";
import { Button, Empty, Icon, type IconComponent } from "../../components";
import { ago, api, clockNow, fmtClock, fmtCost, fmtDuration, fmtTokens, subscribeToClock, useSessionEvents, type FanoutView, type HubAgentDetail } from "../../api";
import { rosterIsLive } from "../../../../src/core/roster";
import { callDurationMs, canSteer, formatInput, HUB_STEP_HINT, KIND_LABEL, prBaseOf, splitPRRefs, SUBAGENT_KIND_LABEL, subagentCallOf, subagentStepLabel, toolSummary } from "./format";
import { useAction } from "./useAction";
import { Markdown } from "./Markdown";
import {
  activityEmptyReason,
  collapseRun,
  failedPromptSeqs,
  groupEvents,
  queuedPromptSeqs,
  rosterCounts,
  rosterFromSubs,
  runSummary,
  subagentDetail,
  subagentRoster,
  type RosterEntry,
  type SubagentEvent,
  type SubagentDetail,
  type ToolEntry,
} from "./transcript";
import { isAtTop, isPinnedToBottom, anchoredScrollTop, shouldAutoScroll } from "./scroll";

export function Activity({ session }: { session: Session }) {
  const sessionId = session.id;
  const { events, live, older, loadOlder } = useSessionEvents(sessionId);
  const rows = useMemo(() => groupEvents(events), [events]);
  const fanout = useFanout(session);
  const roster = useMemo(
    () => rosterOf(session, fanout.view, events),
    [session, fanout.view, events],
  );
  const failedPrompts = useMemo(() => failedPromptSeqs(events), [events]);
  const queuedPrompts = useMemo(() => queuedPromptSeqs(events), [events]);
  // PR references link into the session's own GitHub repo; null (no slug)
  // means the plain text stays plain.
  const prBase = prBaseOf(session.repoFullName);

  const boxRef = useRef<HTMLDivElement>(null);
  // `pinned` is only ever written from a scroll event, so it describes where
  // the reader was *before* new events landed — which is the question
  // shouldAutoScroll needs answered.
  const [pinned, setPinned] = useState(true);
  const prevCount = useRef(0);
  const prevSession = useRef<string | null>(null);
  // The viewport as of the last paint or scroll, and the first seq on screen
  // then — the pair that says "history was prepended under the reader" and
  // holds the numbers the anchor needs.
  const viewport = useRef({ scrollTop: 0, scrollHeight: 0, firstSeq: 0 });
  const hasOlder = !older.exhausted && events.length > 0 && events[0]!.seq > 1;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const initial = prevSession.current !== sessionId;
    const firstSeq = events.length > 0 ? events[0]!.seq : 0;
    const prev = viewport.current;
    if (!initial && prev.firstSeq > 0 && firstSeq > 0 && firstSeq < prev.firstSeq) {
      // Older history landed above the reader. Re-anchor before paint, or the
      // browser shows one frame with the viewport shoved down the page.
      el.scrollTop = anchoredScrollTop(prev, el);
    }
    viewport.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, firstSeq };

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

  // The scroll handler both follows the tail and reaches for history: at the
  // top, the next older page loads immediately — and after each prepend
  // re-anchors the reader at the same offset, still within reach of the top,
  // so continuing to scroll up chains page after page back to the beginning.
  function onScroll() {
    const el = boxRef.current;
    if (!el) return;
    setPinned(isPinnedToBottom(el));
    viewport.current.scrollTop = el.scrollTop;
    if (isAtTop(el)) loadOlder();
  }

  function jumpToLatest() {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }

  // The strip sits OUTSIDE the scroll box, so a reader pinned to the live
  // tail still sees the fan-out's status — that is the whole point of the
  // strip. Inside, it would scroll away exactly when the run is busiest.
  return (
    <div className="sx-activity">
      {roster.length > 0 && (
        <SubagentStrip
          session={session}
          roster={roster}
          fanout={fanout.view}
          events={events}
          prBase={prBase}
        />
      )}

      <div
        className="sx-panel"
        ref={boxRef}
        onScroll={onScroll}
      >
        {events.length === 0 && <EmptyActivity session={session} live={live} />}

        <div className="sx-stream">
          {older.loading && <div className="sx-history">Loading earlier events…</div>}
          {!older.loading && !hasOlder && events.length > 0 && (
            <div className="sx-history">Beginning of this session's transcript</div>
          )}
          {rows.map((row) => {
            // Every row carries its first event's time as a hover tooltip —
            // the one question a long transcript cannot answer on sight is
            // "when did this actually happen".
            const ts =
              row.kind === "toolRun"
                ? row.entries[0].ts
                : row.kind === "prose" || row.kind === "subagents"
                  ? row.ts
                  : row.event.ts;
            const inner =
              row.kind === "toolRun" ? (
                <ToolRun entries={row.entries} prBase={prBase} />
              ) : row.kind === "prose" ? (
                <Markdown text={row.text} prBase={prBase} />
              ) : row.kind === "subagents" ? (
                <SubagentTransitions events={row.events} />
              ) : (
                <EventRow
                  event={row.event}
                  prBase={prBase}
                  session={session}
                  failedPrompts={failedPrompts}
                  queuedPrompts={queuedPrompts}
                />
              );
            return (
              <div key={row.key} className="sx-row" title={`${fmtClock(ts)} · ${ago(ts)}`}>
                {inner}
              </div>
            );
          })}

          {(session.status === "running" || session.status === "spawning") && (
            <ThinkingRow
              spawning={session.status === "spawning"}
              at={events.length ? events[events.length - 1]!.ts : session.startedAt ?? Date.now()}
            />
          )}
        </div>

        {!pinned && events.length > 0 && (
          <div className="sx-jump">
            <Button size="sm" icon={Icon.arrowDown} onClick={jumpToLatest}>
              Jump to latest
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Subagents starting and finishing, as a line in the stream.
 *
 * This is what a fan-out leaves in the transcript now: one event per
 * transition instead of a snapshot every two seconds. The value of it is the
 * timestamp — "these nine came back at 09:47" is a thing a person reading a
 * ten-hour run afterwards genuinely wants, and it is exactly what the old
 * heartbeat rows buried under fourteen thousand copies of the dispatch call.
 */
function SubagentTransitions({ events }: { events: SubagentEvent[] }) {
  return (
    <div className="sx-sub-events">
      {events.map((e) => (
        <span key={e.seq} className={`sx-sub-event ${e.status}`}>
          <span className={`sx-sub-dot ${e.status}`} />
          <code>{e.name}</code>
          <span className="sx-sub-event-what">{transitionWord(e)}</span>
          {e.durationMs ? <span className="sx-sub-event-meta">{fmtDuration(e.durationMs)}</span> : null}
          {e.toolCount ? <span className="sx-sub-event-meta">{e.toolCount} tools</span> : null}
        </span>
      ))}
    </div>
  );
}

function transitionWord(e: SubagentEvent): string {
  // "recorded" rather than "finished" when the news came from omp's directory
  // after the fact: the ending is real, the moment is when we noticed.
  const late = e.source === "disk" ? " (recorded later)" : "";
  switch (e.status) {
    case "pending":
      return "dispatched";
    case "running":
      return "started";
    case "completed":
      return `finished${late}`;
    case "failed":
      return `failed${late}`;
  }
}

/**
 * The session's fan-out, reconciled against omp's record on disk.
 *
 * Fetched, not pushed, because reading omp's session directory is a disk scan
 * and the board's hot state must stay cheap. The fetch is also not needed
 * while the session is running: the host is merging the live progress stream
 * into the session row and pushing it, which is fresher than anything a file
 * can say. What the disk is for is the rest of a fan-out's life — after the
 * turn ends, after the agent is parked or stopped, after the server restarts —
 * and none of those are moments where one request costs anything.
 */
function useFanout(session: Session): { view: FanoutView | null; error: string | null } {
  const [view, setView] = useState<FanoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionId = session.id;
  const hasSubs = (session.subs?.length ?? 0) > 0;
  // Re-asked when the session moves, which after a turn ends is exactly once.
  const at = session.updatedAt;

  useEffect(() => {
    setView(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!hasSubs) return;
    let cancelled = false;
    api
      .fanout(sessionId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e: Error) => {
        // A roster that cannot be reconciled is not a broken page: the session
        // row still has the last thing the stream said, and the strip will
        // label it as what it is.
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, hasSubs, at]);

  return { view, error };
}

/**
 * Which description of the fan-out to draw.
 *
 * Three sources, in the order they are worth believing:
 *
 *  1. While the session is running, the session row. The host is merging omp's
 *     live progress stream into it and pushing every change, so it is the only
 *     one that can be current.
 *  2. Otherwise the reconciled view, which is that same roster plus whatever
 *     omp's session directory knows about how it ended.
 *  3. Failing both, whatever the transcript in hand can be folded into — for
 *     sessions recorded before any roster was kept.
 */
function rosterOf(
  session: Session,
  view: FanoutView | null,
  events: TranscriptEvent[],
): RosterEntry[] {
  const preferred = rosterIsLive(session.status) ? session.subs ?? view?.subs : view?.subs ?? session.subs;
  if (preferred?.length) return rosterFromSubs(preferred);
  return subagentRoster(events);
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

const noopSubscribe = () => () => {};

/**
 * Ticks once a second while `on`. A long-running call's elapsed time is the
 * one number on this screen that moves without an event landing — and a
 * ten-minute subagent wait that shows no time at all reads exactly like a
 * hang.
 */
function useTicker(on: boolean): number {
  return useSyncExternalStore(on ? subscribeToClock : noopSubscribe, clockNow, clockNow);
}

/**
 * The live tail of a running turn, shown whether or not anything is arriving.
 *
 * Assistant text already streams in as it is produced; the gap this fills is
 * the quiet one — the model reading, reasoning, or a provider stalling — which
 * otherwise renders as nothing at all and reads exactly like a hang. The
 * "quiet" figure is the honest signal: it moves every second, and "quiet 2m"
 * next to a pulsing dot says thinking, while the same figure after a burst of
 * tool calls says stalled.
 */
function ThinkingRow({ at, spawning }: { at: number; spawning: boolean }) {
  const now = useTicker(true);
  const quiet = Math.max(0, now - at);
  return (
    <div
      className="sx-thinking"
      title={spawning ? "The host is launching the agent" : `Last event ${ago(at, now)}`}
    >
      <span className="sx-thinking-dot" />
      <span className="sx-thinking-label">
        {spawning ? "Starting…" : quiet < 10_000 ? "Working…" : "Thinking…"}
      </span>
      <span className="sx-thinking-quiet">
        {quiet < 3_000 ? "streaming" : `quiet ${fmtDuration(quiet)}`}
      </span>
    </div>
  );
}

function ToolRun({ entries, prBase }: { entries: ToolEntry[]; prBase: string | null }) {
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
          <ToolRow call={entry.call} prBase={prBase} />
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

/** Subagent rows get their own glyphs — they are structure, not plumbing. */
const SUBAGENT_ICON = {
  dispatch: Icon.branch,
  wait: Icon.clock,
  collect: Icon.download,
} as const;

function subagentSubtitle(sa: NonNullable<ReturnType<typeof subagentCallOf>>): string {
  switch (sa.kind) {
    case "dispatch": {
      const names = sa.tasks.map((t) => t.name);
      const head = names.slice(0, 3).join(", ");
      const rest = names.length - 3;
      return (
        `${names.length} subagent${names.length === 1 ? "" : "s"}` +
        (names.length > 1 ? ` · ${head}${rest > 0 ? ` +${rest} more` : ""}` : "")
      );
    }
    case "wait":
      return sa.to ? `→ ${sa.to}` : "waiting on subagents";
    case "collect":
      return `result · ${sa.name}`;
  }
}

/** One line in a dispatch row's expanded view: who was spawned and where it got to. */
function DispatchedLine({ sub, prBase }: { sub: SubagentProgress; prBase: string | null }) {
  return (
    <div className={`sx-dispatch-line status-${sub.status}`}>
      <span className={`sx-sub-dot ${sub.status}`} />
      <code className="sx-dispatch-name">{sub.id}</code>
      <span className="sx-dispatch-agent">{sub.agent}</span>
      <span className="sx-dispatch-meta">
        {sub.status === "running" && sub.currentTool
          ? `${sub.currentTool}${sub.lastIntent ? ` — ${sub.lastIntent}` : ""}`
          : sub.status}
        {" · "}
        {sub.toolCount} tools
        {sub.durationMs ? ` · ${fmtDuration(sub.durationMs)}` : ""}
        {sub.tokens ? ` · ${fmtTokens(sub.tokens)} tok` : ""}
      </span>
      {sub.task && <div className="sx-dispatch-task"><PRText text={sub.task} prBase={prBase} /></div>}
    </div>
  );
}

function clipText(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/**
 * Plain text with `#1234` references linked to the PR. For the non-markdown
 * spots — task lines, event bodies — where the AST-aware remark pass does
 * not apply.
 */
function PRText({ text, prBase }: { text: string; prBase: string | null }) {
  if (!prBase) return <>{text}</>;
  return (
    <>
      {splitPRRefs(text).map((seg, i) =>
        seg.pr != null ? (
          <a key={i} className="sx-pr-link" href={`${prBase}${seg.pr}`} target="_blank" rel="noreferrer">
            {seg.text}
          </a>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

function ToolRow({ call, prBase }: { call: ToolCall; prBase: string | null }) {
  const [open, setOpen] = useState(false);
  const sa = subagentCallOf(call);
  const live = call.status === "running" || call.status === "pending";
  const now = useTicker(live);
  // A still-running call has no `endedAt`, so its elapsed extrapolates to
  // now — that is the whole point of the ticker above.
  const ms = callDurationMs(call) ?? (live ? Math.max(0, now - call.startedAt) : null);
  const sub = sa ? subagentSubtitle(sa) : toolSummary(call);
  const KindIcon = sa ? SUBAGENT_ICON[sa.kind] : KIND_ICON[call.kind];
  const label = sa ? SUBAGENT_KIND_LABEL[sa.kind] : KIND_LABEL[call.kind];

  return (
    <>
      <button
        className={`sx-tool ${call.status}${sa ? " sx-tool-subagent" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`${label} — ${call.title}`}
      >
        <span className="sx-tool-glyph">
          <KindIcon size={13} />
        </span>
        <span className="sx-tool-title">{call.title || label}</span>
        {sub && <span className="sx-tool-sub">{sub}</span>}
        {!sub && <span className="sx-tool-sub" />}
        {ms != null && <span className="sx-tool-dur">{fmtDuration(ms)}</span>}
        <span className={`sx-tool-status ${call.status}`}>
          {call.status === "ok" ? "ok" : call.status === "error" ? "error" : "…"}
        </span>
      </button>

      {open && (
        <div className="sx-tool-detail">
          {sa?.kind === "dispatch" && (
            <div>
              <h4>Dispatched</h4>
              <div className="sx-dispatch-list">
                {(call.subs?.length
                  ? call.subs
                  : sa.tasks.map((t) => ({
                      id: t.name,
                      agent: t.agent,
                      status: "pending" as const,
                      task: t.task,
                      toolCount: 0,
                      tokens: 0,
                      cost: 0,
                      durationMs: 0,
                    }))
                ).map((s) => (
                  <DispatchedLine key={s.id} sub={s} prBase={prBase} />
                ))}
              </div>
              {!call.subs?.length && (
                <p className="sx-dispatch-note">
                  Live progress appears here once omp streams a snapshot — until then this is
                  what was asked of each subagent at spawn time.
                </p>
              )}
            </div>
          )}
          {sa?.kind === "wait" && sa.message && (
            <div>
              <h4>{sa.to ? `Message to ${sa.to}` : "Message"}</h4>
              <pre className="sx-pre">{sa.message}</pre>
            </div>
          )}
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
                (live ? "(still running)" : "(no output recorded)")}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

// -------------------------------------------------------------- subagents

/**
 * The fan-out at a glance: one chip per subagent a run has dispatched, pinned
 * above the stream so "four auditors are running" is visible without reading
 * a hundred tool rows. Collapsed it is one line; expanded it is the roster
 * with each subagent's live progress.
 *
 * The body scrolls rather than grows: a 39-subagent fan-out must not push the
 * transcript off the screen. Clicking a row (or a chip) drills into that
 * subagent — its task, its collected result and the tool timeline rebuilt
 * from the progress snapshots the parent streamed.
 */
function SubagentStrip({
  session,
  roster,
  fanout,
  events,
  prBase,
}: {
  session: Session;
  roster: RosterEntry[];
  fanout: FanoutView | null;
  events: TranscriptEvent[];
  prBase: string | null;
}) {
  const counts = rosterCounts(roster);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Whether the roster can still be moving. omp streams subagent progress only
  // while the parent's turn is running, so a session that is not running has a
  // roster that is a memory — however recently it was written down. Everything
  // below hangs off this: the clock, the counts, and whether an unfinished
  // subagent is described as running or as last seen running.
  const live = rosterIsLive(session.status) && (fanout?.live ?? true);
  const now = useTicker(live && counts.running > 0);
  const unfinished = counts.running + counts.pending;
  const asOf = newestObservation(roster);

  const liveMs = (e: RosterEntry): number | null => {
    if (e.durationMs == null) return null;
    // Extrapolating "duration so far" from a snapshot's age is right for an
    // agent that is still working and a lie for one nobody has heard from
    // since the turn ended — which would tick a finished ten-hour fan-out
    // upwards forever.
    if (!live || (e.status !== "running" && e.status !== "pending")) return e.durationMs;
    return e.durationMs + Math.max(0, now - e.at);
  };

  const pick = (name: string) => {
    setSelected((cur) => (cur === name ? null : name));
    setOpen(true);
  };

  return (
    <div className={`sx-subs${open ? " open" : ""}`}>
      <button className="sx-subs-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon.branch size={12} />
        <span className="sx-subs-label">
          {counts.total} subagent{counts.total === 1 ? "" : "s"}
          {counts.running > 0 &&
            (live ? (
              <span className="sx-subs-running"> · {counts.running} running</span>
            ) : (
              // The whole bug this replaced: a fan-out that finished overnight
              // drawn as "32 running" the next morning, because that was the
              // last frame the turn carried. Say when instead of pretending.
              <span className="sx-subs-stale" title={staleTitle(fanout)}>
                {" "}
                · {counts.running} last seen running
                {asOf !== null && ` at ${fmtClock(asOf)}`}
              </span>
            ))}
          {counts.done > 0 && <span className="sx-subs-done"> · {counts.done} done</span>}
          {counts.failed > 0 && <span className="sx-subs-failed"> · {counts.failed} failed</span>}
        </span>
        <span className="sx-subs-chips">
          {roster.slice(0, 8).map((e) => (
            <button
              key={e.name}
              className={`sx-sub-chip ${e.status}${selected === e.name ? " selected" : ""}`}
              title={e.task ?? e.name}
              onClick={(ev) => {
                ev.stopPropagation();
                pick(e.name);
              }}
            >
              <span className={`sx-sub-dot ${e.status}${live ? "" : " idle"}`} />
              {e.name}
            </button>
          ))}
          {roster.length > 8 && <span className="sx-sub-chip more">+{roster.length - 8}</span>}
        </span>
        <span className="sx-subs-chevron">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="sx-subs-body">
          {!live && unfinished > 0 && (
            <div className="sx-subs-note">{unfinishedNote(unfinished, fanout, asOf)}</div>
          )}
          {roster.map((e) => (
            <Fragment key={e.name}>
              <button
                className={`sx-subs-row ${e.status}${selected === e.name ? " selected" : ""}`}
                aria-expanded={selected === e.name}
                onClick={() => setSelected((cur) => (cur === e.name ? null : e.name))}
                title={e.task ?? e.name}
              >
                <span className={`sx-sub-dot ${e.status}${live ? "" : " idle"}`} />
                <code className="sx-subs-name">{e.name}</code>
                {e.parent && (
                  <span className="sx-subs-agent" title={`dispatched by ${e.parent}, not by this session's agent`}>
                    via {e.parent}
                  </span>
                )}
                {e.agent && <span className="sx-subs-agent">{e.agent}</span>}
                <span className="sx-subs-status">{statusLine(e, live)}</span>
                <span className="sx-subs-meta">
                  {liveMs(e) != null && <span>{fmtDuration(liveMs(e)!)}</span>}
                  {e.toolCount != null && e.toolCount > 0 && <span>{e.toolCount} tools</span>}
                  {e.tokens != null && e.tokens > 0 && <span>{fmtTokens(e.tokens)} tok</span>}
                  {e.cost != null && e.cost > 0 && <span>{fmtCost(e.cost)}</span>}
                </span>
                {e.task && <div className="sx-subs-task"><PRText text={clipText(e.task, 200)} prBase={prBase} /></div>}
              </button>
              {selected === e.name && (
                <SubagentDrilldown
                  sessionId={session.id}
                  name={e.name}
                  events={events}
                  now={now}
                  live={live}
                  prBase={prBase}
                />
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** The newest moment anything described this roster, or null when nothing in
 *  it carries an observation time — a roster recorded before they existed. */
function newestObservation(roster: RosterEntry[]): number | null {
  let newest = 0;
  for (const e of roster) if (e.at > newest) newest = e.at;
  return newest > 0 ? newest : null;
}

/** What one row says about itself, given whether anyone is still listening. */
function statusLine(e: RosterEntry, live: boolean): string {
  if (e.status === "running") {
    if (!live) return "last seen running";
    return e.currentTool
      ? `${e.currentTool}${e.lastIntent ? ` — ${clipText(e.lastIntent, 60)}` : ""}`
      : "running";
  }
  if (e.status === "pending") return live ? "spawned" : "spawned, never started";
  if (e.status === "completed") {
    // A subagent omp disposed of before it wrote a report did not answer, and
    // saying "completed" for that is how three parked agents went unnoticed
    // for a day in a fifty-way run.
    if (e.hasResult === false) return "ended without reporting";
    return e.collected ? "completed · result collected" : "completed";
  }
  return e.status;
}

function staleTitle(fanout: FanoutView | null): string {
  return fanout?.recorded
    ? "The turn that dispatched these has ended, so omp is no longer reporting progress. " +
        "These are the ones omp's own log has no ending for."
    : "The turn that dispatched these has ended, so omp is no longer reporting progress, " +
        "and omp's log for this run could not be found to check how they finished.";
}

function unfinishedNote(unfinished: number, fanout: FanoutView | null, asOf: number | null): string {
  const when = asOf === null ? "when the turn ended" : `at ${fmtClock(asOf)}`;
  return fanout?.recorded
    ? `${unfinished} subagent${unfinished === 1 ? " was" : "s were"} still working ${when}, and omp's ` +
        `log records no ending for ${unfinished === 1 ? "it" : "them"} — ${unfinished === 1 ? "it was" : "they were"} ` +
        `most likely stopped along with the agent that dispatched ${unfinished === 1 ? "it" : "them"}.`
    : `${unfinished} subagent${unfinished === 1 ? " was" : "s were"} still working ${when}. omp's record of ` +
        `this run is not on disk, so there is no way to say what became of ${unfinished === 1 ? "it" : "them"}.`;
}

/**
 * One subagent in full: what it was asked, everything it did, what it returned.
 *
 * Asks omp for its log first. That is the primary source — omp writes one file
 * per subagent with every call, its arguments and its result — and the answer
 * is a transcript rather than an outline. The reconstruction from the parent's
 * progress snapshots is the fallback for when there is no log to read, and it
 * says so on the row rather than passing itself off as the same thing.
 */
function SubagentDrilldown({
  sessionId,
  name,
  events,
  now,
  live,
  prBase,
}: {
  sessionId: string;
  name: string;
  events: TranscriptEvent[];
  now: number;
  live: boolean;
  prBase: string | null;
}) {
  const [record, setRecord] = useState<HubAgentDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unrecorded">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setRecord(null);
    api
      .fanoutAgent(sessionId, name)
      .then((r) => {
        if (cancelled) return;
        setRecord(r);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("unrecorded");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, name]);

  const fallback = useMemo(() => subagentDetail(events, name), [events, name]);

  if (state === "loading") {
    return <div className="sx-subs-detail sx-history">Reading omp's log for {name}…</div>;
  }
  if (state === "ready" && record) {
    return <SubagentRecordView record={record} now={now} live={live} prBase={prBase} />;
  }
  if (!fallback) {
    return (
      <div className="sx-subs-detail sx-history">
        omp has no log for {name}, and this transcript does not describe it either.
      </div>
    );
  }
  return <SubagentDetailView detail={fallback} now={now} prBase={prBase} />;
}

/**
 * A subagent as omp recorded it.
 *
 * Every row here is something omp wrote down — not a reconstruction — so the
 * tool calls carry their real arguments and their real results, and the report
 * is the file the subagent finished with rather than a copy the parent
 * happened to read back.
 */
function SubagentRecordView({
  record,
  now,
  live,
  prBase,
}: {
  record: HubAgentDetail;
  now: number;
  live: boolean;
  prBase: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const running = record.status === "running";
  const elapsed =
    record.endedAt !== null && record.startedAt !== null
      ? record.endedAt - record.startedAt
      : record.startedAt !== null && live && running
        ? Math.max(0, now - record.startedAt)
        : null;
  // A long agent's newest work is what a reader opening it wants; the rest is
  // one click away rather than three thousand rows down the page.
  const steps = showAll ? record.steps : record.steps.slice(-40);
  const hidden = record.steps.length - steps.length;

  return (
    <div className="sx-subs-detail">
      <div className="sx-subs-detail-head">
        <code>{record.name}</code>
        {record.model && <span className="sx-subs-agent">{record.model}</span>}
        <span className={`sx-sub-dot ${record.status}${live ? "" : " idle"}`} />
        <span className="sx-subs-detail-status">
          {running && !live ? "last seen running" : record.status}
          {elapsed !== null && ` · ${fmtDuration(elapsed)}`}
          {record.toolCount > 0 && ` · ${record.toolCount} tools`}
          {record.tokens > 0 && ` · ${fmtTokens(record.tokens)} tok`}
          {record.cost > 0 && ` · ${fmtCost(record.cost)}`}
          {record.endedAt !== null && ` · ended ${fmtClock(record.endedAt)}`}
        </span>
      </div>

      {record.task && (
        <div className="sx-subs-detail-task">
          <PRText text={record.task} prBase={prBase} />
        </div>
      )}

      {record.result !== null ? (
        <div>
          <h4>{record.status === "failed" ? "Report (ended abnormally)" : "Report"}</h4>
          <pre className="sx-pre">{record.result || "(empty report)"}</pre>
        </div>
      ) : (
        !running && (
          <div className="sx-subs-note">
            This subagent ended without writing a report — omp disposed of it before it answered.
          </div>
        )
      )}

      <div>
        <h4>
          Activity — {record.steps.length} step{record.steps.length === 1 ? "" : "s"} from omp's log
          {record.truncated && " (clipped)"}
        </h4>
        {hidden > 0 && (
          <button className="sx-history sx-subs-more" onClick={() => setShowAll(true)}>
            Show {hidden} earlier step{hidden === 1 ? "" : "s"}
          </button>
        )}
        {steps.map((step, i) => (
          <div key={`${step.ts}-${i}`} className={`sx-sub-step ${step.kind}`}>
            <span className="sx-sub-step-t">{fmtClock(step.ts)}</span>
            {step.kind === "tool" ? (
              <>
                <span className="sx-sub-step-tool">{step.tool}</span>
                <span className="sx-sub-step-args">
                  {step.intent ?? step.args ?? ""}
                  {step.intent && step.args ? ` — ${step.args}` : ""}
                </span>
                {step.output && <div className="sx-sub-step-out">{step.output}</div>}
              </>
            ) : (
              <span className="sx-sub-step-said">
                <PRText text={step.text ?? ""} prBase={prBase} />
              </span>
            )}
          </div>
        ))}
        {record.steps.length === 0 && (
          <div className="sx-history">omp's log for this subagent records no steps yet.</div>
        )}
      </div>
    </div>
  );
}

/**
 * The drilldown: what this one subagent was asked, what it did, and what it
 * came back with. The steps are reconstructed from snapshot deltas, so they
 * are "tools observed completing", not a verbatim transcript — the header
 * says so rather than overpromising.
 */
function SubagentDetailView({
  detail,
  now,
  prBase,
}: {
  detail: SubagentDetail;
  now: number;
  prBase: string | null;
}) {
  const t0 = detail.startedTs;
  const live = detail.status === "running" || detail.status === "pending";

  return (
    <div className="sx-subs-detail">
      <div className="sx-subs-detail-head">
        <code>{detail.name}</code>
        {detail.agent && <span className="sx-subs-agent">{detail.agent}</span>}
        <span className={`sx-sub-dot ${detail.status}`} />
        <span className="sx-subs-detail-status">
          {detail.status}
          {live && detail.durationMs > 0 && ` · ${fmtDuration(detail.durationMs + Math.max(0, now - detail.lastTs))}`}
          {!live && detail.durationMs > 0 && ` · ${fmtDuration(detail.durationMs)}`}
          {detail.toolCount > 0 && ` · ${detail.toolCount} tools`}
          {detail.tokens > 0 && ` · ${fmtTokens(detail.tokens)} tok`}
          {detail.cost > 0 && ` · ${fmtCost(detail.cost)}`}
        </span>
      </div>

      {detail.task && <div className="sx-subs-detail-task"><PRText text={detail.task} prBase={prBase} /></div>}

      {detail.result != null && (
        <div>
          <h4>{detail.resultError ? "Result (errored)" : "Result"}</h4>
          <pre className="sx-pre">{detail.result || "(empty result)"}</pre>
        </div>
      )}

      <div>
        <h4>
          Activity — {detail.steps.length} tool call{detail.steps.length === 1 ? "" : "s"} seen
        </h4>
        {detail.steps.length === 0 && live && detail.currentTool && (
          <div className="sx-sub-step live">
            <span className="sx-sub-step-t">now</span>
            <span
              className="sx-sub-step-tool"
              title={detail.currentTool === "hub" && !detail.currentToolArgs ? HUB_STEP_HINT : undefined}
            >
              {subagentStepLabel({ tool: detail.currentTool, args: detail.currentToolArgs })}
            </span>
            <span className="sx-sub-step-args">
              {detail.lastIntent ?? detail.currentToolArgs ?? ""}
            </span>
          </div>
        )}
        {detail.steps.length > 0 && (
          <div className="sx-sub-steps">
            {detail.steps.map((s, i) => (
              <div
                key={i}
                className="sx-sub-step"
                title={s.args ?? (s.tool === "hub" ? HUB_STEP_HINT : s.tool)}
              >
                <span className="sx-sub-step-t">+{fmtDuration(Math.max(0, s.ts - t0))}</span>
                <span className="sx-sub-step-tool">{subagentStepLabel(s)}</span>
                <span className="sx-sub-step-args">{clipText(s.args ?? "", 160)}</span>
              </div>
            ))}
            {live && detail.currentTool && (
              <div className="sx-sub-step live">
                <span className="sx-sub-step-t">now</span>
                <span
                  className="sx-sub-step-tool"
                  title={detail.currentTool === "hub" && !detail.currentToolArgs ? HUB_STEP_HINT : undefined}
                >
                  {subagentStepLabel({ tool: detail.currentTool, args: detail.currentToolArgs })}
                </span>
                <span className="sx-sub-step-args">
                  {detail.lastIntent ?? detail.currentToolArgs ?? ""}
                </span>
              </div>
            )}
          </div>
        )}
        {detail.steps.length === 0 && !detail.currentTool && (
          <p className="sx-subs-detail-note">
            No tool activity recorded yet — progress snapshots carry the last few calls each
            time they stream, so this fills in as the subagent works.
          </p>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- other rows

/**
 * A verdict is the watcher talking *about* the session, not into it — only the
 * `nudge` reaches the agent, and it arrives as its own message block right
 * below. So this renders as a margin note rather than a conversation block:
 * no panel, dashed rule, and `ok` folded to a single line, because an `ok` is
 * the supervisor deciding to stay out of the way.
 */
function SupervisorRow({ verdict }: { verdict: SupervisorVerdict }) {
  const [open, setOpen] = useState(false);
  const quiet = verdict.state === "ok";

  return (
    <div className={`sx-note verdict-${verdict.state}`}>
      <button className="sx-note-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon.eye size={12} />
        <span className="sx-note-label">
          supervisor · {verdict.state} · {verdict.source} · at call {verdict.atToolCall}
        </span>
        {quiet && <span className="sx-note-peek">{verdict.reason}</span>}
        <span className="sx-note-chevron">{open ? "−" : "+"}</span>
      </button>

      {!quiet && <div className="sx-note-body">{verdict.reason}</div>}

      {open && (
        <div className="sx-note-body sx-note-aside">
          {quiet && <p>{verdict.reason}</p>}
          <p>
            {verdict.state === "nudge"
              ? "Not part of the conversation — but it did steer the agent; the nudge it sent is the message below."
              : "Not part of the conversation. Nothing was sent to the agent; it kept working undisturbed."}
          </p>
        </div>
      )}
    </div>
  );
}

function EventRow({
  event,
  prBase,
  session,
  failedPrompts,
  queuedPrompts,
}: {
  event: TranscriptEvent;
  prBase: string | null;
  session: Session;
  failedPrompts: Set<number>;
  queuedPrompts: Set<number>;
}) {
  switch (event.type) {
    case "assistant":
      // Merged into a `prose` row by groupEvents; never reaches here.
      return null;

    case "user": {
      // Neither a supervisor nudge nor an auto-continue is the human talking
      // — the agent was steered by a machine, and reading either as the same
      // thing as the human hides that.
      const retry =
        event.from === "human" && failedPrompts.has(event.seq) && canSteer(session.status);
      return (
        <div className={`sx-block ${event.from === "human" ? "human" : "supervisor-msg"}`}>
          <div className="sx-block-head">
            <span>{event.from === "human" ? "You" : event.from === "auto" ? "Auto-continue" : "Supervisor nudge"}</span>
            {queuedPrompts.has(event.seq) && (
              <span
                className="sx-queued"
                title="Sent while the agent was mid-turn. It reaches the agent after its current tool call, or when its turn ends."
              >
                queued · not seen yet
              </span>
            )}
            {retry && <RetryPrompt session={session} text={event.text} />}
          </div>
          <div className="sx-block-body"><PRText text={event.text} prBase={prBase} /></div>
        </div>
      );
    }

    case "advisory":
      return (
        <div className={`sx-block advisory-${event.severity}`}>
          <div className="sx-block-head">Advisor · {event.severity}</div>
          <div className="sx-block-body"><PRText text={event.text} prBase={prBase} /></div>
        </div>
      );

    case "supervisor":
      return <SupervisorRow verdict={event.verdict} />;

    case "permission":
      return (
        <div className="sx-block permission">
          <div className="sx-block-head">
            Permission ·{" "}
            {event.approved === null ? "awaiting you" : event.approved ? "approved" : "denied"}
          </div>
          <div className="sx-block-body"><PRText text={event.title} prBase={prBase} /></div>
        </div>
      );

    case "turn":
      return <div className="sx-turn">turn ended · {event.stopReason}</div>;

    case "error":
      return (
        <div className="sx-block error">
          <div className="sx-block-head">Error</div>
          <div className="sx-block-body"><PRText text={event.message} prBase={prBase} /></div>
        </div>
      );

    case "tool":
      // Grouped into runs by groupEvents; never reaches here.
      return null;

    case "delivered":
      // Read by the `user` row it names; groupEvents drops it.
      return null;
  }
}

/**
 * Re-send a prompt whose turn never got an answer — the one-click recovery
 * for a prompt a dead provider silently ate. Re-sends the exact text as a new
 * message rather than trying to unwind history: omp's conversation has already
 * recorded the failed exchange, and the model never saw a working prompt.
 */
function RetryPrompt({ session, text }: { session: Session; text: string }) {
  const { run, busy, error } = useAction();
  return (
    <span className="sx-retry-wrap">
      {error && <span className="sx-retry-error">not sent: {error}</span>}
      <button
        className="sx-retry"
        disabled={busy}
        title="Send this prompt again — its turn failed without an answer"
        onClick={() => void run(() => api.sendMessage(session.id, text))}
      >
        <Icon.refresh size={11} />
        {busy ? "Sending…" : "Retry"}
      </button>
    </span>
  );
}
