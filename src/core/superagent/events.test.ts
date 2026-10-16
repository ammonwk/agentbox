/** The pr.tend event: each taker gets one hand-off once per PR, head and
 *  sender, never the sender's own agent, and the sender lets go only when an
 *  agent takes it. A second delivery starts a second owner on one PR. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db";
import { prReady, prTend } from "./events";

const HEAD = "a".repeat(40);
let previous: string | undefined, actions: { name: string; values: Record<string, unknown>; session: string | null }[], hub: any;

const agent = (name: string, events: string[]) => ({ name, title: name, enabled: true, error: null, events, projects: null, hasPage: true, process: { state: "running" }, main: null });

beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = mkdtempSync(join(tmpdir(), "agent-events-"));
  actions = [];
  hub = {
    list: () => [agent("cura", ["pr.tend"]), agent("terminus", ["pr.ready", "pr.tend"]), agent("vulcan", [])],
    ownerOf: () => null,
    action: async (name: string, body: { values: Record<string, unknown> }, caller: { session: string | null }) => actions.push({ name, values: body.values, session: caller.session }),
  };
});
afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
});

test("one hand-off per PR, head and sender, to each taker but the sender's own agent", async () => {
  let let_go = 0;
  const pr = { repo: "acme/app", number: 7, head: HEAD, note: "P1: x" };
  const a = await prTend(hub, {} as any, { session: "j1", agent: "terminus" }, pr, () => let_go++);
  expect(a.state).toBe("sent");
  expect(actions).toEqual([{ name: "cura", values: { ...pr, from: "j1", agent: "terminus" }, session: "j1" }]);
  // Again from the same agent, even from its next main: nothing new.
  expect((await prTend(hub, {} as any, { session: "j2", agent: "terminus" }, pr)).state).toBe("already");
  // From the person: a sender of its own, and Terminus takes it too.
  expect((await prTend(hub, {} as any, { session: null, agent: null }, pr)).state).toBe("sent");
  expect(actions.map((x) => x.name)).toEqual(["cura", "cura", "terminus"]);
  expect(let_go).toBe(1);
});

test("with no taker, nothing is given and the sender keeps the PR", async () => {
  hub.list = () => [agent("vulcan", [])];
  let let_go = 0;
  const out = await prTend(hub, {} as any, { session: "s1", agent: null }, { repo: "acme/app", number: 7, head: HEAD, note: null }, () => let_go++);
  expect(out.state).toBe("skipped");
  expect(let_go).toBe(0);
});

test("a taker that refuses it takes nothing: the sender keeps the PR, and the next report tries again", async () => {
  hub.list = () => [agent("cura", ["pr.tend"])];
  hub.action = async () => {
    throw new Error("cura looks after other/repo");
  };
  let let_go = 0;
  const pr = { repo: "acme/app", number: 7, head: HEAD, note: null };
  await expect(prTend(hub, {} as any, { session: "s1", agent: null }, pr, () => let_go++)).rejects.toThrow("did not take it");
  expect(let_go).toBe(0);
  hub.action = async () => {};
  expect((await prTend(hub, {} as any, { session: "s1", agent: null }, pr, () => let_go++)).state).toBe("sent");
  expect(let_go).toBe(1);
});

test("sent back and ready again on one head: each direction goes round again", async () => {
  hub.list = () => [agent("cura", ["pr.tend"]), agent("terminus", ["pr.ready"])];
  hub.ownerOf = (s: string) => (s === "j1" ? "terminus" : s === "o1" ? "cura" : null);
  const pr = { repo: "acme/app", number: 7, head: HEAD };
  expect((await prReady(hub, {} as any, "o1", pr)).state).toBe("sent");
  expect((await prReady(hub, {} as any, "o1", pr)).state).toBe("already");
  // Terminus sends it back on that head; the owner clears it with no new commit.
  expect((await prTend(hub, {} as any, { session: "j1", agent: "terminus" }, { ...pr, note: "a comment is unanswered" })).state).toBe("sent");
  expect((await prReady(hub, {} as any, "o1", pr)).state).toBe("sent");
  expect((await prTend(hub, {} as any, { session: "j1", agent: "terminus" }, { ...pr, note: "still unanswered" })).state).toBe("sent");
  expect((await prTend(hub, {} as any, { session: "j1", agent: "terminus" }, { ...pr, note: "again" })).state).toBe("already");
});
