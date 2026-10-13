/** One of the agents a session runs inside itself — a Task or a workflow's
 *  agent, which has no session of its own — read live from its own
 *  transcript. The work strip's list opens it. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TimelineEvent } from "../../../../src/core/types";
import { api, useNow, type AgentTimeline } from "../../api";
import { Empty, Icon, Modal, Spinner } from "../../components";
import { fmtCountdown } from "../../lib/format";
import { mergeTimeline } from "../../lib/timeline";
import { AgentSteps } from "./Timeline";
import { isPinnedToBottom } from "./scroll";
import "./agentview.css";

/** How often a running agent's transcript is read again. */
const POLL_MS = 3_000;

export interface OpenAgent {
  id: string;
  /** Its name or phase, else "agent". */
  kind: string;
  /** What it was asked to do, in a few words. */
  name: string;
  since: number | null;
  /** Who asked it, as its first message says. */
  from: string;
}

export function AgentView({ sessionId, agent, onClose }: { sessionId: string; agent: OpenAgent; onClose: () => void }) {
  const { events, state, more, error } = useAgentTimeline(sessionId, agent.id);
  const now = useNow(10_000);
  const boxRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the newest step while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <Modal title={agent.name || agent.kind} onClose={onClose} wide>
      <div className="agv">
        <p className="agv-state" data-state={state ?? "reading"} role="status">
          {state === "running" ? (
            <span className="wk-pulse" aria-hidden="true" />
          ) : state === "done" ? (
            <Icon.check size={13} />
          ) : state === "stopped" ? (
            <Icon.stop size={13} />
          ) : (
            <Spinner size={12} />
          )}
          <span className="agv-kind">{agent.kind}</span>
          <span>
            {state === "running"
              ? `Working${agent.since ? ` for ${fmtCountdown(now - agent.since)}` : ""}`
              : state === "done"
                ? "Finished"
                : state === "stopped"
                  ? "Stopped before it finished"
                  : "Reading its transcript…"}
          </span>
        </p>
        <div
          ref={boxRef}
          className="agv-body"
          tabIndex={0}
          aria-label="What the agent did"
          onScroll={(e) => {
            pinned.current = isPinnedToBottom(e.currentTarget);
          }}
        >
          {error ? <p className="error-line">Could not read the agent: {error}</p> : null}
          {more ? <div className="tl-edge">Earlier steps are not shown</div> : null}
          {events.length ? (
            <AgentSteps events={events} live={state === "running"} from={agent.from} />
          ) : state ? (
            <Empty title="Nothing in its transcript yet" />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The agent's events: the newest page, then what came after it every
 * POLL_MS while it runs and the page is in view. A finished or stopped agent
 * writes nothing more, so it is read once.
 */
function useAgentTimeline(sessionId: string, agentId: string) {
  const [st, setSt] = useState<{ events: readonly TimelineEvent[]; state: AgentTimeline["state"] | null; more: boolean; error: string | null }>({
    events: [],
    state: null,
    more: false,
    error: null,
  });
  useEffect(() => {
    let stop = false;
    let cursor: string | null = null;
    let held: readonly TimelineEvent[] = [];
    let t: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let state: AgentTimeline["state"] | null = null;
      if (document.visibilityState === "visible") {
        try {
          const r = await api.agentTimeline(sessionId, agentId, cursor);
          if (stop) return;
          held = mergeTimeline(r.reset ? [] : held, r.events);
          cursor = r.cursor;
          state = r.state;
          setSt((s) => ({ events: held, state: r.state, more: r.reset ? r.more : s.more, error: null }));
        } catch (e) {
          if (stop) return;
          setSt((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
        }
      }
      if (!stop && state !== "done" && state !== "stopped") t = setTimeout(read, POLL_MS);
    };
    void read();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [sessionId, agentId]);
  return st;
}
