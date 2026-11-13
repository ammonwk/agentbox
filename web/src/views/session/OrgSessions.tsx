/** The other members' live org sessions (docs/org.md): read-only rows. A
 *  click reads one's conversation from its member's machine. */

import { useEffect, useState, type CSSProperties } from "react";
import type { OrgSessionView, OrgStatus, TimelineEvent } from "../../../../src/core/types";
import { api } from "../../api";
import { copyText, ProviderBadge } from "../../bits";
import { Button, Empty, Icon, Modal, Spinner } from "../../components";
import { AgentSteps } from "./Timeline";
import "./agentview.css";

const OPEN_KEY = "agentbox.org.open";

function readOpen(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Folded to one line per member until opened, so a member with dozens of
 *  sessions does not bury the others'; a search opens them all. */
export function OrgSessions({ org, query }: { org: OrgStatus; query: string }) {
  const [open, setOpen] = useState<OrgSessionView | null>(null);
  const [shown, setShown] = useState(readOpen);
  const q = query.trim().toLowerCase();
  const rows = org.sessions.filter((s) => !q || `${s.title} ${s.person} ${s.repo ?? ""} ${s.branch ?? ""}`.toLowerCase().includes(q));
  if (!rows.length) return null;
  const people = new Map<string, OrgSessionView[]>();
  for (const s of rows) people.set(s.person, [...(people.get(s.person) ?? []), s]);
  const toggle = (person: string) => {
    const next = new Set(shown);
    if (!next.delete(person)) next.add(person);
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    setShown(next);
  };
  return (
    <div className="rail-sec" data-kind="org">
      <div className="rail-label" title={`${org.name}'s org sessions on other members' machines`}>
        {org.name} <span>{rows.length}</span>
      </div>
      {[...people].map(([person, theirs]) => {
        const unfolded = !!q || shown.has(person);
        const away = theirs.every((s) => s.away);
        return (
          <div key={person}>
            <button
              type="button"
              className="rail-row rail-org rail-org-person"
              aria-expanded={unfolded}
              data-away={away || undefined}
              title={`${unfolded ? "Hide" : "Show"} ${person}'s org sessions${away ? " (not heard from lately)" : ""}`}
              onClick={() => toggle(person)}
              disabled={!!q}
            >
              <Icon.chevronRight size={10} className="rail-quiet-chev" />
              <span className="rail-text">
                <span className="rail-title">{person}</span>
              </span>
              <span className="rail-org-count">{theirs.length}</span>
            </button>
            {unfolded
              ? theirs.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="rail-row rail-org"
                    data-depth
                    style={{ "--depth": 1 } as CSSProperties}
                    data-away={s.away || undefined}
                    title={[
                      s.title,
                      `${s.person} on ${s.machine}${s.away ? ", not heard from lately" : ""}`,
                      [s.repo, s.branch].filter(Boolean).join(" @ "),
                      s.account ? `on ${s.account}` : "",
                      s.prs.length ? `holds ${s.prs.join(", ")}` : "",
                      `${s.status} · ${s.id}: click to read it`,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                    onClick={() => setOpen(s)}
                  >
                    <ProviderBadge provider={s.provider} short />
                    <span className="rail-text">
                      <span className="rail-title">{s.title}</span>
                    </span>
                    {s.away ? <span className="rail-when">away</span> : null}
                  </button>
                ))
              : null}
          </div>
        );
      })}
      {open ? <OrgConversation session={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** One org session's conversation, read from its member's machine through the
 *  org's store: a request that machine answers within seconds while it is on. */
function OrgConversation({ session: s, onClose }: { session: OrgSessionView; onClose: () => void }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.orgConversation(s.id).then(
      (r) =>
        live &&
        setEvents(
          r.events.map((e, i): TimelineEvent =>
            e.kind === "tool" ? { id: `${i}`, at: e.at, kind: "tool", name: e.name, summary: e.summary, status: "ok" } : { id: `${i}`, at: e.at, kind: e.kind, text: e.text },
          ),
        ),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [s.id]);
  return (
    <Modal title={s.title || s.id} hint={`${s.person}'s session on ${s.machine}${s.prs.length ? ` · holds ${s.prs.join(", ")}` : ""}`} onClose={onClose} wide>
      <div className="agv">
        <p className="agv-state" role="status">
          {events || error ? null : <Spinner size={12} />}
          <span className="agv-kind">{s.status}</span>
          <span>{error ? "" : events ? "Read from its machine just now" : `Asking ${s.machine} for it…`}</span>
          <Button size="sm" icon={Icon.copy} onClick={() => void copyText(s.id)} title="Its id, for agentbox send">
            {s.id}
          </Button>
        </p>
        <div className="agv-body" tabIndex={0} aria-label="What the session said and did">
          {error ? <p className="error-line">Could not read it: {error}</p> : null}
          {events?.length ? <AgentSteps events={events} live={false} from={s.person} /> : events ? <Empty title="Nothing in its transcript yet" /> : null}
        </div>
      </div>
    </Modal>
  );
}
