/** An agent's header is Chat, Feed and Settings (#35); an old About link
 *  opens Settings. */
import { expect, test } from "bun:test";
import { AGENT_TABS, agentViewOf } from "./agentviews";
import { parseHash } from "../route";

test("the header's tabs are Chat, Feed and Settings", () => {
  expect(AGENT_TABS).toEqual(["chat", "feed", "settings"]);
});

test("an old About link opens Settings, and its thread stays", () => {
  expect(agentViewOf("about")).toBe("settings");
  expect(parseHash("#/agents/local-vulcan/about")).toEqual({ page: "agents", id: "local-vulcan", view: "settings" });
  expect(parseHash("#/agents/a1/about/s9")).toEqual({ page: "agents", id: "a1", view: "settings", thread: "s9" });
});

test("known views keep their name, and anything else opens Chat", () => {
  expect(["feed", "settings", "sessions", "chat", "nonsense"].map(agentViewOf)).toEqual(["feed", "settings", "sessions", "chat", "chat"]);
});
