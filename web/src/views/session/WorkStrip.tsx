/** What the session waits on — the sessions it started that still run
 *  (subagents, teammates), its workflows and the agents each runs now, the
 *  agents it started inside itself, its background shells and monitors — as
 *  a small tab on the composer, and a list that rises from the tab while
 *  you point at it. The terminal shows these too; this is so the timeline
 *  does. A subagent's row goes to its session; an agent's opens what it is
 *  doing (AgentView.tsx). */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, useNow, type SessionWork } from "../../api";
import { StatusDot } from "../../bits";
import { Icon } from "../../components";
import { titleOf, type SessionRow } from "../../lib/board";
import { fmtCountdown } from "../../lib/format";
import { hrefOf } from "../../route";
import { AgentView, type OpenAgent } from "./AgentView";

/** How often the open session's shells and agents are read again. */
const POLL_MS = 3_000;

export function WorkStrip({ session, sessions }: { session: SessionRow; sessions: readonly SessionRow[] }) {
  const work = useWork(session);
  const now = useNow(10_000);
  // Pinned open by a click or a tap; pointing at the tab opens it too.
  const [pinned, setPinned] = useState(false);
  /** The agent whose view is open: kept as it was clicked, so the view
   *  stays when the agent ends and leaves the list. */
  const [open, setOpen] = useState<OpenAgent | null>(null);
  const kids = useMemo(
    () => sessions.filter((s) => s.parent === session.id && (s.status === "running" || s.status === "blocked")),
    [sessions, session.id],
  );
  const shells = work?.shells ?? [];
  const agents = work?.agents ?? [];
  const workflows = work?.workflows ?? [];
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPinned(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [pinned]);
  const total = kids.length + workflows.length + agents.length + shells.length;
  const view = open ? <AgentView sessionId={session.id} agent={open} onClose={() => setOpen(null)} /> : null;
  if (total === 0) return view;

  const monitors = shells.filter((s) => s.monitor).length;
  const summary = [
    count(kids.length, "subagent"),
    count(workflows.length, "workflow"),
    count(agents.length, "agent"),
    count(shells.length - monitors, "shell"),
    count(monitors, "monitor"),
  ]
    .filter(Boolean)
    .join(" · ");
  const age = (since: number | null) => (since ? <span className="wk-age">{fmtCountdown(now - since)}</span> : null);

  // Beside the strip, not in it: the strip lets the pointer through and
  // stacks under the page's own layers.
  return (
    <>
    {view}
    <div className="wk" data-open={pinned || undefined}>
      <div className="wk-col">
      <div className="wk-pop">
      <div className="wk-list" role="region" aria-label="What it waits on">
        {kids.map((k) => (
          <Row
            key={k.id}
            href={hrefOf({ page: "session", id: k.id, tab: "timeline" })}
            mark={<StatusDot status={k.status} />}
            kind="subagent"
            name={k.subagent?.name ?? titleOf(k)}
            age={age(k.lastPromptAt)}
            title={`Open ${titleOf(k)}`}
          />
        ))}
        {workflows.map((w) => (
          <div key={w.runId} className="wk-group">
            <Row mark={<span className="wk-pulse" aria-hidden="true" />} kind="workflow" name={w.name} age={age(w.since)} />
            {w.agents.map((a) => (
              <Row
                key={a.id}
                sub
                mark={<span className="wk-tick" aria-hidden="true" />}
                kind={a.phase ?? "agent"}
                name={a.label}
                title={`Show what ${a.label || "it"} is doing`}
                onOpen={() => setOpen({ id: a.id, kind: a.phase ?? "agent", name: a.label, since: null, from: `Workflow ${w.name}` })}
              />
            ))}
          </div>
        ))}
        {agents.map((a) => (
          <Row
            key={a.id}
            mark={<span className="wk-pulse" aria-hidden="true" />}
            kind={a.name ?? "agent"}
            name={a.description}
            age={age(a.since)}
            title={`${a.background ? "Background agent" : "Agent"}: ${a.description} — show what it is doing`}
            onOpen={() => setOpen({ id: a.id, kind: a.name ?? "agent", name: a.description, since: a.since, from: "This session" })}
          />
        ))}
        {shells.map((sh) => (
          <Row
            key={sh.pid}
            mark={sh.monitor ? <Icon.gauge size={12} /> : <Icon.terminal size={12} />}
            kind={sh.monitor ? "monitor" : sh.kind === "service" ? "server" : "shell"}
            name={sh.label}
            age={age(sh.since)}
            title={sh.command}
          />
        ))}
      </div>
      </div>
      <button
        type="button"
        className="wk-tab"
        aria-expanded={pinned}
        title={pinned ? "Hide (Esc)" : "Show what it waits on"}
        onClick={() => setPinned(!pinned)}
      >
        <span className="wk-pulse" aria-hidden="true" />
        {summary}
      </button>
      </div>
    </div>
    </>
  );
}

function count(n: number, word: string): string | null {
  return n ? `${n} ${word}${n === 1 ? "" : "s"}` : null;
}

function Row({
  href,
  onOpen,
  mark,
  kind,
  name,
  age,
  title,
  sub,
}: {
  href?: string;
  onOpen?: () => void;
  mark: ReactNode;
  kind: string;
  name: string;
  age?: ReactNode;
  title?: string;
  sub?: boolean;
}) {
  const body = (
    <>
      <span className="wk-mark">{mark}</span>
      <span className="wk-kind">{kind}</span>
      <span className="wk-name">{name}</span>
      {age}
    </>
  );
  const cls = `wk-item${sub ? " is-sub" : ""}`;
  return href ? (
    <a className={cls} href={href} title={title}>
      {body}
    </a>
  ) : onOpen ? (
    <button type="button" className={cls} title={title} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
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
