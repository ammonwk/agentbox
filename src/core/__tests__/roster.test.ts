/** The roster's merge rules — each one a bug this had.
 *
 * The screenshot that started this: a board session sitting idle, its strip
 * reading "49 subagents · 32 running", eleven hours after all forty-nine had
 * finished. Three separate defects lined up to produce it, and every test here
 * is one of them.
 */

import { describe, expect, test } from "bun:test";
import { Roster, rosterAge, rosterIsLive } from "../roster";
import type { HubAgent } from "../ompsession";
import type { SubagentProgress } from "../types";

function snap(over: Partial<SubagentProgress> & { id: string }): SubagentProgress {
  return {
    agent: "task",
    status: "running",
    task: "",
    toolCount: 0,
    tokens: 0,
    cost: 0,
    durationMs: 0,
    ...over,
  };
}

function onDisk(over: Partial<HubAgent> & { name: string }): HubAgent {
  return {
    parent: null,
    status: "completed",
    startedAt: 1_000,
    endedAt: 2_000,
    lastActivityAt: 2_000,
    hasResult: true,
    logBytes: 100,
    ...over,
  };
}

describe("merging the live progress stream", () => {
  test("two dispatch batches make one roster, not two", () => {
    // The bug: a snapshot describes ONE parent call's subagents, and the
    // roster used to be replaced with whichever snapshot arrived last. A run
    // that dispatched 25 and then 24 reported 24 subagents.
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A" }), snap({ id: "B" })], 1_000);
    roster.mergeSnapshot([snap({ id: "C" })], 1_100);
    expect(roster.list().map((e) => e.id)).toEqual(["A", "B", "C"]);
    expect(roster.counts()).toMatchObject({ total: 3, running: 3 });
  });

  test("a snapshot does not retire the subagents it does not mention", () => {
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", status: "completed" })], 1_000);
    roster.mergeSnapshot([snap({ id: "B" })], 1_100);
    expect(roster.counts()).toMatchObject({ total: 2, completed: 1, running: 1 });
  });

  test("counters never go backwards", () => {
    // Snapshots for one subagent arrive on several parent calls at once and
    // are not ordered against each other, so an older frame must not un-count
    // work already seen.
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", toolCount: 40, tokens: 9_000, durationMs: 60_000 })], 1_000);
    roster.mergeSnapshot([snap({ id: "A", toolCount: 12, tokens: 3_000, durationMs: 20_000 })], 1_100);
    expect(roster.list()[0]).toMatchObject({ toolCount: 40, tokens: 9_000, durationMs: 60_000 });
  });

  test("a stale frame cannot restart a finished subagent", () => {
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", status: "completed" })], 1_000);
    const changes = roster.mergeSnapshot([snap({ id: "A", status: "running" })], 1_100);
    expect(roster.list()[0]!.status).toBe("completed");
    expect(changes).toEqual([]);
  });

  test("the assignment survives snapshots that stop repeating it", () => {
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", task: "Take PR 5199 to merge-ready" })], 1_000);
    roster.mergeSnapshot([snap({ id: "A", task: "" })], 1_100);
    expect(roster.list()[0]!.task).toBe("Take PR 5199 to merge-ready");
  });

  test("reports one change per transition, and nothing for a quiet heartbeat", () => {
    const roster = new Roster();
    expect(roster.mergeSnapshot([snap({ id: "A", status: "pending" })], 1_000)).toMatchObject([
      { from: null, to: "pending" },
    ]);
    expect(roster.mergeSnapshot([snap({ id: "A", status: "running" })], 1_100)).toMatchObject([
      { from: "pending", to: "running" },
    ]);
    // The heartbeat every two seconds that used to be a transcript line each.
    expect(roster.mergeSnapshot([snap({ id: "A", status: "running", toolCount: 3 })], 1_200)).toEqual([]);
    expect(roster.mergeSnapshot([snap({ id: "A", status: "completed" })], 1_300)).toMatchObject([
      { from: "running", to: "completed" },
    ]);
  });

  test("stamps when each entry was last described", () => {
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A" })], 1_000);
    expect(roster.list()[0]).toMatchObject({ observedAt: 1_000, source: "stream" });
  });
});

