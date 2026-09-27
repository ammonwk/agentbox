import { createContext, useContext, useMemo } from "react";
import type { SessionStatus } from "../../../../src/core/types";
import { StatusDot } from "../../bits";
import { Icon } from "../../components";
import { titleOf, type SessionRow } from "../../lib/board";
import { hrefOf, type SessionTab } from "../../route";

/**
 * The sessions around the open one: the session that started it, the ones it
 * started, and the ones started beside it — a Claude agent team's lead and
 * teammates, or a `codex exec` run and the session it ran under. On a wide
 * screen the list beside the session shows them as a tree; on a phone that
 * list is a page of its own, so the strip below does it instead, and the
 * timeline links each teammate message to the session that sent it.
 */
export interface Family {
  parent: SessionRow | null;
  kids: SessionRow[];
  /** A teammate's name (its session's title or label) to its session; `team-lead` is the parent. */
  byName: Map<string, SessionRow>;
  /** Links keep the tab you are on. */
  tab: SessionTab;
}

const NO_FAMILY: Family = { parent: null, kids: [], byName: new Map(), tab: "timeline" };
export const FamilyContext = createContext<Family>(NO_FAMILY);
export const useFamily = () => useContext(FamilyContext);

/** Needing you first, then working, then the rest; newest first within each. */
const RANK: Record<SessionStatus, number> = { blocked: 0, running: 1, waiting: 2, stopped: 3, closed: 4 };

export function useFamilyOf(session: SessionRow, sessions: readonly SessionRow[], tab: SessionTab): Family {
  return useMemo(() => {
    const parent = session.parent ? sessions.find((s) => s.id === session.parent) ?? null : null;
    const kids = sessions
      .filter((s) => s.parent === session.id && s.status !== "closed")
      .sort((a, b) => RANK[a.status] - RANK[b.status] || b.lastActivityAt - a.lastActivityAt);
    const byName = new Map<string, SessionRow>();
    const siblings = parent ? sessions.filter((s) => s.parent === parent.id && s.id !== session.id) : [];
    // Nearest first, so a child's name wins over a sibling's of the same name.
    for (const s of [...siblings, ...sessions.filter((s) => s.parent === session.id)]) {
      for (const n of [s.title, s.label]) if (n?.trim()) byName.set(n.trim(), s);
    }
    if (parent) byName.set("team-lead", parent);
    return { parent, kids, byName, tab };
  }, [session.id, session.parent, sessions, tab]);
}

/** One line under the tabs, phones only: up to the lead, across to what it started. Scrolls sideways. */
export function FamilyStrip() {
  const { parent, kids, tab } = useFamily();
  if (!parent && kids.length === 0) return null;
  return (
    <nav className="fam" aria-label="Related sessions">
      {parent ? (
        <a className="fam-chip fam-up" href={hrefOf({ page: "session", id: parent.id, tab })} title={`Started by ${titleOf(parent)}`}>
          <Icon.chevronUp size={12} />
          <StatusDot status={parent.status} />
          <span>{titleOf(parent)}</span>
        </a>
      ) : null}
      {kids.length ? (
        <span className="fam-count">
          {kids.length} started
        </span>
      ) : null}
      {kids.map((k) => (
        <a key={k.id} className="fam-chip" href={hrefOf({ page: "session", id: k.id, tab })} data-status={k.status}>
          <StatusDot status={k.status} />
          <span>{titleOf(k)}</span>
        </a>
      ))}
    </nav>
  );
}
