/** What the session waits on, in one quiet row above its composer: the
 *  sessions it started that still run (subagents, teammates), the agents it
 *  started inside itself, and its background shells and monitors. The
 *  terminal shows these too; this is so the timeline does. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, useNow, type SessionWork } from "../../api";
import { StatusDot } from "../../bits";
import { Icon } from "../../components";
import { titleOf, type SessionRow } from "../../lib/board";
import { fmtCountdown } from "../../lib/format";
import { hrefOf } from "../../route";

/** How often the open session's shells and agents are read again. */
const POLL_MS = 3_000;

export function WorkStrip({ session, sessions }: { session: SessionRow; sessions: readonly SessionRow[] }) {
  const work = useWork(session);
  const now = useNow(10_000);
  const kids = useMemo(
    () => sessions.filter((s) => s.parent === session.id && (s.status === "running" || s.status === "blocked")),
    [sessions, session.id],
  );
  const shells = work?.shells ?? [];
  const agents = work?.agents ?? [];
  // Chips past the right edge: the row fades out there until it is scrolled to its end.
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = row.current;
    setMore(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  useLayoutEffect(measure, [kids, shells, agents]);
  if (kids.length + shells.length + agents.length === 0) return null;
  const age = (since: number | null) => (since ? <span className="wk-age">{fmtCountdown(now - since)}</span> : null);
  return (
    <div className="wk" role="status" aria-label="What it waits on">
      <div className="wk-row" ref={row} data-more={more || undefined} onScroll={measure}>
        {kids.map((k) => (
          <a key={k.id} className="wk-chip" href={hrefOf({ page: "session", id: k.id, tab: "timeline" })} title={`Open ${titleOf(k)}`}>
            <StatusDot status={k.status} />
            <span className="wk-name">{k.subagent?.name ?? titleOf(k)}</span>
            {age(k.lastPromptAt)}
          </a>
        ))}
        {agents.map((a) => (
          <span key={a.id} className="wk-chip" title={`${a.background ? "Background agent" : "Agent"}: ${a.description}`}>
            <span className="wk-pulse" aria-hidden="true" />
            <span className="wk-kind">{a.name ?? "agent"}</span>
            <span className="wk-name">{a.description}</span>
            {age(a.since)}
          </span>
        ))}
        {shells.map((sh) => (
          <span key={sh.pid} className="wk-chip" title={sh.command}>
            {sh.monitor ? <Icon.gauge size={12} /> : <Icon.terminal size={12} />}
            <span className="wk-kind">{sh.monitor ? "monitor" : sh.kind === "service" ? "server" : "shell"}</span>
            <span className="wk-name">{sh.label}</span>
            {age(sh.since)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The open session's shells and agents, read every POLL_MS while it has a
 * process and the page is in view. Null until the first read, and for good
 * when the server has no such route (one started before it existed).
 */
function useWork(session: SessionRow): SessionWork | null {
  const [work, setWork] = useState<SessionWork | null>(null);
  const live = session.host === "tmux" || session.host === "external";
  useEffect(() => {
    setWork(null);
    if (!live) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (document.visibilityState === "visible") {
        try {
          const w = await api.work(session.id);
          if (stop) return;
          setWork((old) => (JSON.stringify(old) === JSON.stringify(w) ? old : w));
        } catch {
          // An older server, or the mock: no shells or agents to show.
          return;
        }
      }
      if (!stop) t = setTimeout(read, POLL_MS);
    };
    void read();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [session.id, live]);
  return work;
}
