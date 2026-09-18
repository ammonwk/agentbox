/** A run's subagent roster: the one place two sources of truth are reconciled.
 *
 * A fan-out is described by two things that disagree, and the disagreement is
 * structural rather than a bug in either of them:
 *
 *   the stream   omp's progress snapshots on the parent's tool calls. Live,
 *                detailed, and the only thing that can say what an agent is
 *                doing *right now* — but it only arrives while the parent's
 *                turn is running, and it arrives per parent call, so one
 *                snapshot describes one batch and says nothing about the rest.
 *
 *   the disk     omp's session directory. Slower and coarser, but complete,
 *                durable, and still there after the turn ends, the host exits
 *                and the server restarts. See `ompsession.ts`.
 *
 * So neither is "the" source. The stream wins for a running agent; the disk
 * wins for a finished one and is the only thing that can ever *retire* an
 * entry. Both are merged by subagent name into one roster that is state — it
 * is not folded out of a window of transcript events, because a window is
 * exactly what a fan-out outgrows.
 *
 * Every rule here is a bug this had before:
 *
 *  - Merge by name, not replace whole. Two dispatch calls used to mean the
 *    second batch's snapshot overwrote the first batch's entries, and the
 *    board reported half the fan-out.
 *  - Counters only go up. Snapshots from different parent calls interleave,
 *    and an older frame must not un-count work already seen.
 *  - Terminal is terminal. A late snapshot from a stale frame may not move a
 *    finished agent back to running.
 *  - Nothing is ever assumed to still be true. `observedAt` is stamped on
 *    every entry every time, so a reader can say "as of 07:50" instead of
 *    drawing an eleven-hour-old frame as if it were live.
 */

import type { HubAgent } from "./ompsession";
import type { SubagentProgress, SubagentStatus } from "./types";

/** A transition worth recording: a subagent appearing, or changing state. */
export interface RosterChange {
  entry: SubagentProgress;
  /** Null when this is the first anything has said about the subagent. */
  from: SubagentStatus | null;
  to: SubagentStatus;
}

export interface RosterCounts {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

const TERMINAL: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["completed", "failed"]);

export function isTerminalStatus(status: SubagentStatus): boolean {
  return TERMINAL.has(status);
}

export class Roster {
  /** Insertion-ordered: dispatch order is the order a human dispatched them,
   *  and any re-sort would make a fifty-chip strip jump around as it updates. */
  private readonly byName = new Map<string, SubagentProgress>();

  /** Resume from what was persisted, so a host restart does not start the
   *  roster over and re-announce every subagent as newly dispatched. */
  constructor(existing?: SubagentProgress[] | null) {
    for (const e of existing ?? []) this.byName.set(e.id, { ...e });
  }

  list(): SubagentProgress[] {
    return [...this.byName.values()].map((e) => ({ ...e }));
  }

  get size(): number {
    return this.byName.size;
  }

