import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  listRecords,
  readEvents,
  readRecord,
  requestCommand,
  takeCommand,
  writeMeta,
  writeState,
  STALE_AFTER_MS,
  type RecordMeta,
} from "../record";
import { subagentRoot } from "../../core/paths";
import { useTempHome } from "../../core/__tests__/tmp-home";
import type { AgentSnapshot } from "../health";

let restoreHome: () => void;

beforeEach(() => {
  ({ restore: restoreHome } = useTempHome());
});

afterEach(() => restoreHome());

function meta(over: Partial<RecordMeta> = {}): RecordMeta {
  return {
    name: "scan",
    cwd: "/repo",
    branch: "main",
    model: "m",
    readOnly: false,
    startedAt: 1_000,
    pid: 42,
    owner: "session-1",
    prompt: "Find every caller of refreshToken().",
    ...over,
  };
}

function snapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: "scan",
    cwd: "/repo",
    branch: "main",
    model: "m",
    readOnly: false,
    state: "running",
    startedAt: 1_000,
    turnStartedAt: 1_000,
    lastEventAt: 2_000,
    lastAction: "Read x.ts",
    turnToolCalls: 2,
    totalToolCalls: 2,
    uncollected: 0,
    contextUsed: 100,
    contextSize: 1000,
    costUsd: 0.1,
    maxTurnMs: 1000,
    recent: [],
    inFlightToolMs: null,
    ...over,
  };
}

function dirFor(id: string): string {
  const dir = join(subagentRoot(), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("the record an agent leaves behind", () => {
  test("identity is readable without the process that wrote it", () => {
    writeMeta(dirFor("p-1-scan"), meta());
    const rec = readRecord("p-1-scan");
    expect(rec?.meta.name).toBe("scan");
    expect(rec?.meta.prompt).toContain("refreshToken");
    // Nothing published a snapshot, so there is nothing to believe about now.
    expect(rec?.snapshot).toBeNull();
    expect(rec?.stale).toBe(true);
  });

  test("a directory with no meta is not a record", () => {
    dirFor("junk");
    expect(readRecord("junk")).toBeNull();
    expect(listRecords()).toEqual([]);
  });

  /**
   * The distinction the whole viewer rests on. A snapshot says "running"
   * forever; only its age can say whether anybody is still there to have
   * written it. Without this, an agent whose owner was killed shows as live
   * for as long as the record survives.
   */
  test("a snapshot nobody refreshed is stale, however busy it claims to be", () => {
    const dir = dirFor("p-1-scan");
    writeMeta(dir, meta());
    writeState(dir, snapshot());
    const fresh = readRecord("p-1-scan");
    expect(fresh?.stale).toBe(false);
    expect(fresh?.snapshot?.state).toBe("running");

    const later = readRecord("p-1-scan", Date.now() + STALE_AFTER_MS + 1);
    expect(later?.stale).toBe(true);
    expect(later?.snapshot?.state).toBe("running");
  });

  test("records come back newest first", () => {
    writeMeta(dirFor("a"), meta({ name: "older", startedAt: 1 }));
    writeMeta(dirFor("b"), meta({ name: "newer", startedAt: 2 }));
    expect(listRecords().map((r) => r.meta.name)).toEqual(["newer", "older"]);
  });

  test("the event log is read from the tail, and a half-written line is skipped", () => {
    const dir = dirFor("p-1-scan");
    writeMeta(dir, meta());
    for (let i = 0; i < 5; i++) {
      appendFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify({ ts: i, type: "tool" })}\n`);
    }
    // What a reader lands on when it polls a file a live process is appending
    // to. It must cost that line and nothing else.
    appendFileSync(join(dir, "transcript.jsonl"), '{"ts":9,"type":"to');
    const events = readEvents(dir, 3);
    expect(events.map((e) => e.ts)).toEqual([2, 3, 4]);
  });
});

describe("asking an agent's owner to do something", () => {
  /**
   * A watcher is in a different process from the agent, with no socket to it —
   * the owner is an MCP server on somebody's stdio. A file in a directory the
   * owner already sweeps is the cheapest thing that works, and it degrades
   * honestly: nobody there means nothing happens.
   */
  test("a request is taken exactly once", () => {
    const dir = dirFor("p-1-scan");
    requestCommand(dir, "interrupt");
    expect(takeCommand(dir)).toBe("interrupt");
    expect(takeCommand(dir)).toBeNull();
  });

  test("nothing pending reads as nothing pending", () => {
    expect(takeCommand(dirFor("p-1-scan"))).toBeNull();
  });

  test("a stop outranks an interrupt when both are waiting", () => {
    const dir = dirFor("p-1-scan");
    requestCommand(dir, "interrupt");
    requestCommand(dir, "stop");
    // Interrupt first: it is the reversible one, and taking it does not
    // discard the stop, which is still there on the next sweep.
    expect(takeCommand(dir)).toBe("interrupt");
    expect(takeCommand(dir)).toBe("stop");
  });
});
