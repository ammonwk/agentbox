/** Rollover replaces a live agent conversation. These guard the rules whose
 * breakage loses or duplicates a message, runs two writers, or lets one
 * agent read another's memory. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store";
import { AgentConversations, CHECKPOINT_MARK, type LocalAgent } from "./conversation";
import { AgentWorks } from "./work";
import type { AgentsRuntime } from "./runtime";
import { closeDb, getSessionRecord, insertSessionRecord, updateSessionRecord } from "../db";

let home: string, previous: string | undefined, store: AgentStore, conversations: AgentConversations;
let views: Map<string, any>, prompts: Map<string, string[]>, spawns: any[], typed: { id: string; text: string }[], handed: string[][];
let fleet: any, runtime: AgentsRuntime;
const NOW = Date.now();
const handoff = { intent: "Ship the memory feature", decisions: [{ decision: "Use the warm cache clock", why: "one clock" }], refs: [{ label: "PR", ref: "https://github.com/o/r/pull/1" }] };

function record(id: string) {
  insertSessionRecord({ id, provider: "codex", agentSessionId: id, accountId: null, cwd: home, worktree: null, label: null, claim: 0, origin: "agentbox", tmux: null, transcriptPath: null, startedAt: NOW, lastActivityAt: NOW, archivedAt: null, facts: null, createdAt: NOW } as any);
}
function view(id: string, over: Record<string, unknown> = {}) {
  views.set(id, { id, status: "waiting", host: "tmux", pid: 1, queued: [], question: null, limitHit: null, contextUsed: 10, contextLimit: 100, cacheWarmUntil: NOW + 30 * 60_000, lastActivityAt: NOW - 20 * 60_000, ...over });
}
function agent(): LocalAgent {
  return conversations.local().find((a) => a.id === "local-vulcan")!;
}
function link(session: string, change: Partial<LocalAgent> = {}) {
  const a = { ...agent(), session, ...change };
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(a), a.id]);
}
/** The conversation took a checkpoint request and its handoff was saved. */
async function checkpointed(session: string) {
  await (conversations as any).remember();
  const c = agent().checkpoint!;
  expect(c.state).toBe("requested");
  conversations.saveHandoff("local-vulcan", session, c.request, handoff);
  return c.request;
}

beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "agent-memory-"));
  process.env.AGENTBOX_HOME = home;
  store = new AgentStore(join(home, "runtime.db"));
  views = new Map();
  prompts = new Map();
  spawns = [];
  typed = [];
  handed = [];
  fleet = {
    sessions: () => [...views.values()],
    tick: async () => {},
    timeline: async (id: string) => ({ events: (prompts.get(id) ?? []).map((text, i) => ({ id: String(i), at: i, kind: "user", text })) }),
    stopHold: async () => null,
    stopSession: async (id: string) => view(id, { ...views.get(id), host: "none", pid: null }),
    spawn: async (opts: any) => {
      spawns.push(opts);
      record(opts.id);
      view(opts.id, { lastActivityAt: Date.now(), cacheWarmUntil: Date.now() + 60 * 60_000 });
    },
    send: async (id: string, text: string, attempt?: () => void) => {
      if (await conversations.deliver(id, text, attempt)) return;
      attempt?.();
      typed.push({ id, text });
      prompts.set(id, [...(prompts.get(id) ?? []), text]);
    },
    handOver: async (from: string, to: string) => {
      handed.push([from, to]);
      updateSessionRecord(from, { successor: to });
    },
    close: async (id: string) => updateSessionRecord(id, { archivedAt: Date.now() }),
    heir: (id: string) => id,
    startedBy: () => [],
  };
  runtime = { store, fleet, cards: { add: () => {}, list: () => [], close: () => {} }, coordinators: () => [] } as unknown as AgentsRuntime;
  Object.assign(runtime, { works: new AgentWorks(runtime) });
  conversations = new AgentConversations(runtime);
  conversations.local();
  record("old");
  view("old");
  link("old");
});
afterEach(() => {
  store.db.close();
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("an idle warm conversation is asked once; its own reply never triggers another checkpoint", async () => {
  const request = await checkpointed("old");
  expect(typed.filter((t) => t.text.startsWith(CHECKPOINT_MARK))).toHaveLength(1);
  expect(typed[0]!.text).toContain(`--request ${request}`);
  // The checkpoint and its reply refreshed the cache and the activity time.
  view("old", { lastActivityAt: Date.now() - 20 * 60_000, cacheWarmUntil: Date.now() + 50 * 60_000 });
  await (conversations as any).remember();
  await (conversations as any).remember();
  expect(typed).toHaveLength(1);
  expect(agent().checkpoint?.state).toBe("saved");
});

test("a cold conversation with a saved handoff continues in a successor that gets the message once", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  let attempts = 0;
  await fleet.send("old", "What next?", () => attempts++);
  const a = agent();
  expect(spawns).toHaveLength(1);
  expect(a.session).toBe(spawns[0].id);
  expect(attempts).toBe(1);
  expect(spawns[0].prompt).toContain("Ship the memory feature");
  expect(spawns[0].prompt.endsWith("User: What next?")).toBe(true);
  expect(handed).toEqual([["old", a.session!]]);
  expect(a.rolled).toEqual({ old: a.session! });
  expect(a.previous[0]).toBe("old");
  // Main-chat history is exactly what the first prompt carried, nothing older.
  expect(a.contexts?.[a.session!]?.map((x) => x.session)).toEqual(["old"]);
  await expect(conversations.page("local-vulcan", { session: 0, target: a.session!, history: "older", before: null })).rejects.toThrow("not carried");
  expect(typed.filter((t) => t.id === "old" && !t.text.startsWith(CHECKPOINT_MARK))).toHaveLength(0);
  // A message still addressed to the replaced conversation reaches the successor, not the old one.
  await fleet.send("old", "Late wait result");
  expect(typed.map((t) => t.id).filter((id) => id === "old")).toHaveLength(1);
  expect(typed.at(-1)).toEqual({ id: a.session!, text: "Late wait result" });
  expect(conversations.replacedBy("old")).toBe(a.session);
  expect(conversations.continues("old", a.session)).toBe(true);
});

test("a real prompt after the checkpoint keeps the old conversation; nothing is dropped", async () => {
  await checkpointed("old");
  prompts.set("old", [...prompts.get("old")!, "[via agentbox send from x] a reply arrived"]);
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Continue please");
  expect(spawns).toHaveLength(0);
  expect(agent().session).toBe("old");
  expect(typed.at(-1)).toEqual({ id: "old", text: "Continue please" });
});

test("a warm conversation within its context budget is never replaced, even with a handoff", async () => {
  await checkpointed("old");
  await fleet.send("old", "Quick follow-up");
  expect(spawns).toHaveLength(0);
  view("old", { contextUsed: 70 });
  await fleet.send("old", "Another");
  // The follow-up made the handoff stale, so even past the budget it stays.
  expect(spawns).toHaveLength(0);
});

test("a successor that never started leaves the old conversation current and resumable", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  fleet.spawn = async () => {
    throw new Error("no account can take it");
  };
  await expect(fleet.send("old", "Hello")).rejects.toThrow("no account");
  const a = agent();
  expect(a.session).toBe("old");
  expect(a.rollover).toBeUndefined();
  expect(a.rolled).toBeUndefined();
  expect(a.checkpoint?.state).toBe("failed");
  expect(getSessionRecord("old")?.parkedAt).toBeTruthy();
  expect(handed).toHaveLength(0);
});