describe("reconciling against omp's directory", () => {
  test("retires the subagents the stream left mid-flight", () => {
    // The actual screenshot: the turn ended with 32 running, and this is the
    // pass that goes and looks at what became of them.
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A" }), snap({ id: "B" })], 1_000);
    const changes = roster.mergeDisk(
      [onDisk({ name: "A" }), onDisk({ name: "B", status: "failed" })],
      9_000,
    );
    expect(roster.counts()).toMatchObject({ running: 0, completed: 1, failed: 1 });
    expect(changes.map((c) => c.to).sort()).toEqual(["completed", "failed"]);
    expect(roster.list()[0]).toMatchObject({ source: "disk", observedAt: 9_000, endedAt: 2_000 });
  });

  test("does not reopen a subagent the stream already finished", () => {
    // Disk says "running" for anything with no exit line, including an agent
    // omp finished without recording one. The stream saw it end; believe that.
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", status: "completed" })], 1_000);
    const changes = roster.mergeDisk([onDisk({ name: "A", status: "running", endedAt: null })], 9_000);
    expect(roster.list()[0]!.status).toBe("completed");
    expect(changes).toEqual([]);
  });

  test("adopts subagents the stream never mentioned", () => {
    // omp reports one level of the tree to its client. Everything a subagent
    // dispatched itself arrives only this way.
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A" })], 1_000);
    roster.mergeDisk([onDisk({ name: "DiffAudit", parent: "A" })], 9_000);
    expect(roster.list().map((e) => e.id)).toEqual(["A", "DiffAudit"]);
    expect(roster.list()[1]).toMatchObject({ parent: "A", status: "completed" });
  });

  test("takes the counts a deep scan read off the log", () => {
    // The stream stops at the turn; the log has the rest. One real fan-out
    // left the roster saying 12 tools where the agent finished with 121.
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", toolCount: 12, tokens: 78_800 })], 1_000);
    roster.mergeDisk([onDisk({ name: "A", toolCount: 121, tokens: 171_131 })], 9_000);
    expect(roster.list()[0]).toMatchObject({ toolCount: 121, tokens: 171_131 });
  });

  test("a cheap scan reports no counts, and must not zero the stream's", () => {
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", toolCount: 12, tokens: 78_800 })], 1_000);
    roster.mergeDisk([onDisk({ name: "A" })], 9_000);
    expect(roster.list()[0]).toMatchObject({ toolCount: 12, tokens: 78_800 });
  });

  test("carries whether a finished subagent ever reported", () => {
    const roster = new Roster();
    roster.mergeDisk([onDisk({ name: "A", hasResult: false })], 9_000);
    expect(roster.list()[0]).toMatchObject({ status: "completed", hasResult: false });
  });

  test("derives a duration from the record when the stream never gave one", () => {
    const roster = new Roster();
    roster.mergeDisk([onDisk({ name: "A", startedAt: 1_000, endedAt: 61_000 })], 90_000);
    expect(roster.list()[0]!.durationMs).toBe(60_000);
  });
});

describe("what a roster survives", () => {
  test("resumes from what was persisted without re-announcing anything", () => {
    const first = new Roster();
    first.mergeSnapshot([snap({ id: "A", status: "running" })], 1_000);
    // A new host process, picking the row back up.
    const second = new Roster(first.list());
    expect(second.mergeSnapshot([snap({ id: "A", status: "running" })], 2_000)).toEqual([]);
    expect(second.counts()).toMatchObject({ total: 1 });
  });

  test("a collected result is marked without being a state change", () => {
    const roster = new Roster();
    roster.mergeSnapshot([snap({ id: "A", status: "completed" })], 1_000);
    roster.markCollected("A", 1_100);
    expect(roster.list()[0]!.collected).toBe(true);
  });
});

describe("saying how stale a roster is", () => {
  test("measures from the newest observation", () => {
    const subs = [
      snap({ id: "A", observedAt: 1_000 }),
      snap({ id: "B", observedAt: 5_000 }),
    ];
    expect(rosterAge(subs, 9_000)).toBe(4_000);
  });

  test("is null when nothing was ever timestamped, rather than zero", () => {
    // A roster recorded before observation times existed. "Unknown" and "just
    // now" are not the same answer and must not render the same.
    expect(rosterAge([snap({ id: "A" })], 9_000)).toBeNull();
  });

  test("only a running session can have a live roster", () => {
    // omp streams subagent progress while the parent's turn runs and not one
    // word afterwards, so this is the whole rule for whether to believe it.
    expect(rosterIsLive("running")).toBe(true);
    expect(rosterIsLive("spawning")).toBe(true);
    for (const status of ["waiting", "done", "dead", "failed", "flagged"]) {
      expect(rosterIsLive(status)).toBe(false);
    }
  });
});
