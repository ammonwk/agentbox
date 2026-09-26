import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session, TimelineEvent } from "../../../../src/core/types";
import { fmtClock, useTimeline } from "../../api";
import { Button, Empty, Icon, Spinner } from "../../components";
import { firstLine, groupTimeline } from "../../lib/timeline";
import { Markdown } from "./Markdown";
import { anchoredScrollTop, isAtTop, isPinnedToBottom, shouldAutoScroll } from "./scroll";
import { ECHO_TTL_MS, landed, onEcho, type Echo } from "./echo";

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;

/**
 * The conversation as the provider's transcript records it, folded into
 * provider-neutral events. Newest at the bottom; scrolling to the top pages
 * older history in, anchored so the reader does not lose their place.
 */
export function Timeline({ session }: { session: Session }) {
  const { events, ready, loadingOlder, exhausted, error, loadOlder } = useTimeline(session.id);
  const rows = useMemo(() => groupTimeline(events), [events]);
  const echoes = useEchoes(session.id, events);

  const boxRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const prev = useRef({ count: 0, firstId: "", scrollTop: 0, scrollHeight: 0, initial: true });

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || events.length === 0) return;
    const p = prev.current;
    const firstId = events[0].id;
    if (!p.initial && p.firstId && firstId !== p.firstId && events.length > p.count) {
      // Older history landed above the reader: hold their place.
      el.scrollTop = anchoredScrollTop(p, el);
    } else if (shouldAutoScroll({ wasPinned: pinned, grew: events.length >= p.count, initial: p.initial })) {
      el.scrollTop = el.scrollHeight;
    }
    prev.current = { count: events.length, firstId, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, initial: false };
  }, [events, pinned, echoes.length]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    prev.current.scrollTop = el.scrollTop;
    prev.current.scrollHeight = el.scrollHeight;
    const nowPinned = isPinnedToBottom(el);
    if (nowPinned !== pinned) setPinned(nowPinned);
    if (isAtTop(el) && !exhausted && !loadingOlder) loadOlder();
  };

  if (!ready) {
    return (
      <div className="sx-panel">
        <Empty title="Reading the transcript…" />
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="sx-panel">
        <Empty title="Nothing in the transcript yet">
          {session.agentSessionId
            ? "The provider has not written anything for this session. Messages and tool calls appear here as they land."
            : "The provider has not told us its session id yet, so there is no transcript to read. It usually appears within a few seconds of starting."}
        </Empty>
      </div>
    );
  }

  return (
    <div className="tl-wrap">
      <div className="sx-panel tl" ref={boxRef} onScroll={onScroll} tabIndex={0} aria-label="Timeline">
        <div className="tl-edge" role="status">
          {loadingOlder ? (
            <>
              <Spinner size={12} /> Loading earlier events…
            </>
          ) : error ? (
            <>
              Could not load earlier events: {error}{" "}
              <button className="linkish" onClick={loadOlder}>
                retry
              </button>
            </>
          ) : exhausted ? (
            "Start of the conversation"
          ) : (
            <button className="linkish" onClick={loadOlder}>
              Load earlier
            </button>
          )}
        </div>
        <div className="tl-stream">
          {rows.map((r) =>
            r.type === "tools" ? <ToolRun key={r.id} events={r.events} /> : <EventRow key={r.event.id} ev={r.event} />,
          )}
          {echoes.map((e) => (
            <div key={e.at} className="tl-user tl-echo" title="Sent; the agent has not recorded it yet">
              <div className="tl-who">
                <Icon.user size={13} /> You <span className="faint">· sending…</span>
              </div>
              <Markdown text={e.text} />
            </div>
          ))}
        </div>
      </div>
      {!pinned ? (
        <div className="tl-jump">
          <Button
            size="sm"
            icon={Icon.arrowDown}
            onClick={() => {
              const el = boxRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setPinned(true);
            }}
          >
            Latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Messages sent from here that the transcript has not caught up with. */
function useEchoes(sessionId: string, events: readonly TimelineEvent[]): Echo[] {
  const [sent, setSent] = useState<Echo[]>([]);
  useEffect(() => onEcho((e) => e.sessionId === sessionId && setSent((xs) => [...xs, e])), [sessionId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (sent.length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [sent.length]);
  const users = useMemo(() => events.filter((e): e is Extract<TimelineEvent, { kind: "user" }> => e.kind === "user").slice(-20), [events]);
  const live = sent.filter((e) => Date.now() - e.at < ECHO_TTL_MS && !landed(e, users));
  useEffect(() => {
    if (live.length !== sent.length) setSent(live);
  });
  return live;
}

const EventRow = memo(function EventRow({ ev }: { ev: Exclude<TimelineEvent, ToolEvent> }) {
  switch (ev.kind) {
    case "user":
      return (
        <div className="tl-user" title={fmtClock(ev.at)}>
          <div className="tl-who">
            <Icon.user size={13} /> You
            {ev.images ? <span className="faint"> · {ev.images} image{ev.images === 1 ? "" : "s"}</span> : null}
            <time className="tl-time">{fmtClock(ev.at)}</time>
          </div>
          <Markdown text={ev.text} />
        </div>
      );
    case "assistant":
      return (
        <div className="tl-assistant" title={fmtClock(ev.at)}>
          <Markdown text={ev.text} />
        </div>
      );
    case "thinking":
      return <Thinking text={ev.text} at={ev.at} />;
    case "meta":
      return (
        <div className={`tl-meta tone-${ev.tone ?? "info"}`} title={fmtClock(ev.at)}>
          {ev.tone === "warn" || ev.tone === "error" ? <Icon.alert size={12} /> : null}
          <span>{ev.text}</span>
        </div>
      );
  }
});

function Thinking({ text, at }: { text: string; at: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tl-thinking">
      <button className="tl-thinking-head" aria-expanded={open} onClick={() => setOpen(!open)} title={fmtClock(at)}>
        <Icon.brain size={13} />
        <span className="tl-thinking-label">Thinking</span>
        {!open ? <span className="tl-thinking-peek">{firstLine(text)}</span> : null}
        <Icon.chevronDown size={12} className={open ? "rot" : undefined} />
      </button>
      {open ? <div className="tl-thinking-body">{text}</div> : null}
    </div>
  );
}

function ToolRun({ events }: { events: ToolEvent[] }) {
  return (
    <div className="sx-run">
      {events.map((e) => (
        <ToolRow key={e.id} ev={e} />
      ))}
    </div>
  );
}

const ToolRow = memo(function ToolRow({ ev }: { ev: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(ev.input || ev.output);
  return (
    <>
      <button
        className={`sx-tool ${ev.status}`}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        title={fmtClock(ev.at)}
      >
        <span className="sx-tool-glyph" aria-hidden="true">
          {ev.status === "running" ? <Spinner size={11} /> : ev.status === "error" ? <Icon.x size={13} /> : <Icon.check size={13} />}
        </span>
        <span className="sx-tool-title">{ev.name}</span>
        <span className="sx-tool-sub">{ev.summary}</span>
        <span className={`sx-tool-status ${ev.status}`}>{ev.status === "running" ? "running" : ev.status === "error" ? "error" : ""}</span>
        {hasDetail ? <Icon.chevronDown size={12} className={open ? "rot" : undefined} /> : null}
      </button>
      {open && hasDetail ? (
        <div className="sx-tool-detail">
          {ev.input ? (
            <div>
              <h4>Input</h4>
              <pre className="sx-pre">{ev.input}</pre>
            </div>
          ) : null}
          {ev.output ? (
            <div>
              <h4>{ev.status === "error" ? "Error" : "Output"}</h4>
              <pre className="sx-pre">{ev.output}</pre>
            </div>
          ) : ev.status === "running" ? (
            <p className="faint">No result yet — it is still running.</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
});
