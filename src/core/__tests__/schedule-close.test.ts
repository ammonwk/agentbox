import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, insertSchedule, insertSessionRecord } from "../db";
import { FleetError, type Fleet } from "../fleet";
import { markScheduled } from "../schedule-sessions";
import { Scheduler } from "../scheduler";
import type { Schedule, Session } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-schedule-close-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  closeDb();
});

afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

function view(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    status: "waiting",
    closedAt: null,
    lastActivityAt: NOW - 61 * 60_000,
    question: null,
    limitHit: null,
    turnError: null,
    autoResume: null,
    waits: [],
    parkHold: null,
    background: false,
    pinOrder: null,
    bookmarkedAt: null,
    ...over,
  } as Session;
}

function record(id: string): Parameters<typeof insertSessionRecord>[0] {
  return {
    id,
    provider: "claude",
    agentSessionId: null,
    accountId: null,
    scope: "personal",
    cwd: "/tmp",
    worktree: null,
    label: null,
    claim: 0,
    origin: "agentbox",
    tmux: null,
    transcriptPath: null,
    startedAt: NOW,
    lastActivityAt: NOW,
    archivedAt: null,
    facts: null,
    createdAt: NOW,
  };
}

function schedulerWith(sessions: Record<string, Session>, closed: string[], now: () => number): Scheduler {
  const fleet = {
    get(id: string): Session {
      const s = sessions[id];
      if (!s) throw new FleetError(404, `no session ${id}`);
      return s;
    },
    async close(id: string) {
      closed.push(id);
      sessions[id]!.closedAt = now();
      return { closed: [id], kept: [], dropped: [], said: "" };
    },
  } as unknown as Fleet;
  return new Scheduler(fleet, () => {}, now);
}

describe("a scheduled session that has finished", () => {
  test("closes an hour after its last message, and leaves what has not finished", async () => {
    const now = () => NOW;
    const closed: string[] = [];
    const sessions = {
      old: view("old"),
      stopped: view("stopped", { status: "stopped" }),
      young: view("young", { lastActivityAt: NOW - 59 * 60_000 }),
      running: view("running", { status: "running" }),
      asked: view("asked", { question: { id: "q", questions: [] } }),
      limited: view("limited", { limitHit: { at: NOW, detail: "limit" } }),
      background: view("background", { parkHold: "a background command is running" }),
      waiting: view("waiting", { waits: [{ kind: "pr", what: "PR #1: every check" }] }),
      pinned: view("pinned", { pinOrder: 1 }),
      unscheduled: view("unscheduled"),
      kept: view("kept"),
    };
    for (const id of ["old", "stopped", "young", "running", "asked", "limited", "background", "waiting", "pinned", "kept"]) {
      insertSessionRecord(record(id));
      markScheduled(id, "schedule", NOW);
    }
    const sameSession: Schedule = {
      id: "same", rule: { kind: "every", minutes: 10, from: NOW }, spec: { provider: "claude" }, label: null,
      enabled: true, nextAt: NOW + 600_000, createdAt: NOW, lastRunAt: NOW, lastSessionId: "kept", lastError: null,
      noteCmd: "true", sameSession: true, freshOver: null, retiring: null,
    };
    insertSchedule(sameSession);

    await schedulerWith(sessions, closed, now).tick();
    expect(closed.sort()).toEqual(["old", "stopped"]);
    expect(sessions.old!.closedAt).toBe(NOW);
  });

  test("a same-session schedule's current session is never closed this way", async () => {
    const now = () => NOW;
    const closed: string[] = [];
    const sessions = { kept2: view("kept2") };
    insertSessionRecord(record("kept2"));
    markScheduled("kept2", "same2", NOW);
    insertSchedule({
      id: "same2", rule: { kind: "every", minutes: 10, from: NOW }, spec: { provider: "claude" }, label: null,
      enabled: true, nextAt: NOW + 600_000, createdAt: NOW, lastRunAt: NOW, lastSessionId: "kept2", lastError: null,
      noteCmd: "true", sameSession: true, freshOver: null, retiring: null,
    });

    await schedulerWith(sessions, closed, now).tick();
    expect(closed).toEqual([]);
  });
});