  counts(): RosterCounts {
    const counts: RosterCounts = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };
    for (const e of this.byName.values()) {
      counts.total++;
      counts[e.status]++;
    }
    return counts;
  }

  /**
   * Fold in one of omp's live progress snapshots.
   *
   * A snapshot describes the subagents of ONE parent tool call. Entries it
   * does not mention are not gone — they belong to another call, or to a
   * batch this call never knew about — so they are left exactly as they are.
   */
  mergeSnapshot(subs: readonly SubagentProgress[], at: number): RosterChange[] {
    const changes: RosterChange[] = [];
    for (const sub of subs) {
      if (!sub?.id) continue;
      const prev = this.byName.get(sub.id);
      const from = prev?.status ?? null;
      const next: SubagentProgress = {
        ...(prev ?? { id: sub.id, agent: sub.agent, task: sub.task, toolCount: 0, tokens: 0, cost: 0, durationMs: 0, status: "pending" }),
        agent: sub.agent || prev?.agent || "task",
        // The dispatch call carries the assignment; later snapshots often
        // carry an empty string rather than repeating it.
        task: prev?.task || sub.task || "",
        currentTool: sub.currentTool,
        currentToolArgs: sub.currentToolArgs,
        lastIntent: sub.lastIntent,
        recentTools: sub.recentTools ?? prev?.recentTools,
        toolCount: Math.max(prev?.toolCount ?? 0, sub.toolCount ?? 0),
        tokens: Math.max(prev?.tokens ?? 0, sub.tokens ?? 0),
        cost: Math.max(prev?.cost ?? 0, sub.cost ?? 0),
        durationMs: Math.max(prev?.durationMs ?? 0, sub.durationMs ?? 0),
        status: settle(from, sub.status),
        observedAt: at,
        source: "stream",
        id: sub.id,
      };
      if (isTerminalStatus(next.status) && next.endedAt === undefined) next.endedAt = at;
      this.byName.set(sub.id, next);
      if (from !== next.status) changes.push({ entry: { ...next }, from, to: next.status });
    }
    return changes;
  }

  /**
   * Reconcile against omp's session directory.
   *
   * This is what closes a fan-out out. The stream stops the moment the
   * parent's turn ends, and subagents go on working for hours afterwards, so
   * without this pass every long fan-out ends its life frozen mid-flight.
   *
   * Disk facts are authoritative for anything terminal — it is the only source
   * that observes an ending at all — but deliberately not for the detail of a
   * running agent, where the stream's `currentTool` and intent are both fresher
   * and richer than a file's modification time.
   */
  mergeDisk(agents: readonly HubAgent[], at: number): RosterChange[] {
    const changes: RosterChange[] = [];
    for (const agent of agents) {
      const prev = this.byName.get(agent.name);
      const from = prev?.status ?? null;

      // A subagent the stream never mentioned is a real subagent — omp only
      // reports one level to its client, so every nested one arrives this way.
      const base: SubagentProgress = prev ?? {
        id: agent.name,
        agent: "task",
        status: "pending",
        task: "",
        toolCount: 0,
        tokens: 0,
        cost: 0,
        durationMs: 0,
      };

      const ended = agent.endedAt ?? prev?.endedAt;
      const next: SubagentProgress = {
        ...base,
        // Disk cannot see a queued agent: a log exists only once omp started
        // one. So `running` from disk means "started, no end recorded", which
        // must not pull an entry the stream already finished back open.
        status: prev && isTerminalStatus(prev.status) && agent.status === "running"
          ? prev.status
          : agent.status,
        endedAt: ended,
        hasResult: agent.hasResult,
        parent: agent.parent ?? prev?.parent,
        durationMs:
          agent.startedAt !== null && ended
            ? Math.max(base.durationMs, ended - agent.startedAt)
            : base.durationMs,
        // A deep scan counted these off the log, so they include everything
        // the subagent did after the stream stopped watching. Still a maximum:
        // a cheap scan reports neither, and must not zero what the stream saw.
        toolCount: Math.max(base.toolCount, agent.toolCount ?? 0),
        tokens: Math.max(base.tokens, agent.tokens ?? 0),
        observedAt: at,
        source: "disk",
      };
      this.byName.set(agent.name, next);
      if (from !== next.status) changes.push({ entry: { ...next }, from, to: next.status });
    }
    return changes;
  }

  /** The parent read `agent://<name>`: its result is in the conversation now.
   *  Not a state change — a collected agent was already finished — so this
   *  reports nothing and only marks the entry. */
  markCollected(name: string, at: number): void {
    const prev = this.byName.get(name);
    if (!prev || prev.collected) return;
    this.byName.set(name, { ...prev, collected: true, observedAt: prev.observedAt ?? at });
  }
}

/**
 * The status an entry moves to, given what it was and what a snapshot claims.
 *
 * Snapshots for one subagent arrive on several parent calls at once (the
 * dispatch, a wait, a `hub` poll), and they are not ordered with respect to
 * each other. A frame captured before an agent finished can therefore land
 * after one captured when it did, and taking it at face value makes a finished
 * subagent start running again — which is how the strip used to show more
 * agents running than had ever been dispatched.
 */
function settle(from: SubagentStatus | null, claimed: SubagentStatus | undefined): SubagentStatus {
  const next = claimed ?? from ?? "pending";
  if (from && isTerminalStatus(from) && !isTerminalStatus(next)) return from;
  return next;
}

/**
 * How stale a roster is: milliseconds since the newest entry was described by
 * anything, or null when nothing has an observation time.
 *
 * Null is its own answer and is not zero — it means the roster predates this
 * being recorded, and a caller should say "unknown", not "just now".
 */
export function rosterAge(subs: readonly SubagentProgress[], now: number): number | null {
  let newest: number | null = null;
  for (const e of subs) {
    if (e.observedAt === undefined) continue;
    if (newest === null || e.observedAt > newest) newest = e.observedAt;
  }
  return newest === null ? null : Math.max(0, now - newest);
}

/**
 * Whether a roster's unfinished entries should still be drawn as live.
 *
 * The judgement is about the *parent*: omp streams subagent progress only
 * while the parent's turn is running, so a roster attached to a session that
 * is not running cannot be getting fresher, however recently it was written.
 * Saying so is the difference between "32 running" and "32 running as of
 * 07:50" eleven hours later.
 */
export function rosterIsLive(sessionStatus: string): boolean {
  return sessionStatus === "running" || sessionStatus === "spawning";
}
