/** The daily sweep (issue #39) closes an agent's idle work, and only that:
 *  closing a main chat, someone else's session or work that still holds
 *  something would lose work the user is counting on. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store";
import { AgentConversations } from "./conversation";
import { AgentsRuntime } from "./runtime";
import { AgentSweeps, dueSlot, IDLE_MS } from "./sweep";
import { Fleet } from "../fleet";
import { closeDb, getDb, getSessionRecord, insertAccount, insertSessionRecord, insertWait, listSessionRecords, saveSettings, getSettings, updateSessionRecord } from "../db";

let home: string, previous: string | undefined, store: AgentStore, runtime: any, sweeps: AgentSweeps;
let views: Map<string, any>, cards: any[], closes: { id: string; alone: boolean }[];
const NOW = Date.now();
const IDLE = NOW - IDLE_MS - 60_000;

function session(id: string, parent: string | null, at = IDLE, status = "waiting") {
  const transcript = join(home, `${id}.jsonl`);
  writeFileSync(transcript, "{}\n");
  insertSessionRecord({ id, provider: "claude", agentSessionId: `provider-${id}`, accountId: "acct", cwd: home, worktree: null, label: id, claim: 0, origin: "agentbox", tmux: `ab-${id}`, transcriptPath: transcript, startedAt: at, lastActivityAt: at, archivedAt: null, facts: null, createdAt: at, parent } as any);
  views.set(id, { id, status, host: "tmux", lastActivityAt: at, cacheWarmUntil: 0, background: false, queued: [], question: null });
}

beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "agent-sweep-"));
  process.env.AGENTBOX_HOME = home;
  store = new AgentStore(join(home, "runtime.db"));
  views = new Map();
  cards = [];
  closes = [];
  const fleet: any = {
    sessions: () => [...views.values()],
    get: (id: string) => views.get(id),
    serial: async (_id: string, fn: () => any) => fn(),
    tick: async () => {},
    now: () => Date.now(),
    workHeld: () => new Map(),
    hasTranscript: () => true,
    accountFor: () => ({ id: "acct" }),
    resumeCwd: () => home,
    // The board's close, as far as the sweep can tell: the record is archived
    // (never deleted), with what it started unless `alone`.
    close: async (id: string, _closed: boolean, alone: boolean) => {
      closes.push({ id, alone });
      const family = [id];
      for (let i = 0; i < family.length && !alone; i++)
        family.push(...listSessionRecords(0).filter((r) => r.parent === family[i] && !r.archivedAt).map((r) => r.id));
      for (const f of family) {
        updateSessionRecord(f, { archivedAt: Date.now() });
        views.set(f, { ...views.get(f), status: "closed", host: "none" });
      }
      return { closed: family, kept: [], dropped: [], said: "" };
    },
  };
  fleet.closeIfIdle = Fleet.prototype.closeIfIdle.bind(fleet);
  runtime = { store, fleet, cards: { list: () => cards } };
  runtime.works = { list: () => [{ session: "worker", agent: { id: "local-vulcan" }, rounds: [] }], forSession: () => null, writable: () => false, restorable: () => true };
  runtime.conversations = new AgentConversations(runtime);
  runtime.sessionOwnership = AgentsRuntime.prototype.sessionOwnership.bind(runtime);
  sweeps = new AgentSweeps(runtime);
  insertAccount({ id: "acct", provider: "claude", label: "Fixture", email: null, plan: null, home, isDefault: true, enabled: true, createdAt: 1 });
  const a = runtime.conversations.local().find((a: any) => a.id === "local-vulcan");
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify({ ...a, session: "chat", previous: ["old-chat"] }), a.id]);

  session("chat", null);
  session("old-chat", null);
  session("worker", null); // its work record names it
  session("idle", "chat"); // started by the main chat
  session("recent", "chat", NOW - 30 * 60_000);
  session("busy", "chat", IDLE, "running");
  session("waiter", "chat");
  insertWait({ sessionId: "waiter", spec: { kind: "time" } as any, createdAt: IDLE, deadline: NOW + 3_600_000 });
  session("carded", "chat");
  cards.push({ id: 7, kind: "note", title: "PR ready", state: "open", sessionId: "carded", about: null, unread: false });
  session("pr-owner", "chat");
  getDb().run("INSERT INTO pr_claims (repo, number, session_id, at) VALUES (?,?,?,?)", ["o/r", 12, "pr-owner", IDLE]);
  session("parent", "chat");
  session("working-kid", "parent", IDLE, "running");
  session("idle-parent", "chat");
  session("idle-kid", "idle-parent");
  session("stranger", "someone-else");
  session("loner", null);
});
afterEach(() => {
  store.db.close();
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

const archived = (id: string) => !!getSessionRecord(id)?.archivedAt;

test("closes every idle work session, keeps the ones that hold something, and never touches a chat or a stranger", async () => {
  const r = await sweeps.sweep("local-vulcan", NOW);

  expect(r.closed.map((c) => c.id).sort()).toEqual(["idle", "idle-kid", "idle-parent", "worker"]);
  for (const id of ["worker", "idle", "idle-parent", "idle-kid"]) expect(archived(id)).toBe(true);
  // Closed is the board's close: the record and its transcript stay, so it resumes.
  expect(getSessionRecord("idle")?.transcriptPath).toBeTruthy();
  expect(closes.find((c) => c.id === "idle-parent")?.alone).toBe(false);

  const kept = Object.fromEntries(r.kept.map((k) => [k.id, k.why]));
  expect(Object.keys(kept).sort()).toEqual(["carded", "parent", "pr-owner", "waiter"]);
  expect(kept.waiter).toContain("armed wait");
  expect(kept.carded).toContain("open Review card");
  expect(kept["pr-owner"]).toContain("o/r#12");
  expect(kept.parent).toContain("working-kid");

  for (const id of ["chat", "old-chat", "recent", "busy", "waiter", "carded", "pr-owner", "parent", "working-kid", "stranger", "loner"])
    expect(archived(id)).toBe(false);

  // The Feed reads it back.
  expect(sweeps.list("local-vulcan")[0]?.closed.length).toBe(4);
});

test("a session that becomes active, or gains a wait, before its close is left open", async () => {
  runtime.fleet.serial = async (id: string, fn: () => any) => {
    if (id === "idle") views.set("idle", { ...views.get("idle"), lastActivityAt: Date.now() });
    if (id === "worker") insertWait({ sessionId: "worker", spec: { kind: "time" } as any, createdAt: NOW, deadline: NOW + 3_600_000 });
    return fn();
  };
  const r = await sweeps.sweep("local-vulcan", NOW);
  expect(archived("idle")).toBe(false);
  expect(r.closed.map((c) => c.id)).not.toContain("idle");
  expect(archived("worker")).toBe(false);
  expect(r.kept.find((k) => k.id === "worker")?.why).toContain("armed wait");
});

test("the sweep runs once a day at its time, on this machine's clock, and a missed one is not made up next morning", async () => {
  const at = (h: number, m = 0, day = 15) => new Date(2026, 9, day, h, m).getTime();
  expect(dueSlot(at(22, 59), "23:00", null)).toBeNull();
  expect(dueSlot(at(23, 0), "23:00", null)).toBe(at(23, 0));
  expect(dueSlot(at(23, 30), "23:00", at(23, 0))).toBeNull();
  expect(dueSlot(at(2, 0, 16), "23:00", at(23, 0, 14))).toBe(at(23, 0));
  expect(dueSlot(at(9, 0, 16), "23:00", at(23, 0, 14))).toBeNull();
  expect(dueSlot(at(23, 0), "", null)).toBeNull();

  saveSettings({ ...getSettings(), agentSweepAt: "" });
  await sweeps.tick(NOW);
  expect(closes).toEqual([]);
});
