import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, insertAccount, getSessionRecord, getSchedule, insertSchedule, insertSessionRecord, type SessionRecord } from "../db";
import { Fleet } from "../fleet";
import { Scheduler } from "../scheduler";
import { sendAsAgent } from "../sendguard";
import type { Schedule, Session } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-succession-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  mkdirSync(process.env.HOME, { recursive: true });
  closeDb();
});

afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

function record(id: string, successor: string | null = null): SessionRecord {
  return {
    id, provider: "claude", agentSessionId: null, accountId: null, cwd: "/tmp", worktree: null, label: null, claim: 1,
    origin: "agentbox", tmux: null, transcriptPath: null, startedAt: NOW, lastActivityAt: NOW, archivedAt: null,
    facts: null, createdAt: NOW, successor,
  };
}

/** Only what the send rules and the scheduler read of a session. */
function session(id: string, over: Partial<Session> = {}): Session {
  return { id, host: "tmux", status: "waiting", cold: false, cacheWarmUntil: NOW + 3_600_000, contextUsed: 30_000, limitHit: null, ...over } as Session;
}

describe("a session another has taken over", () => {
  test("its id leads to the last one that took over, and a loop ends", () => {
    insertSessionRecord(record("a1", "b1"));
    insertSessionRecord(record("b1", "c1"));
    insertSessionRecord(record("c1"));
    insertSessionRecord(record("x1", "y1"));
    insertSessionRecord(record("y1", "x1"));
    const heir = (id: string) => Fleet.prototype.heir.call(null, id);
    expect(heir("a1")).toBe("c1");
    expect(heir("c1")).toBe("c1");
    expect(heir("x1")).toBe("y1");
  });

  function fakeFleet(sessions: Session[], successors: Record<string, string>) {
    const sent: { to: string; text: string; wake: boolean }[] = [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return {
      sent,
      get: (id: string) => byId.get(id)!,
      heir: (id: string) => successors[id] ?? id,
      send: async (to: string, text: string, _attempt?: unknown, wake?: boolean) => void sent.push({ to, text, wake: !!wake }),
    } as unknown as Pick<Fleet, "get" | "heir" | "send"> & { sent: typeof sent };
  }

  test("an agent's message to it goes to its heir, even with --wake, told who it was for", async () => {
    const fleet = fakeFleet([session("old", { host: "none", status: "closed" }), session("new")], { old: "new" });
    const out = await sendAsAgent(fleet, "old", "#8663 is green and clean", { from: "w1", wake: true }, NOW);
    expect(out).toEqual({ to: "new" });
    expect(fleet.sent).toEqual([{ to: "new", text: "[via agentbox send from w1] [sent to old, which you took over from] #8663 is green and clean", wake: true }]);
  });

  test("refused as its heir would be, saying so", async () => {
    const fleet = fakeFleet([session("old", { host: "none", status: "closed" }), session("new", { cold: true })], { old: "new" });
    const out = await sendAsAgent(fleet, "old", "hi", { from: "w2", wake: false }, NOW);
    expect("refused" in out && out.refused).toStartWith("old has been taken over by new. not sent: new has a cold prompt cache");
    expect(fleet.sent).toEqual([]);
  });

  test("a session nobody took over is sent to as before", async () => {
    const fleet = fakeFleet([session("solo")], {});
    expect(await sendAsAgent(fleet, "solo", "hi", { from: "w3", wake: false }, NOW)).toEqual({ to: "solo" });
    expect(fleet.sent[0]!.text).toBe("[via agentbox send from w3] hi");
  });
});

describe("a schedule that keeps to one session", () => {
  test("one that got busy while it was being replaced is handed over at once and closed once its turn ends", async () => {
    const sessions = new Map<string, Session>([["old", session("old")]]);
    const calls: string[] = [];
    const fleet = {
      get: (id: string) => {
        const s = sessions.get(id);
        if (!s) throw new Error(`no session ${id}`);
        return s;
      },
      spawn: async () => {
        // A message wakes the old one while the new one starts.
        sessions.set("old", session("old", { status: "running" }));
        sessions.set("new", session("new", { contextUsed: 0 }));
        return { session: sessions.get("new")! };
      },
      patch: async () => {},
      startedBy: () => [],
      handOver: async (from: string, to: string) => void calls.push(`handOver ${from}→${to}`),
      close: async (id: string) => {
        calls.push(`close ${id}`);
        sessions.set(id, session(id, { status: "closed" }));
      },
    } as unknown as Fleet;
    const sched: Schedule = {
      id: "st1", rule: { kind: "every", minutes: 10, from: NOW }, spec: { provider: "claude", cwd: "/tmp", worktree: false, prompt: "tick" } as Schedule["spec"],
      label: "Steward", enabled: true, nextAt: NOW + 600_000, createdAt: NOW, lastRunAt: null, lastSessionId: "old", lastError: null,
      noteCmd: null, sameSession: true, freshOver: 20_000, retiring: null,
    };
    insertSchedule(sched);
    const scheduler = new Scheduler(fleet, () => {}, () => NOW);

    expect(await scheduler.runNow("st1")).toBe("new");
    expect(calls).toEqual(["handOver old→new"]);
    expect(getSchedule("st1")!.retiring).toBe("old");

    await scheduler.tick();
    expect(calls).toEqual(["handOver old→new"]);

    sessions.set("old", session("old"));
    await scheduler.tick();
    expect(calls).toEqual(["handOver old→new", "handOver old→new", "close old"]);
    expect(getSchedule("st1")!.retiring).toBeNull();
  });
});


test("late pane discovery attaches only the proven new provider identity, preserving an alias", () => {
  const now = NOW + 20 * 60_000;
  insertAccount({id:"own-account",provider:"codex",label:"Fixture",email:null,plan:null,home:dir,isDefault:true,enabled:true,createdAt:NOW});
  const pending = { ...record("late-spawn"), provider: "codex" as const, tmux: "ab-late-spawn", accountId: "own-account", cwd: "/tmp/own-writer" };
  const discovered = { ...pending, id: "late-discovery", origin: "external" as const, tmux: null, agentSessionId: "provider-own", createdAt: NOW + 1000, transcriptPath: "/tmp/provider-own.jsonl" };
  insertSessionRecord(pending); insertSessionRecord(discovered);
  const proc = { pid: 345, provider: "codex", accountId: "other-account", agentSessionId: "provider-own", cwd: pending.cwd, startedAt: NOW + 1000 };
  const fleet: any = Object.create(Fleet.prototype);
  Object.assign(fleet, { panes: new Map([[pending.tmux, { pid: 345, dead: false }]]), livePids: new Map([[345, proc]]), tracked: new Map(), byAgentId: new Map() });
  fleet.matchPendingSpawns(now);
  expect(getSessionRecord(pending.id)!.agentSessionId).toBeNull();
  proc.accountId = pending.accountId;
  proc.cwd = "/tmp/another-writer";
  fleet.matchPendingSpawns(now);
  expect(getSessionRecord(pending.id)!.agentSessionId).toBeNull();
  proc.cwd = pending.cwd;
  proc.startedAt = NOW - 60_000;
  fleet.matchPendingSpawns(now);
  expect(getSessionRecord(pending.id)!.agentSessionId).toBeNull();
  proc.startedAt = NOW + 1000;
  fleet.matchPendingSpawns(now);
  expect(getSessionRecord(pending.id)!.agentSessionId).toBe("provider-own");
  expect(getSessionRecord(pending.id)!.transcriptPath).toBe(discovered.transcriptPath);
  expect(getSessionRecord(discovered.id)!.successor).toBe(pending.id);
  expect(getSessionRecord(discovered.id)!.archivedAt).toBe(now);
  expect(getSessionRecord(discovered.id)!.agentSessionId).toBeNull();
  expect(fleet.byAgentId.get("codex:provider-own")).toBe(pending.id);
});
