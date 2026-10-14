import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getWait, insertWait, updateWait, insertSessionRecord, type SessionRecord, insertSchedule, insertAccount } from "../db";
import { claimPr, releasePr, prClaims, prReleased, movePrClaims } from "../prclaims";
import { Waits } from "../waits";
import { Fleet, type Runtime } from "../fleet";
import { claudeAdapter } from "../providers/claude";
import { Scheduler } from "../scheduler";
import type { Session, WaitSpec, Schedule } from "../types";
import type { NewSession, PaneInfo } from "../tmux";

const dir = mkdtempSync(join(tmpdir(), "agentbox-release-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };
const now = Date.now();
const sessions = ["old", "new", "observer"].map(id => ({ id, host: "tmux", status: "waiting" }) as Session);
const spec = (number: number, repo = "o/r"): WaitSpec => ({ kind: "pr", repo, number, head: "aaaaaaa", all: true, checks: [], merged: false });
const pending = (sessionId: string, number: number, repo = "o/r") => insertWait({ sessionId, spec: spec(number, repo), createdAt: now, deadline: now + 60_000 });
const claim = (id: string, number: number) => claimPr(prClaims(sessions, []), sessions, "o/r", number, id, now);

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

test("release cancels armed and undelivered results only for that session and repository; reopening the DB cannot revive them", async () => {
  claim("old", 8066);
  const armed = pending("old", 8066);
  const ended = pending("old", 8066);
  updateWait(ended.id, { ended: "stuck", endedAt: now, outcome: "Arm it again for the new head." });
  const otherRepo = pending("old", 8066, "other/r");
  const otherPR = pending("old", 8067);
  const observer = pending("observer", 8066);
  expect(releasePr("old", { repo: "O/R", number: 8066 })).toBe(1);
  claim("new", 8066);
  closeDb();
  for (const w of [armed, ended]) expect(getWait(w.id)).toMatchObject({ ended: "cancelled", toldAt: null, outcome: expect.stringContaining("no longer holds") });
  for (const w of [otherRepo, otherPR, observer]) {
    expect(getWait(w.id)!.ended).toBeNull();
    updateWait(w.id, { ended: "cancelled", endedAt: now });
  }
  const sent: string[] = [];
  const waits = new Waits({ get: id => sessions.find(s => s.id === id)!, heir: id => id, note: async (_id, text) => { sent.push(text); } });
  await waits.tick();
  expect(sent).toEqual([]);
  expect(() => waits.arm("old", spec(8066))).toThrow("You no longer hold");
  expect(prClaims(sessions, [{ repo: "o/r", number: 8066, sessionId: "old", at: now }])[0]!.sessionId).toBe("new");
  releasePr("new", { repo: "o/r", number: 8066 });
  expect(prClaims(sessions, [{ repo: "o/r", number: 8066, sessionId: "old", at: now }])).toEqual([]);
  claim("old", 8066);
  expect(prReleased("old", { repo: "o/r", number: 8066 })).toBe(false);
});

test("taking a lapsed claim also revokes its old holder; a schedule replacement keeps waits with its heir", () => {
  claim("old", 9001);
  const oldWait = pending("old", 9001);
  claimPr([], [], "O/R", 9001, "new", now);
  expect(getWait(oldWait.id)!.ended).toBe("cancelled");
  expect(prReleased("old", { repo: "o/r", number: 9001 })).toBe(true);
  const kept = pending("new", 9001);
  movePrClaims("new", "replacement");
  expect(getWait(kept.id)!.ended).toBeNull();
  expect(getWait(kept.id)!.sessionId).toBe("replacement");
  releasePr("replacement", { repo: "o/r", number: 9001 });
  expect(getWait(kept.id)!.ended).toBe("cancelled");
});

test("warm messages and schedule ticks carry release state even when queued before release", async () => {
  const delivered: string[] = [];
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const pane = { name: "ab-messenger", pid: 99999999, dead: false, activity: now / 1000 } as PaneInfo;
  const runtime: Runtime = {
    listPanes: () => [pane], newSession: () => 0, killSession: () => {}, sendKeys: () => {}, capture: () => "", captureMany: () => new Map(),
    sendText: async (_pane, text) => { delivered.push(text); if (text === "first") { entered(); await blocked; } },
  };
  const fleet = new Fleet({ adapters: [claudeAdapter], runtime, usage: { usageOf: () => null } });
  insertSessionRecord({ id: "messenger", provider: "claude", agentSessionId: null, accountId: null, cwd: dir, worktree: null,
    label: null, claim: 1, origin: "agentbox", tmux: pane.name, transcriptPath: null, startedAt: now, lastActivityAt: now,
    archivedAt: null, facts: null, createdAt: now } as SessionRecord);
  await fleet.tick();
  const first = fleet.note("messenger", "first");
  await entering;
  const second = fleet.send("messenger", "finish PR 9002");
  claimPr([], [], "o/r", 9002, "messenger", now);
  releasePr("messenger", { repo: "o/r", number: 9002 });
  claim("new", 9002);
  unblock();
  await Promise.all([first, second]);
  expect(delivered.at(-1)).toContain("You no longer hold o/r#9002 (assigned to new)");
  const schedule: Schedule = { id: "release-tick", rule: { kind: "every", minutes: 10, from: now }, spec: { provider: "claude", cwd: dir, worktree: false, prompt: "continue PR 9002" } as Schedule["spec"], label: null, enabled: true, nextAt: now + 600_000, createdAt: now, lastRunAt: null, lastSessionId: "messenger", lastError: null, noteCmd: null, sameSession: true, freshOver: null, retiring: null };
  insertSchedule(schedule);
  const scheduler = new Scheduler(fleet, () => {}, () => now);
  expect(await scheduler.runNow(schedule.id)).toBe("messenger");
  expect(delivered.at(-1)).toContain("You no longer hold o/r#9002 (assigned to new)");
  expect(delivered.at(-1)).toContain("continue PR 9002");
});


test("resuming a parked former holder without a prompt still starts with its release notice", async () => {
  const launches: NewSession[] = [];
  const runtime: Runtime = { listPanes: () => [], newSession: s => { launches.push(s); return 0; }, killSession: () => {}, sendText: async () => {}, sendKeys: () => {}, capture: () => null, captureMany: () => new Map() };
  insertAccount({ id: "fixture-account", provider: "claude", label: "fixture", email: null, plan: null, home: join(dir, "account"), isDefault: false, enabled: true, createdAt: now });
  insertSessionRecord({ id: "parked", provider: "claude", agentSessionId: "00000000-0000-4000-8000-000000000150", accountId: "fixture-account", cwd: dir, worktree: null,
    label: null, claim: 1, origin: "agentbox", tmux: null, transcriptPath: null, startedAt: now, lastActivityAt: now,
    archivedAt: null, parkedAt: now, facts: { resumeCwd: dir }, createdAt: now } as SessionRecord);
  const fleet = new Fleet({ adapters: [claudeAdapter], runtime, usage: { usageOf: () => null } });
  await fleet.tick();
  claimPr([], [], "o/r", 9003, "parked", now);
  releasePr("parked", { repo: "o/r", number: 9003 });
  claim("new", 9003);
  await fleet.resume("parked");
  expect(launches).toHaveLength(1);
  expect(launches[0]!.argv.join(" ")).toContain("You no longer hold o/r#9003 (assigned to new)");
});

test("a pre-existing observer wait names the current owner instead of granting authority", async () => {
  claim("new", 9004);
  const wait = pending("observer", 9004);
  updateWait(wait.id, { ended: "stuck", endedAt: now, outcome: "Arm it again for the new head." });
  const sent: string[] = [];
  const waits = new Waits({ get: id => sessions.find(s => s.id === id)!, heir: id => id, note: async (_id, text) => { sent.push(text); } });
  await waits.tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("assigned to new, not you (observer)");
  expect(sent[0]).toContain("observation only");
});


test("repeated schedule retirement cannot revoke a PR its successor explicitly reclaimed", () => {
  releasePr("predecessor", { repo: "o/r", number: 9005 });
  movePrClaims("predecessor", "successor");
  expect(prReleased("successor", { repo: "o/r", number: 9005 })).toBe(true);
  claimPr([], [], "o/r", 9005, "successor", now);
  movePrClaims("predecessor", "successor");
  expect(prReleased("successor", { repo: "o/r", number: 9005 })).toBe(false);
});
