/** A board session's fan-out, as a browser should see it.
 *
 * The roster on the session row is written by the host, which is the only
 * process that sees omp's live progress stream. That is the right owner while
 * a session is running and the wrong one every other minute of its life: a
 * host exits when its agent is stopped or parked, and the subagents it
 * dispatched keep working — and are still on disk long after both are gone.
 *
 * So this reads the row, reconciles it against omp's own session directory,
 * and answers with both the roster and how much to believe it. Two rules keep
 * that honest:
 *
 *  - When a host is alive, this does not write. The host owns the row and a
 *    second writer would take turns clobbering it.
 *  - When no host is alive, this repairs the row, because nothing else ever
 *    will. That is what corrects a session recorded before any of this
 *    existed, whose row still claims a fan-out that ended last week is running.
 *
 * Neither path appends to the transcript. Exactly one process may write a
 * session's log, and for a live session that is its host.
 */

import { updateSession } from "../core/db";
import {
  ompSessionDir,
  readHubAgent,
  scanHubAgents,
  type HubAgentDetail,
} from "../core/ompsession";
import { Roster, rosterAge, rosterIsLive } from "../core/roster";
import { hasHost } from "../core/sessions";
import type { Session, SubagentProgress } from "../core/types";

export interface FanoutView {
  subs: SubagentProgress[];
  /**
   * Milliseconds since anything last described the newest entry, or null when
   * the roster predates this being recorded. Null is not zero: it means
   * "unknown", and a reader should say so.
   */
  ageMs: number | null;
  /** The progress stream can still be arriving, so the roster is current. */
  live: boolean;
  /** omp's session directory was found, so terminal states are trustworthy.
   *  False means the only source left is whatever the stream last said. */
  recorded: boolean;
}

/**
 * `busy` is injected rather than read, because "is another process writing
 * this row" is the one fact that decides whether this function is a reader or
 * a repair — and a rule that important should be testable without standing up
 * a host process to prove it.
 */
export function fanoutOf(
  session: Session,
  now = Date.now(),
  busy: (id: string) => boolean = hasHost,
): FanoutView {
  const roster = new Roster(session.subs);
  const dir = ompSessionDir(session.worktree, session.ompSessionId);
  const owned = busy(session.id);
  // Count each subagent's work off its log whenever the stream is not the
  // fresher source. Keyed on the session's status rather than on whether a
  // host is connected, because those are different questions: a host sits
  // connected for hours between turns, streaming nothing, and a roster that
  // deferred to it showed 12 tools for a subagent that finished with 121.
  const live = rosterIsLive(session.status);
  const scanned = dir ? scanHubAgents(dir, { deep: !live }) : [];
  roster.mergeDisk(scanned, now);

  // Only repair a row nobody else is writing, and only when the disk actually
  // said something new — a read path that writes on every request would make
  // opening a finished session a database write. `updatedAt` is preserved:
  // learning what a fan-out did last week must not float the row to the top
  // of a board that sorts on it.
  const subs = roster.list();
  if (!owned && changed(session.subs, subs)) {
    updateSession(session.id, { subs, updatedAt: session.updatedAt });
  }

  return {
    subs,
    ageMs: rosterAge(subs, now),
    live: live && owned,
    recorded: dir !== null,
  };
}

/**
 * Whether the merge learned anything worth writing down.
 *
 * `observedAt` and `source` are excluded deliberately: they change on every
 * merge by construction, so comparing them would make every page view a
 * database write for a session that has been finished since Tuesday.
 */
function changed(before: SubagentProgress[] | null, after: SubagentProgress[]): boolean {
  if ((before?.length ?? 0) !== after.length) return true;
  const strip = (s: SubagentProgress) => ({ ...s, observedAt: undefined, source: undefined });
  return JSON.stringify((before ?? []).map(strip)) !== JSON.stringify(after.map(strip));
}

/**
 * One subagent's whole history, read from omp's log rather than reconstructed.
 *
 * Null when omp has no record of it — a session old enough to have been
 * pruned, or a name that was only ever mentioned by a progress snapshot. The
 * caller falls back to what the transcript can reconstruct, which is less but
 * is not nothing.
 */
export function fanoutAgentOf(session: Session, name: string): HubAgentDetail | null {
  const dir = ompSessionDir(session.worktree, session.ompSessionId);
  return dir ? readHubAgent(dir, name) : null;
}
