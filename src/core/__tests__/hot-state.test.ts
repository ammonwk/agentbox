import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useTempHome } from "./tmp-home";
import type { Session } from "../types";

/**
 * `getHotState` is what every client sees. The archived-session contract lives
 * here rather than in the UI: Archive presents itself as reversible, and it can
 * only be reversible if the archived row still reaches the browser.
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
    toolCalls: 0, exitCode: null, pid: null, prNumber: null, repoFullName: null,
    costUsd: null, tokens: null, blocked: false, flagReason: null,
    ompSessionId: null, createdAt: 1, updatedAt: 1, startedAt: null,
    archivedAt: null, ...patch,
  };
}

beforeAll(async () => {
  home = useTempHome();
  ({ getHotState } = await import("../state"));
  ({ insertSession } = await import("../db"));
  insertSession(session({ id: "live", title: "Still going" }));
  insertSession(session({ id: "filed", title: "Dealt with", archivedAt: 999 }));
});

afterAll(() => home.restore());

describe("getHotState", () => {
  test("carries archived sessions to the client", () => {
    // Withholding them made Archive an undoable delete wearing a reversible
    // label: the archived count could only be 0 and the toggle revealed nothing.
    const ids = getHotState().sessions.map((s) => s.id);
    expect(ids).toContain("live");
    expect(ids).toContain("filed");
  });

  test("archivedAt survives the round trip, so the UI can filter on it", () => {
    const filed = getHotState().sessions.find((s) => s.id === "filed");
    expect(filed?.archivedAt).toBe(999);
    const live = getHotState().sessions.find((s) => s.id === "live");
    expect(live?.archivedAt).toBeNull();
  });

  test("every session carries an attention, archived included", () => {
    // The Sessions board sorts on it, and an archived row still renders in the
    // archived list — it must not arrive without one.
    for (const s of getHotState().sessions) {
      expect(s.attention.kind).toBeDefined();
      expect(s.attention.label.length).toBeGreaterThan(0);
    }
  });

  test("serverTime is present, for the client's elapsed clock", () => {
    expect(getHotState().serverTime).toBeGreaterThan(0);
  });
});
