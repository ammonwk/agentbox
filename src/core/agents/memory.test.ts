/** Rollover replaces a live agent conversation. These guard the rules whose
 * breakage loses or duplicates a message, runs two writers, or lets one
 * agent read another's memory. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store";
import { AgentConversations, CHECKPOINT_MARK, type LocalAgent } from "./conversation";
import { AgentWorks } from "./work";
import type { AgentsRuntime } from "./runtime";
import { closeDb, getSessionRecord, insertSessionRecord, updateSessionRecord } from "../db";

let home: string, previous: string | undefined, store: AgentStore, conversations: AgentConversations;
let views: Map<string, any>, prompts: Map<string, string[]>, spawns: any[], typed: { id: string; text: string }[], handed: string[][];
let fleet: any, runtime: AgentsRuntime, placements: Record<string, "auto" | "overflow" | "none">;
const NOW = Date.now();
const handoff = { intent: "Ship the memory feature", decisions: [{ decision: "Use the warm cache clock", why: "one clock" }], refs: [{ label: "PR", ref: "https://github.com/o/r/pull/1" }] };

function record(id: string, transcript = false) {
  const transcriptPath = transcript ? join(home, `${id}.jsonl`) : null;
  if (transcriptPath) writeFileSync(transcriptPath, "{}\n");
  insertSessionRecord({ id, provider: "codex", agentSessionId: id, accountId: null, cwd: home, worktree: null, label: null, claim: 0, origin: "agentbox", tmux: `ab-${id}`, transcriptPath, startedAt: NOW, lastActivityAt: NOW, archivedAt: null, facts: null, createdAt: NOW } as any);
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
  placements = { claude: "auto", codex: "auto" };
  fleet = {
    placement: (provider: string) => ({ provider, accountId: placements[provider] === "none" ? null : `${provider}-1`, mode: placements[provider] ?? "none", claim: 0, candidates: [], why: placements[provider] === "none" ? `${provider} is at its weekly limit` : "room" }),
    sessions: () => [...views.values()],
    tick: async () => {},
    timeline: async (id: string) => ({ events: (prompts.get(id) ?? []).map((text, i) => ({ id: String(i), at: i, kind: "user", text })) }),
    stopHold: async () => null,
    stopSession: async (id: string) => view(id, { ...views.get(id), host: "none", pid: null }),
    spawn: async (opts: any) => {
      spawns.push(opts);
      record(opts.id, true);
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
  conversations.proofMs = 900;
  conversations.installed = async () => true;
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

test("a successor that never started leaves the old conversation current, and it gets the message", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  fleet.spawn = async () => {
    throw new Error("no account can take it");
  };
  await fleet.send("old", "Hello");
  const a = agent();
  expect(a.session).toBe("old");
  expect(a.rollover).toBeUndefined();
  expect(a.rolled).toBeUndefined();
  expect(a.checkpoint?.state).toBe("failed");
  expect(getSessionRecord("old")?.parkedAt).toBeTruthy();
  expect(handed).toHaveLength(0);
  expect(typed.at(-1)).toEqual({ id: "old", text: "Hello" });
});

test("a successor whose CLI exits before writing its transcript is stopped and undone", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  let stopped = "";
  fleet.spawn = async (opts: any) => {
    spawns.push(opts);
    record(opts.id);
    view(opts.id, { host: "tmux", pid: 7 });
  };
  const stop = fleet.stopSession;
  fleet.stopSession = async (id: string) => {
    stopped = id;
    return stop(id);
  };
  await fleet.send("old", "Hello");
  expect(stopped).toBe(spawns[0].id);
  expect(agent().session).toBe("old");
  expect(handed).toHaveLength(0);
  expect(typed.filter((t) => t.text === "Hello")).toEqual([{ id: "old", text: "Hello" }]);
});

test("restart reconciliation finishes a started successor and undoes one that never recorded", async () => {
  record("next", true);
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

test("Automatic keeps a warm conversation on its provider, and a cold one keeps it while it has room", async () => {
  link("old", { provider: "codex" });
  await checkpointed("old");
  placements = { claude: "auto", codex: "overflow" };
  await fleet.send("old", "Still warm");
  expect(spawns).toHaveLength(0);
  expect(typed.at(-1)).toEqual({ id: "old", text: "Still warm" });
  view("old", { lastActivityAt: NOW - 15 * 60_000 });
  await checkpointed("old");
  placements = { claude: "auto", codex: "auto" };
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Cold now");
  expect(spawns[0].provider).toBe("codex");
  expect(agent().selection?.why).toMatch(/Codex, as before/);
});

test("a cold rollover moves to the provider with room and records why before stopping anything", async () => {
  link("old", { provider: "codex" });
  await checkpointed("old");
  placements = { claude: "auto", codex: "none" };
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Switch please");
  expect(spawns[0].provider).toBe("claude");
  const a = agent();
  expect(a.provider).toBe("claude");
  expect(a.selection?.why).toMatch(/Codex: codex is at its weekly limit/);
  expect(a.contexts?.[a.session!]?.map((x) => x.session)).toEqual(["old"]);
});

test("with no provider available, or an exhausted explicit override, the old conversation keeps the message", async () => {
  link("old", { provider: "codex" });
  await checkpointed("old");
  placements = { claude: "none", codex: "none" };
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Anyone?");
  expect(spawns).toHaveLength(0);
  expect(agent().session).toBe("old");
  expect(agent().rollover).toBeUndefined();
  expect(typed.at(-1)).toEqual({ id: "old", text: "Anyone?" });
  placements = { claude: "auto", codex: "none" };
  link("old", { provider: "codex", pinned: "codex" });
  await fleet.send("old", "Pinned");
  expect(spawns).toHaveLength(0);
});

test("a cold conversation without a fresh handoff stays put even when its provider can take nothing", async () => {
  link("old", { provider: "codex" });
  conversations.saveNote("local-vulcan", "old", crypto.randomUUID(), { decision: "Keep going" });
  placements = { claude: "auto", codex: "none" };
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Hello after the limit");
  expect(spawns).toHaveLength(0);
  expect(agent().session).toBe("old");
  expect(typed.at(-1)).toEqual({ id: "old", text: "Hello after the limit" });
});

test("a provider whose CLI is not installed is never chosen, whatever its placement says", async () => {
  link("old", { provider: "codex" });
  await checkpointed("old");
  placements = { claude: "auto", codex: "auto" };
  conversations.installed = async (p) => p !== "codex";
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Which one?");
  expect(spawns[0].provider).toBe("claude");
  expect(spawns[0].accountId).toBe("claude-1");
  expect(agent().selection).toMatchObject({ provider: "claude", accountId: "claude-1" });
  expect(agent().selection?.why).toMatch(/Codex: its CLI is not installed/);
  // None installed: nothing is stopped, the old conversation keeps the next message.
  view(agent().session!, { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  conversations.installed = async () => false;
  const before = spawns.length;
  await fleet.send(agent().session!, "Still there?");
  expect(spawns).toHaveLength(before);
});

test("a restart during a recorded provider switch finishes on the chosen provider", async () => {
  record("next", true);
  link("next", { provider: "codex", previous: ["old"], rollover: { from: "old", to: "next", handoff: "h", why: "cold", at: NOW, phase: "spawning", provider: "claude", selection: { provider: "claude", accountId: "claude-1", model: null, policy: "auto", why: "Claude has room.", at: NOW } } });
  await (conversations as any).remember();
  expect(agent().provider).toBe("claude");
  expect(agent().selection?.why).toBe("Claude has room.");
});

test("a never-started agent's first message starts on a provider with room, and refuses cleanly when none has", async () => {
  link(null as any, { provider: "codex", previous: [] });
  placements = { claude: "none", codex: "none" };
  const refused = await conversations.localSend("local-vulcan", crypto.randomUUID(), "Hi").catch((e) => ({ state: "refused", result: e.message }));
  expect(refused.state).toBe("refused");
  expect(spawns).toHaveLength(0);
  expect(agent().session).toBeNull();
  placements = { claude: "auto", codex: "none" };
  const sent = await conversations.localSend("local-vulcan", crypto.randomUUID(), "Hi again");
  expect(sent.state).toBe("sent");
  expect(spawns[0].provider).toBe("claude");
  expect(agent().provider).toBe("claude");
  expect(agent().pinned).toBeUndefined();
});

test("a full bootstrap records exactly the summaries whose text it carried, and history follows that record", async () => {
  const m = conversations.memory;
  const w = (n: number, c: string) => c.repeat(n);
  const max = () => ({
    intent: w(1200, "i"),
    decisions: Array.from({ length: 12 }, () => ({ decision: w(400, "d"), why: w(600, "y") })),
    open: Array.from({ length: 10 }, () => w(400, "o")),
    commitments: Array.from({ length: 10 }, () => w(400, "c")),
    refs: Array.from({ length: 20 }, (_, i) => ({ label: `ref${i}`, ref: w(500, "r") })),
  });
  const ancient = m.handoff("local-vulcan", crypto.randomUUID(), "ancient", { intent: "Ancient calendar work" }, null);
  const first = m.handoff("local-vulcan", crypto.randomUUID(), "first", { ...max(), intent: `Older parser work ${w(1100, "p")}` }, null);
  const big = m.handoff("local-vulcan", crypto.randomUUID(), "old", max(), null);
  for (const pref of Array.from({ length: 10 }, (_, i) => ({ key: `pref-${i}`, text: w(390, "x") }))) m.prefer("local-vulcan", null, pref);
  const boot = m.bootstrap("local-vulcan", big.id, "parser calendar");
  expect(boot.text.length).toBeLessThanOrEqual(12_000);
  expect(boot.text).toContain(`read it with the show command for ${big.id}`);
  // Recorded if, and only if, its text went in.
  for (const h of [ancient, first, big]) expect(boot.supplied.some((x) => x.handoff === h.id)).toBe(boot.text.includes(h.id));
  expect(boot.supplied[0]?.handoff).toBe(big.id);
  // Across sizes, the budget both carries and leaves out earlier summaries, and the record always matches.
  let carried = 0, left = 0;
  for (const n of [40, 200, 400, 600, 800, 1000]) {
    const scope = `size-${n}`;
    const older = m.handoff(scope, crypto.randomUUID(), "s1", { intent: `parser ${w(n, "q")}` }, null);
    const latest = m.handoff(scope, crypto.randomUUID(), "s2", max(), null);
    const b = m.bootstrap(scope, latest.id, "parser");
    expect(b.text.length).toBeLessThanOrEqual(12_000);
    expect(b.supplied.some((x) => x.handoff === older.id)).toBe(b.text.includes(older.id));
    if (b.text.includes(older.id)) carried++;
    else left++;
  }
  expect(carried).toBeGreaterThan(0);
  expect(left).toBeGreaterThan(0);
  record("next", true);
  view("next");
  link("next", { previous: ["old", "first", "ancient"], contexts: { next: boot.supplied } });
  for (const h of [ancient, first].filter((h) => !boot.supplied.some((x) => x.handoff === h.id)))
    await expect(conversations.page("local-vulcan", { session: 0, target: "next", history: h.session, before: null })).rejects.toThrow("not carried");
});

test("a five-minute cache is asked for its handoff while still warm, once per activity", async () => {
  const t = Date.now();
  // 1 minute idle: too early.
  view("old", { lastActivityAt: t - 60_000, cacheWarmUntil: t + 4 * 60_000 });
  await (conversations as any).remember();
  expect(agent().checkpoint).toBeUndefined();
  // 2.6 minutes idle, 2.4 left: asked.
  view("old", { lastActivityAt: t - 156_000, cacheWarmUntil: t + 144_000 });
  await (conversations as any).remember();
  expect(agent().checkpoint?.state).toBe("requested");
  conversations.saveHandoff("local-vulcan", "old", agent().checkpoint!.request, handoff);
  // Its reply refreshed the five minutes: not asked again without new activity.
  view("old", { lastActivityAt: Date.now() - 156_000, cacheWarmUntil: Date.now() + 144_000 });
  await (conversations as any).remember();
  expect(typed.filter((x) => x.text.startsWith(CHECKPOINT_MARK))).toHaveLength(1);
  // Too late: under two minutes left means no request at all.
  link("old", { checkpoint: undefined });
  prompts.set("old", ["a real prompt"]);
  view("old", { lastActivityAt: Date.now() - 200_000, cacheWarmUntil: Date.now() + 100_000 });
  await (conversations as any).remember();
  expect(agent().checkpoint).toBeUndefined();
});
