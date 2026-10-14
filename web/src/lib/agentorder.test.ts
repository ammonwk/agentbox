/** The agents sidebar lists paused and disabled agents last (#27), and the
 *  agents page opens on the first active one (#31), in your order. */
import { expect, test } from "bun:test";
import { firstActiveIn, sidebarOrder, type AgentOption } from "./agentorder";

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
