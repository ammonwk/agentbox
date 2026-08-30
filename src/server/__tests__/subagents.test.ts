import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSubagents, subagentDetail } from "../subagents";
import { writeMeta, writeState, STALE_AFTER_MS } from "../../core/record";
import { subagentRoot } from "../../core/paths";
import type { AgentSnapshot } from "../../core/health";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentbox-view-"));
  process.env.AGENTBOX_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTBOX_HOME;
  rmSync(home, { recursive: true, force: true });
});

function agent(id: string, snap: Partial<AgentSnapshot> = {}, prompt = "Do the thing.") {
  const dir = join(subagentRoot(), id);
  mkdirSync(dir, { recursive: true });
  writeMeta(dir, {
    name: id,
    cwd: "/repo",
    branch: "main",
    model: "m",
    readOnly: false,
    startedAt: 1,
    pid: 1,
    owner: "s",
    prompt,
  });
  writeState(dir, {
    name: id,
    cwd: "/repo",
    branch: "main",
    model: "m",
    readOnly: false,
    state: "running",
    startedAt: 1,
    turnStartedAt: Date.now(),
    lastEventAt: Date.now(),
    lastAction: "Read x.ts",
    turnToolCalls: 1,
    totalToolCalls: 1,
    uncollected: 0,
    contextUsed: null,
    contextSize: null,
    costUsd: null,
    maxTurnMs: 1000,
    recent: [],
    inFlightToolMs: null,
    ...snap,
  });
  return dir;
}

function logEvent(dir: string, entry: Record<string, unknown>) {
  appendFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify(entry)}\n`);
}

describe("the subagents a browser sees", () => {
  test("trouble comes first, because that is what a list is read for", () => {
    agent("calm");
    agent("looper", {
      recent: [1, 2, 3].map((seq) => ({
        seq,
        kind: "execute",
        title: "Bash",
        status: "ok",
        startedAtMs: 0,
        ms: 1,
        input: '{"command":"bun test"}',
        output: null,
      })),
    });
    const rows = listSubagents();
    expect(rows[0]!.name).toBe("looper");
    expect(rows[0]!.concern).toBe("looping");
    expect(rows[1]!.concern).toBeNull();
  });

  /**
   * A snapshot claiming to be running whose writer stopped refreshing it is a
   * dead process, not a busy agent. Showing the two the same way is the one
   * mistake a watcher must not make: it is the difference between an answer
   * that is coming and one that never will.
   */
  test("a record nobody is refreshing is abandoned, not running", () => {
    agent("orphan");
    const rows = listSubagents(Date.now() + STALE_AFTER_MS + 1);
    expect(rows[0]!.state).toBe("abandoned");
    expect(rows[0]!.health).toBe("abandoned");
  });

  test("a tool call logged twice is one row carrying its outcome", () => {
    const dir = agent("worker");
    // What `Subagent.log` actually writes: the record is updated in place and
    // appended on both start and end, so the same `seq` appears twice.
    logEvent(dir, {
      ts: 1,
      type: "tool",
      call: { seq: 1, kind: "read", title: "Read x.ts", status: "running", ms: null },
    });
    logEvent(dir, {
      ts: 2,
      type: "tool",
      call: { seq: 1, kind: "read", title: "Read x.ts", status: "ok", ms: 27 },
    });
    const detail = subagentDetail("worker")!;
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0]!.ms).toBe(27);
    expect(detail.calls[0]!.status).toBe("ok");
  });

  test("answers and failures come back with the evidence", () => {
    const dir = agent("worker", {}, "Audit the thing.\nSecond line.");
    logEvent(dir, {
      ts: 3,
      type: "turn",
      report: { turn: 1, stopReason: "end_turn", report: "It is fine.", errors: [] },
    });
    logEvent(dir, { ts: 4, type: "error", message: "denied (read-only agent): Write" });
    const detail = subagentDetail("worker")!;
    expect(detail.turns[0]!.report).toBe("It is fine.");
    expect(detail.errors[0]!.message).toContain("read-only");
    // The list shows one line so a hundred rows stay scannable; the detail
    // keeps the whole brief.
    expect(detail.summary).toBe("Audit the thing.");
    expect(detail.prompt).toContain("Second line.");
  });

  test("an id with no record is null rather than an empty shell", () => {
    expect(subagentDetail("nobody")).toBeNull();
  });
});
