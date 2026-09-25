import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { poolSessionIds, writeMeta, writeState, type RecordMeta } from "../record";
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
  test("identity is readable without the process that wrote it, with the brief clipped", () => {
    const dir = dirFor("p-1-scan");
    writeMeta(dir, meta({ prompt: "x".repeat(10_000) }));
    const got = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RecordMeta;
    expect(got.name).toBe("scan");
    expect(got.prompt.length).toBe(4000);
  });

  test("the snapshot carries when it was written", () => {
    const dir = dirFor("p-1-scan");
    writeState(dir, snapshot());
    const got = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { at: number; snapshot: AgentSnapshot };
    expect(got.snapshot.state).toBe("running");
    expect(Date.now() - got.at).toBeLessThan(5_000);
  });
});

describe("poolSessionIds", () => {
  test("an agent is known by omp's id once its meta has one", () => {
    const dir = dirFor("p-1-scan");
    const startedAt = Date.now();
    writeMeta(dir, meta({ startedAt }));
    expect(poolSessionIds().size).toBe(0);
    // The second write, once omp has opened the conversation.
    writeMeta(dir, meta({ startedAt, ompSessionId: "01a0-omp" }));
    expect([...poolSessionIds()]).toEqual(["01a0-omp"]);
  });

  test("a directory without meta, or with no id for too long, is skipped", () => {
    dirFor("junk");
    writeMeta(dirFor("p-2-never"), meta({ startedAt: 1_000 }));
    expect(poolSessionIds(1_000).size).toBe(0);
    // Past the window it is no longer re-read, even if an id turns up.
    writeMeta(dirFor("p-2-never"), meta({ startedAt: 1_000, ompSessionId: "late" }));
    expect(poolSessionIds(1_000 + 11 * 60_000).size).toBe(0);
  });

  test("no subagent directory at all is an empty set", () => {
    expect(poolSessionIds().size).toBe(0);
  });
});