test("restart reconciliation finishes a started successor and undoes one that never recorded", async () => {
  record("next");
  link("next", { previous: ["old"], rollover: { from: "old", to: "next", handoff: "h", why: "cold", at: NOW, phase: "spawning" } });
  expect(conversations.replacedBy("old")).toBe("next");
  await expect(conversations.deliver("old", "during")).rejects.toThrow("being continued");
  await (conversations as any).remember();
  expect(agent().rolled).toEqual({ old: "next" });
  expect(handed).toEqual([["old", "next"]]);

  link("old", { previous: [], rolled: undefined, rollover: { from: "old", to: "ghost", handoff: "h", why: "cold", at: NOW - 2 * 60_000, phase: "spawning" } });
  await (conversations as any).remember();
  expect(agent().session).toBe("old");
  expect(agent().rollover).toBeUndefined();
});

test("memory stays inside its agent and refuses oversized or credential-bearing handoffs", async () => {
  const other = conversations.local().find((a) => a.id === "local-caelus")!;
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify({ ...other, session: "caelus-chat" }), other.id]);
  conversations.saveNote("local-vulcan", "old", crypto.randomUUID(), { decision: "Private Vulcan decision" });
  expect(() => conversations.memoryView("local-vulcan", "caelus-chat")).toThrow("current conversation");
  expect(() => conversations.saveNote("local-vulcan", "caelus-chat", crypto.randomUUID(), { decision: "x" })).toThrow();
  expect(conversations.memoryView("local-caelus", "caelus-chat").results).toEqual([]);
  expect(conversations.memoryView("local-caelus", "caelus-chat", "Private").results).toEqual([]);
  expect(conversations.memoryView("local-vulcan", null, "Private").results).toHaveLength(1);
  expect(() => conversations.saveHandoff("local-vulcan", "old", crypto.randomUUID(), { intent: "Long", decisions: Array.from({ length: 12 }, () => ({ decision: "word ".repeat(70).trim() })) })).toThrow("words");
  expect(() => conversations.saveNote("local-vulcan", "old", crypto.randomUUID(), { decision: "token ghp_abcdefghijklmnopqrstuvwxyz0123" })).toThrow("credentials");
  // An operator (no session) cannot forge an agent's handoff.
  expect(() => conversations.saveHandoff("local-vulcan", null, crypto.randomUUID(), handoff)).toThrow();
});
