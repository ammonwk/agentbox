/** A project's Review page shows the cards its sessions handed you. */
import { expect, test } from "bun:test";
import type { AppState, Card } from "../../../src/core/types";
import { scopedState } from "./projects";

const card = (id: number, sessionId: string | null, about: string | null = null) => ({ id, kind: "decision", title: "t", short: "s", pr: null, about, sessionId, state: "open" }) as unknown as Card;
const session = (id: string, agentProject?: string | null) => ({ id, repoRoot: null, cwd: "/elsewhere", ...(agentProject !== undefined ? { agentProject } : {}) });

test("a card belongs to the project of the superagent session that added it, and a card about nothing to none", () => {
  const state = { repos: [{ id: "p", ref: "/repo" }], sessions: [session("s1", "p"), session("loose")], cards: [card(1, "s1"), card(2, null), card(3, "loose")], schedules: [] } as unknown as AppState;
  expect(scopedState(state, "p").cards.map((c) => c.id)).toEqual([1]);
  expect(scopedState(state, "other").cards).toEqual([]);
});
