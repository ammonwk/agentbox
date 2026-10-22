import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { SessionStatus } from "../../../../src/core/types";
import { api } from "../../api";
import { StatusDot } from "../../bits";
import { Icon } from "../../components";
import { shownStatus, titleOf, type SessionRow } from "../../lib/board";
import { hrefOf } from "../../route";

/**
 * The sessions around the open one: the session that started it, the ones it
 * started, and the ones started beside it — a Claude agent team's lead and
 * teammates, or a `codex exec` run and the session it ran under. On a wide
 * screen the list beside the session shows them as a tree and the line under
 * the header names the session that started it; on a phone that list is a
 * page of its own, so the strip below does it instead, and the timeline links
 * each teammate message to the session that sent it.
 */
export interface Family {
  parent: SessionRow | null;
  /** The parent's id as recorded, even when no session record is left to link to. */
  parentId: string | null;
  kids: SessionRow[];
  /** A teammate's name (its session's title or label) to its session; `team-lead` is the parent. */
  byName: Map<string, SessionRow>;
}

const NO_FAMILY: Family = { parent: null, parentId: null, kids: [], byName: new Map() };
export const FamilyContext = createContext<Family>(NO_FAMILY);
export const useFamily = () => useContext(FamilyContext);

/** Needing you first, then working, then the rest; newest first within each. */
const RANK: Record<SessionStatus, number> = { blocked: 0, running: 1, waiting: 2, stopped: 3, closed: 4 };

/** Closed sessions are not in the open board's state (`/api/state?open=1`), so
 *  a parent named by an open one is fetched once by id and kept here. */
const parentRows = new Map<string, SessionRow | null>();

function useParentOf(
  session: SessionRow,
  sessions: readonly SessionRow[],
): { parent: SessionRow | null; parentId: string | null } {
  const parentId = session.parent ?? null;
  const board = parentId ? sessions.find((s) => s.id === parentId) ?? null : null;
  const known = parentId ? board ?? parentRows.get(parentId) ?? null : null;
  const [parent, setParent] = useState<SessionRow | null>(known);
  useEffect(() => {
    setParent(known);
    if (!parentId || known) return;
    let live = true;
    api.session(parentId).then(
      (s) => {
        parentRows.set(parentId, s);
        if (live) setParent(s);
      },
      () => {
        parentRows.set(parentId, null);
      },
    );
    return () => {
      live = false;
    };
  }, [parentId, known]);
  return { parent, parentId };
}

export function useFamilyOf(session: SessionRow, sessions: readonly SessionRow[]): Family {
  const { parent, parentId } = useParentOf(session, sessions);
  return useMemo(() => {
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
    return { parent, parentId, kids, byName };
  }, [session.id, parent, parentId, sessions]);
}

/** One line under the tabs, phones only: up to the lead, across to what it started. Scrolls sideways. */
export function FamilyStrip() {
  const { parent, parentId, kids } = useFamily();
  if (!parent && !parentId && kids.length === 0) return null;
  return (
    <nav className="fam" aria-label="Related sessions">
      {parent ? (
        <a className="fam-chip fam-up" href={hrefOf({ page: "session", id: parent.id, tab: "timeline" })} title={`Started by ${titleOf(parent)}`}>
          <Icon.chevronUp size={12} />
          <StatusDot status={shownStatus(parent)} />
          <span>{titleOf(parent)}</span>
        </a>
      ) : parentId ? (
        <span className="fam-chip fam-up" title={`The session that started this one (${parentId}) is no longer recorded`}>
          <Icon.chevronUp size={12} />
          <span className="mono">{parentId}</span>
        </span>
      ) : null}
      {kids.length ? (
        <span className="fam-count">
          {kids.length} started
        </span>
      ) : null}
      {kids.map((k) => (
        <a key={k.id} className="fam-chip" href={hrefOf({ page: "session", id: k.id, tab: "timeline" })} data-status={k.status}>
          <StatusDot status={shownStatus(k)} />
          <span>{titleOf(k)}</span>
        </a>
      ))}
    </nav>
  );
}

/** One quiet line under the header on a wide screen: the session this one came
 *  from. It names the parent even when the list has no row to nest under —
 *  closed, filtered out, or gone — which is what a handoff leaves behind. */
export function ParentLine() {
  const { parent, parentId } = useFamily();
  if (!parentId) return null;
  return (
    <nav className="fam fam-parent" aria-label="Where this session came from">
      <span className="fam-label">Started by</span>
      {parent ? (
        <a className="fam-chip fam-up" href={hrefOf({ page: "session", id: parent.id, tab: "timeline" })} title={`Started by ${titleOf(parent)}`}>
          <Icon.chevronUp size={12} />
          <StatusDot status={shownStatus(parent)} />
          <span>{titleOf(parent)}</span>
        </a>
      ) : (
        <span className="fam-chip fam-up" title={`The session that started this one (${parentId}) is no longer recorded`}>
          <Icon.chevronUp size={12} />
          <span className="mono">{parentId}</span>
        </span>
      )}
    </nav>
  );
}
