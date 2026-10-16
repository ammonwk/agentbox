/** The agents sidebar lists paused and disabled agents last (#27), and the
 *  agents page opens on the first active one (#31), in your order. */
import { expect, test } from "bun:test";
import { dropAgent, firstActiveIn, sidebarOrder, type AgentOption } from "./agentorder";

const agent = (id: string, activity: AgentOption["activity"]): AgentOption => ({ id, name: id, role: "", detail: "", activity });
const options = [agent("jupiter", "paused"), agent("vulcan", "waiting"), agent("salus", "idle"), agent("caelus", "paused"), agent("terminus", "working")];

test("paused agents go last, and each part keeps your order", () => {
  expect(sidebarOrder(options, []).map((a) => a.id)).toEqual(["vulcan", "salus", "terminus", "jupiter", "caelus"]);
  expect(sidebarOrder(options, ["caelus", "terminus", "jupiter", "salus"]).map((a) => a.id)).toEqual(["terminus", "salus", "vulcan", "caelus", "jupiter"]);
});

test("the page opens on the first active agent, or the first one when all are paused", () => {
  expect(firstActiveIn(options, [])?.id).toBe("vulcan");
  expect(firstActiveIn([agent("jupiter", "paused"), agent("caelus", "paused")], [])?.id).toBe("jupiter");
  expect(firstActiveIn([], [])).toBeUndefined();
});

// The agentbox tab: Jupiter and Vulcan active, the rest paused.
const tab = [agent("vulcan", "waiting"), agent("jupiter", "working"), agent("caelus", "paused"), agent("salus", "paused"), agent("terminus", "paused")];
const shown = (ids: string[]) => sidebarOrder(tab, ids).map((a) => a.id);

test("an agent can be dropped on any agent, and lands at the nearest end of its own part", () => {
  // Dropped below the paused agents, Jupiter goes below Vulcan, the last active agent.
  const down = dropAgent(tab, [], "jupiter", "terminus", "after");
  expect(shown(down.ids)).toEqual(["vulcan", "jupiter", "caelus", "salus", "terminus"]);
  expect(down.line).toBeNull();
  const vulcan = dropAgent(tab, [], "vulcan", "salus", "before");
  expect(shown(vulcan.ids)).toEqual(["jupiter", "vulcan", "caelus", "salus", "terminus"]);
  expect(vulcan.line).toEqual({ id: "jupiter", at: "after" });
  // A paused agent dropped among the active ones goes to the top of the paused ones.
  const up = dropAgent(tab, [], "terminus", "vulcan", "before");
  expect(shown(up.ids)).toEqual(["vulcan", "jupiter", "terminus", "caelus", "salus"]);
  expect(up.line).toEqual({ id: "jupiter", at: "after" });
});

test("a drop keeps your place for an agent alone in its part, for when the others resume", () => {
  const alone = [agent("jupiter", "working"), ...tab.filter((a) => a.id !== "jupiter" && a.id !== "vulcan"), agent("vulcan", "paused")];
  const drop = dropAgent(alone, [], "jupiter", "salus", "after");
  expect(drop.line).toBeNull();
  const resumed = alone.map((a) => (a.id === "caelus" || a.id === "salus" ? { ...a, activity: "idle" as const } : a));
  expect(sidebarOrder(resumed, drop.ids).map((a) => a.id)).toEqual(["caelus", "salus", "jupiter", "terminus", "vulcan"]);
});
