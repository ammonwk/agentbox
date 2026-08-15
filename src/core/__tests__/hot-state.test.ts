import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useTempHome } from "./tmp-home";
import type { Session } from "../types";

/**
 * `getHotState` is what every client sees. The closed-session contract lives
 * here rather than in the UI: Close presents itself as reversible, and it can
 * only be reversible if the closed row still reaches the browser.
 *
 * Imported after the temp home is pinned so the database is a throwaway.
 */
let home: ReturnType<typeof useTempHome>;
let getHotState: typeof import("../state").getHotState;
let insertSession: typeof import("../db").insertSession;

function session(patch: Partial<Session>): Session {
  return {
    id: "s", title: "t", prompt: "p", status: "waiting", repo: "/repo",
    branch: "b", worktree: null, model: "m", followUps: 0, lastMessage: null,
    toolCalls: 0, exitCode: null, pid: null, hostPid: null, permission: null,
    prNumber: null, repoFullName: null,
    costUsd: null, tokens: null, blocked: false, flagReason: null,
    ompSessionId: null, createdAt: 1, updatedAt: 1, startedAt: null,
    closedAt: null, ...patch,
  };
}

beforeAll(async () => {
  home = useTempHome();
  ({ getHotState } = await import("../state"));
  ({ insertSession } = await import("../db"));
  insertSession(session({ id: "live", title: "Still going" }));
  insertSession(session({ id: "filed", title: "Dealt with", closedAt: 999 }));
});

afterAll(() => home.restore());

describe("getHotState", () => {
  test("carries closed sessions to the client", () => {
    // Withholding them made Close an undoable delete wearing a reversible
    // label: the closed count could only be 0 and the toggle revealed nothing.
    const ids = getHotState().sessions.map((s) => s.id);
    expect(ids).toContain("live");
    expect(ids).toContain("filed");
  });

  test("closedAt survives the round trip, so the UI can filter on it", () => {
    const filed = getHotState().sessions.find((s) => s.id === "filed");
    expect(filed?.closedAt).toBe(999);
    const live = getHotState().sessions.find((s) => s.id === "live");
    expect(live?.closedAt).toBeNull();
  });

  test("every session carries an attention, closed included", () => {
    // The Sessions board sorts on it, and an closed row still renders in the
    // closed list — it must not arrive without one.
    for (const s of getHotState().sessions) {
      expect(s.attention.kind).toBeDefined();
      expect(s.attention.label.length).toBeGreaterThan(0);
    }
  });

  test("serverTime is present, for the client's elapsed clock", () => {
    expect(getHotState().serverTime).toBeGreaterThan(0);
  });
});
