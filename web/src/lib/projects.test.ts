/** A project's Review page shows the cards its sessions handed you. */
import { expect, test } from "bun:test";
import type { AppState, Card } from "../../../src/core/types";
import type { LocalAgent } from "../../../src/core/agents/conversation";
import { scopedState } from "./projects";

const agent = (name: string, session: string | null, repo: string | null) => ({ id: name, name, session, repo, project: repo ?? undefined, previous: [] }) as unknown as LocalAgent;
const card = { id: 1, kind: "decision", title: "t", short: "s", pr: null, about: null, sessionId: "s1", state: "open" } as unknown as Card;
const state = { repos: [{ id: "p" }], sessions: [], cards: [card], schedules: [] } as unknown as AppState;

test("a card about nothing belongs to the project of the agent session that added it", () => {
  // An idle agent has no session: a card's empty `about` must not match it.
  const agents = [agent("idle", null, null), agent("vulcan", "s1", "p")];
  expect(scopedState(state, "p", agents).cards.map((c) => c.id)).toEqual([1]);
  expect(scopedState(state, "other", agents).cards).toEqual([]);
});
