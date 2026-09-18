import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useTempHome } from "./tmp-home";
import type { Session } from "../types";

/**
 * Parking stops an idle session's omp and leaves the session looking exactly
 * as it did: a message wakes it. Two halves can break that — the host deciding
 * to park something that was not idle, and `reconcile` reading a parked
 * session as a crash — so both are pinned here.
 *
 * Imported after the temp home is pinned so the database is a throwaway.
 */
let home: ReturnType<typeof useTempHome>;
let host: typeof import("../host");
let db: typeof import("../db");
let sessions: typeof import("../sessions");

const HOUR = 60 * 60 * 1000;

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s", title: "t", prompt: "p", status: "waiting", repo: "/repo",
    branch: "b", worktree: null, model: "m", followUps: 0, lastMessage: null,
    toolCalls: 3, exitCode: null, pid: null, hostPid: null, permission: null,
    prNumber: null, repoFullName: null,
    costUsd: null, tokens: null, blocked: false, flagReason: null,
    ompSessionId: "omp-1", subs: null, createdAt: 1, updatedAt: 1, startedAt: 1,
    closedAt: null, parkedAt: null, ...patch,
  };
}

beforeAll(async () => {
  home = useTempHome();
  host = await import("../host");
  db = await import("../db");
  sessions = await import("../sessions");
});

afterAll(() => home.restore());

describe("shouldPark", () => {
  const idle = (over: Partial<import("../host").ParkInput> = {}) => ({
    session: session(),
    now: 10 * HOUR,
    lastActivityAt: 10 * HOUR - host.IDLE_PARK_MS,
    alive: true,
    midTurn: false,
    pendingPermission: false,
    continuePending: false,
    ...over,
  });

  test("parks a session idle between turns for the full window", () => {
    expect(host.shouldPark(idle())).toBe(true);
    expect(host.shouldPark(idle({ session: session({ status: "done", prNumber: 7 }) }))).toBe(true);
  });

  test("not a moment early", () => {
    expect(host.shouldPark(idle({ lastActivityAt: 10 * HOUR - host.IDLE_PARK_MS + 1 }))).toBe(false);
  });

  test("never with work in flight", () => {
    expect(host.shouldPark(idle({ midTurn: true }))).toBe(false);
    expect(host.shouldPark(idle({ pendingPermission: true }))).toBe(false);
    expect(host.shouldPark(idle({ continuePending: true }))).toBe(false);
    expect(host.shouldPark(idle({ session: session({ blocked: true }) }))).toBe(false);
  });

  test("only from a status that says the turn is over", () => {
    for (const status of ["spawning", "running", "flagged", "failed", "dead"] as const) {
      expect(host.shouldPark(idle({ session: session({ status }) }))).toBe(false);
    }
  });

  test("not a closed, already parked, missing or dead-process session", () => {
    expect(host.shouldPark(idle({ session: session({ closedAt: 5 }) }))).toBe(false);
    expect(host.shouldPark(idle({ session: session({ parkedAt: 5 }) }))).toBe(false);
    expect(host.shouldPark(idle({ session: null }))).toBe(false);
    expect(host.shouldPark(idle({ alive: false }))).toBe(false);
  });
});

describe("a parked session across a server restart", () => {
  test("parkedAt round-trips through the database", () => {
    db.insertSession(session({ id: "roundtrip", parkedAt: 1234 }));
    expect(db.getSession("roundtrip")?.parkedAt).toBe(1234);
    db.updateSession("roundtrip", { parkedAt: null });
    expect(db.getSession("roundtrip")?.parkedAt).toBeNull();
  });

  test("reconcile keeps a parked session's status and marks a vanished one dead", async () => {
    db.insertSession(session({ id: "parked-waiting", status: "waiting", parkedAt: 1, hostPid: 999_999 }));
    db.insertSession(session({ id: "parked-done", status: "done", prNumber: 3, parkedAt: 1 }));
    db.insertSession(session({ id: "vanished", status: "waiting", hostPid: 999_998 }));

    await sessions.reconcile();

    const waiting = db.getSession("parked-waiting")!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.parkedAt).toBe(1);
    expect(waiting.hostPid).toBeNull();
    expect(db.getSession("parked-done")!.status).toBe("done");
    expect(db.getSession("vanished")!.status).toBe("dead");
  });
});
