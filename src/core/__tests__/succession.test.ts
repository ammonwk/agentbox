import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, insertAccount, getSessionRecord, getSchedule, insertSchedule, insertSessionRecord, type SessionRecord } from "../db";
import { Fleet, FleetError, type SpawnRequest } from "../fleet";
import { Scheduler } from "../scheduler";
import { sendAsAgent } from "../sendguard";
import type { Placement, ProviderId, Schedule, Session } from "../types";

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
    facts: null, createdAt: NOW, successor, scope: "personal",
  };
}

/** Only what the send rules and the scheduler read of a session. */
function session(id: string, over: Partial<Session> = {}): Session {
  return { id, provider: "claude", host: "tmux", status: "waiting", cold: false, cacheWarmUntil: NOW + 3_600_000, contextUsed: 30_000, limitHit: null, ...over } as Session;
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

  test("one compacted since its last note is kept, and that note carries the prompt again, once", async () => {
    let now = NOW;
    const steward = session("steward", { compactedAt: NOW + 30_000, contextUsed: 35_000 });
    const notes: string[] = [];
    const fleet = {
      get: () => steward,
      note: async (_id: string, text: string) => void notes.push(text),
    } as unknown as Fleet;
    insertSchedule({
      id: "st2", rule: { kind: "every", minutes: 10, from: NOW }, spec: { provider: "claude", cwd: dir, worktree: false, prompt: "read the manual" } as Schedule["spec"],
      label: "Steward", enabled: true, nextAt: NOW + 600_000, createdAt: NOW, lastRunAt: NOW, lastSessionId: "steward", lastError: null,
      noteCmd: "echo 'PR 9 is red'", sameSession: true, freshOver: 600_000, retiring: null,
    });
    const scheduler = new Scheduler(fleet, () => {}, () => now);

    now = NOW + 60_000;
    expect(await scheduler.runNow("st2")).toBe("steward");
    now = NOW + 120_000;
    expect(await scheduler.runNow("st2")).toBe("steward");
    expect(notes).toEqual([
      "[via agentbox schedule st2] PR 9 is red\n\n[agentbox: you were compacted since this schedule last spoke to you, so here is what it started you with again]\n\nread the manual",
      "[via agentbox schedule st2] PR 9 is red",
    ]);
  });

  test("with no account with room, its fallbacks are tried in order, and it goes back once its own has room", async () => {
    let room: ProviderId[] = ["omp"];
    const sessions = new Map<string, Session>([["home", session("home", { provider: "claude", limitHit: { at: NOW } as Session["limitHit"] })]]);
    const asked: SpawnRequest[] = [];
    const notes: string[] = [];
    const fleet = {
      get: (id: string) => sessions.get(id)!,
      placement: (provider: ProviderId) => ({ accountId: room.includes(provider) ? "acct" : null }),
      spawn: async (req: SpawnRequest) => {
        asked.push(req);
        if (!room.includes(req.provider)) throw new FleetError(409, `every ${req.provider} account is at its limit`, {} as Placement);
        const id = `s${asked.length}`;
        sessions.set(id, session(id, { provider: req.provider, contextUsed: 0 }));
        return { session: sessions.get(id)! };
      },
      note: async (_id: string, text: string) => void notes.push(text),
      patch: async () => {},
      startedBy: () => [],
      handOver: async () => {},
      close: async () => {},
    } as unknown as Fleet;
    insertSchedule({
      id: "st3", rule: { kind: "every", minutes: 10, from: NOW }, spec: { provider: "claude", cwd: dir, worktree: false, prompt: "steward", model: "claude-opus-5-5", effort: "high", fallbacks: ["codex", "omp"] } as Schedule["spec"],
      label: "Steward", enabled: true, nextAt: NOW + 600_000, createdAt: NOW, lastRunAt: NOW, lastSessionId: "home", lastError: null,
      noteCmd: null, sameSession: true, freshOver: 600_000, retiring: null,
    });
    const scheduler = new Scheduler(fleet, () => {}, () => NOW);

    expect(await scheduler.runNow("st3")).toBe("s3");
    expect(asked.map((r) => [r.provider, r.model, r.effort])).toEqual([["claude", "claude-opus-5-5", "high"], ["codex", undefined, undefined], ["omp", undefined, undefined]]);
    expect(await scheduler.runNow("st3")).toBe("s3");
    expect(notes).toEqual(["[via agentbox schedule st3] steward"]);

    room = ["claude"];
    expect(await scheduler.runNow("st3")).toBe("s4");
    expect(asked.at(-1)!.provider).toBe("claude");
    expect(asked.at(-1)!.prompt).toContain("it ran on omp while claude had no account with room, and claude has room again");

    room = [];
    sessions.set("s4", session("s4", { provider: "claude", status: "closed" }));
    await expect(scheduler.runNow("st3")).rejects.toThrow("claude: every claude account is at its limit; codex: every codex account is at its limit; omp: every omp account is at its limit");
  });
});

test("late pane discovery attaches only the proven new provider identity, preserving an alias", () => {
  const now = NOW + 20 * 60_000;
  insertAccount({ id: "own-account", provider: "codex", label: "Fixture", email: null, plan: null, home: dir, isDefault: true, enabled: true, createdAt: NOW });
  const pending = { ...record("late-spawn"), provider: "codex" as const, tmux: "ab-late-spawn", accountId: "own-account", cwd: "/tmp/own-writer", pinOrder: 3 };
  const discovered = { ...pending, id: "late-discovery", origin: "external" as const, tmux: null, agentSessionId: "provider-own", createdAt: NOW + 1000, transcriptPath: "/tmp/provider-own.jsonl", pinOrder: 9, bookmarkedAt: NOW + 1000 };
  insertSessionRecord(pending); insertSessionRecord(discovered);
  const proc = { pid: 345, provider: "codex", accountId: "other-account", agentSessionId: "provider-own", cwd: pending.cwd, startedAt: NOW + 1000 };
  // The pass reads exactly these: the panes, the live processes under them,
  // the provider transcripts it may guess from, and what it has matched so far.
  const fleet = Object.create(Fleet.prototype) as unknown as {
    panes: Map<string, { pid: number; dead: boolean }>;
    livePids: Map<number, unknown>;
    tracked: Map<string, unknown>;
    byAgentId: Map<string, string>;
    matchPendingSpawns(now: number): void;
  };
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
  expect(getSessionRecord(pending.id)!.pinOrder).toBe(3);
  expect(getSessionRecord(pending.id)!.bookmarkedAt).toBe(discovered.bookmarkedAt);
  expect(getSessionRecord(discovered.id)!.pinOrder).toBeNull();
  expect(getSessionRecord(discovered.id)!.bookmarkedAt).toBeNull();
  expect(getSessionRecord(discovered.id)!.successor).toBe(pending.id);
  expect(getSessionRecord(discovered.id)!.archivedAt).toBe(now);
  expect(getSessionRecord(discovered.id)!.agentSessionId).toBeNull();
  expect(fleet.byAgentId.get("codex:provider-own")).toBe(pending.id);
});
