/** Compaction: the one case where this app rewrites history.
 *
 * The bar is that a reader cannot tell. Everything a transcript shows is
 * derived from its events, so the tests that matter are the ones that fold the
 * file both ways and compare — not the byte counts, which are only the reason
 * to do it at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactLog } from "../compact";
import { Roster } from "../roster";
import type { SubagentProgress, TranscriptEvent } from "../types";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function logFile(lines: object[]): string {
  dir = mkdtempSync(join(tmpdir(), "agentbox-compact-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((event) => `${JSON.stringify({ event })}\n`).join(""));
  return path;
}

let seq = 0;
function sub(id: string, status: SubagentProgress["status"], toolCount = 0): SubagentProgress {
  return { id, agent: "task", status, task: `do ${id}`, toolCount, tokens: 0, cost: 0, durationMs: 0 };
}

/** A heartbeat: the dispatching call, still running, carrying a snapshot. */
function beat(subs: SubagentProgress[], ts = ++seq * 1000): TranscriptEvent {
  return {
    seq: ++seq,
    ts,
    type: "tool",
    call: {
      id: "call-dispatch",
      kind: "other",
      title: "Dispatch batch 1",
      input: { tasks: subs.map((s) => ({ name: s.id, agent: "task", task: s.task })) },
      status: "running",
      locations: [],
      output: null,
      subs,
      startedAt: 1000,
      endedAt: null,
    },
  };
}

function says(text: string): TranscriptEvent {
  return { seq: ++seq, ts: ++seq * 1000, type: "assistant", text };
}

function readEvents(path: string): TranscriptEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { event: TranscriptEvent }).event);
}

/** The roster a reader folds out of a transcript — the thing that must not
 *  change when the file does. */
function rosterOf(path: string): SubagentProgress[] {
  const roster = new Roster();
  for (const e of readEvents(path)) {
    if (e.type === "tool" && e.call.subs) roster.mergeSnapshot(e.call.subs, e.ts);
  }
  return roster.list();
}

describe("compacting a fan-out's transcript", () => {
  test("drops the superseded heartbeats and keeps everything else", () => {
    const path = logFile([
      says("dispatching"),
      beat([sub("A", "running", 1)]),
      beat([sub("A", "running", 2)]),
      beat([sub("A", "running", 3)]),
      beat([sub("A", "running", 4)]),
      says("done"),
    ]);
    const result = compactLog(path);
    expect(result.dropped).toBe(2);
    const events = readEvents(path);
    expect(events.filter((e) => e.type === "assistant").map((e) => e.text)).toEqual([
      "dispatching",
      "done",
    ]);
  });

  test("keeps the moment each subagent changed state", () => {
    // Without this the timestamps collapse: every completion in a fifty-way
    // run would be recorded as having happened at whatever the last surviving
    // snapshot said, hours after the fact.
    const path = logFile([
      beat([sub("A", "running")], 1000),
      beat([sub("A", "running")], 2000),
      beat([sub("A", "completed")], 3000),
      beat([sub("A", "completed")], 4000),
      beat([sub("A", "completed")], 5000),
    ]);
    compactLog(path);
    const kept = readEvents(path).map((e) => e.ts);
    expect(kept).toContain(1000); // first sighting
    expect(kept).toContain(3000); // the completion
    expect(kept).toContain(5000); // the newest, which the roster folds from
    expect(kept).not.toContain(2000);
  });

  test("the roster folded from the file is identical afterwards", () => {
    const path = logFile([
      beat([sub("A", "running", 1), sub("B", "running", 1)]),
      beat([sub("A", "running", 5), sub("B", "running", 3)]),
      beat([sub("A", "completed", 9), sub("B", "running", 4)]),
      beat([sub("A", "completed", 9), sub("B", "failed", 7)]),
      beat([sub("A", "completed", 9), sub("B", "failed", 7)]),
    ]);
    const before = rosterOf(path);
    compactLog(path);
    expect(rosterOf(path)).toEqual(before);
  });

  test("a call's terminal event is never a candidate", () => {
    const finished = beat([sub("A", "completed")]);
    (finished as Extract<TranscriptEvent, { type: "tool" }>).call.status = "ok";
    const path = logFile([beat([sub("A", "running")]), beat([sub("A", "running")]), finished]);
    compactLog(path);
    const events = readEvents(path);
    expect(events.some((e) => e.type === "tool" && e.call.status === "ok")).toBe(true);
  });

  test("a transcript with nothing to drop is left untouched", () => {
    const path = logFile([says("hello"), says("goodbye")]);
    const before = readFileSync(path, "utf8");
    const result = compactLog(path);
    expect(result.dropped).toBe(0);
    expect(result.bytesAfter).toBe(result.bytesBefore);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("keeps a torn last line rather than eating it", () => {
    // A log written by a process that died mid-append. The rest of the file is
    // still good and the fragment is evidence of what happened.
    const path = logFile([beat([sub("A", "running")]), beat([sub("A", "running")]), beat([sub("A", "completed")])]);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"event":{"seq":99,"ts":1,"ty`);
    compactLog(path);
    expect(readFileSync(path, "utf8")).toContain('{"event":{"seq":99,"ts":1,"ty');
  });

  test("an unparseable line is kept, not assumed disposable", () => {
    const path = logFile([beat([sub("A", "running")]), beat([sub("A", "completed")])]);
    writeFileSync(path, `not json at all\n${readFileSync(path, "utf8")}`);
    compactLog(path);
    expect(readFileSync(path, "utf8").startsWith("not json at all\n")).toBe(true);
  });

  test("a missing file is a no-op", () => {
    dir = mkdtempSync(join(tmpdir(), "agentbox-compact-"));
    const result = compactLog(join(dir, "nothing.jsonl"));
    expect(result).toMatchObject({ dropped: 0, bytesBefore: 0 });
  });
});
