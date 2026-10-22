import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getWait, insertWait, updateWait, insertSessionRecord, type SessionRecord, insertSchedule, insertAccount } from "../db";
import { claimPr, releasePr, prClaims, prReleased, prReleaseLine, movePrClaims } from "../prclaims";
import { Waits, lookPr, type Look } from "../waits";
import { Fleet, type Runtime } from "../fleet";
import { claudeAdapter } from "../providers/claude";
import { Scheduler } from "../scheduler";
import type { Session, Wait, WaitSpec, Schedule } from "../types";
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
  const waits = new Waits({ get: id => sessions.find(s => s.id === id)!, heir: id => id, note: async (_id, text) => { sent.push(text); }, finishNote: async () => false });
  await waits.tick();
  expect(sent).toEqual([]);
  expect(() => waits.arm("old", spec(8066))).toThrow("not yours");
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

test("feedback cursor survives restart without reviving a released owner's notifications", () => {
  claim("old", 9003);
  const feedback = { ...spec(9003), all: false, feedback: true } as Extract<WaitSpec, { kind: "pr" }>;
  const w = insertWait({ sessionId: "old", spec: feedback, createdAt: now, deadline: now + 60_000 });
  const waits = new Waits({ get: id => sessions.find(s => s.id === id)!, heir: id => id, note: async () => {}, finishNote: async () => false });
  // The durable transition is what this test is about, and `looked` writes it;
  // the GitHub read that would feed it is what `tick` is stubbed out of.
  const inner = waits as unknown as { tick: () => Promise<void>; looked: (w: Wait, look: Look, now: number) => void };
  inner.tick = async () => {};
  const read = { state: "OPEN" as const, head: "a".repeat(40), base: "main", mergeable: "MERGEABLE" as const, checks: [], feedback: { fingerprint: "observed", count: 1 } };
  inner.looked(w, lookPr(feedback, {}, read, now, now), now);
  closeDb();
  expect(getWait(w.id)).toMatchObject({ ended: "happened", toldAt: null, memo: { feedback: "observed" } });
  const again = waits.arm("old", { ...feedback, head: read.head }).wait;
  closeDb();
  expect(getWait(again.id)?.memo.feedback).toBe("observed");
  expect(again.memo.feedback).toBe("observed");
  expect(lookPr(feedback, again.memo, read, now, now)).not.toHaveProperty("end");
  expect(lookPr(feedback, again.memo, { ...read, feedback: { fingerprint: "edited", count: 1 } }, now, now)).toHaveProperty("end");
  releasePr("old", { repo: "o/r", number: 9003 });
  claim("new", 9003);
  closeDb();
  for (const id of [w.id, again.id]) expect(getWait(id)?.ended).toBe("cancelled");
  expect(() => waits.arm("old", feedback)).toThrow("not yours");
  const next = waits.arm("new", feedback).wait;
  expect(next.memo.feedback).toBeUndefined();
  expect(lookPr(feedback, next.memo, read, now, now)).toHaveProperty("end");
  releasePr("new", { repo: "o/r", number: 9003 });
});

test("a message queued before the release carries the line when it lands, and the line is said once", async () => {
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
    label: null, claim: 1, origin: "agentbox", scope: "personal", tmux: pane.name, transcriptPath: null, startedAt: now, lastActivityAt: now,
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
  expect(delivered[0]).toBe("first");
  expect(delivered.at(-1)).toContain("o/r#9002 is new's since");
  expect(delivered.at(-1)).toContain("not yours");
  expect(delivered.at(-1)).toContain("finish PR 9002");
  const schedule: Schedule = { id: "release-tick", rule: { kind: "every", minutes: 10, from: now }, spec: { provider: "claude", cwd: dir, worktree: false, prompt: "continue PR 9002" } as Schedule["spec"], label: null, enabled: true, nextAt: now + 600_000, createdAt: now, lastRunAt: null, lastSessionId: "messenger", lastError: null, noteCmd: null, sameSession: true, freshOver: null, retiring: null };
  insertSchedule(schedule);
  const scheduler = new Scheduler(fleet, () => {}, () => now);
  expect(await scheduler.runNow(schedule.id)).toBe("messenger");
  expect(delivered.at(-1)).toContain("continue PR 9002");
  // The line was said with the message above: it is not said again.
  expect(delivered.at(-1)).not.toContain("o/r#9002");
});


test("resuming a parked former holder without a prompt still starts with its release notice", async () => {
  const launches: NewSession[] = [];
  const runtime: Runtime = { listPanes: () => [], newSession: s => { launches.push(s); return 0; }, killSession: () => {}, sendText: async () => {}, sendKeys: () => {}, capture: () => null, captureMany: () => new Map() };
  insertAccount({ id: "fixture-account", provider: "claude", label: "fixture", email: null, plan: null, home: join(dir, "account"), isDefault: false, enabled: true, createdAt: now });
  insertSessionRecord({ id: "parked", provider: "claude", agentSessionId: "00000000-0000-4000-8000-000000000150", accountId: "fixture-account", cwd: dir, worktree: null,
    label: null, claim: 1, origin: "agentbox", scope: "personal", tmux: null, transcriptPath: null, startedAt: now, lastActivityAt: now,
    archivedAt: null, parkedAt: now, facts: { resumeCwd: dir }, createdAt: now } as SessionRecord);
  const fleet = new Fleet({ adapters: [claudeAdapter], runtime, usage: { usageOf: () => null } });
  await fleet.tick();
  claimPr([], [], "o/r", 9003, "parked", now);
  releasePr("parked", { repo: "o/r", number: 9003 });
  claim("new", 9003);
  await fleet.resume("parked");
  expect(launches).toHaveLength(1);
  // The line is in the file the launch names, not on the command line.
  expect(launches[0]!.argv.join(" ")).not.toContain("o/r#9003");
  expect(readFileSync(launches[0]!.stdinFile!, "utf8")).toContain("o/r#9003 is new's since");
  expect(readFileSync(launches[0]!.stdinFile!, "utf8")).toContain("not yours");
});

test("a pre-existing observer wait names the current owner instead of granting authority", async () => {
  claim("new", 9004);
  const wait = pending("observer", 9004);
  updateWait(wait.id, { ended: "stuck", endedAt: now, outcome: "Arm it again for the new head." });
  const sent: string[] = [];
  const waits = new Waits({ get: id => sessions.find(s => s.id === id)!, heir: id => id, note: async (_id, text) => { sent.push(text); }, finishNote: async () => false });
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

/** A fleet with one live session, and everything typed into it. */
function fleetFor(id: string, pane: PaneInfo): { fleet: Fleet; delivered: string[] } {
  const delivered: string[] = [];
  const runtime: Runtime = {
    listPanes: () => [pane], newSession: () => 0, killSession: () => {}, sendKeys: () => {}, capture: () => "", captureMany: () => new Map(),
    sendText: async (_pane, text) => { delivered.push(text); },
  };
  const fleet = new Fleet({ adapters: [claudeAdapter], runtime, usage: { usageOf: () => null } });
  insertSessionRecord({ id, provider: "claude", agentSessionId: null, accountId: null, cwd: dir, worktree: null,
    label: null, claim: 1, origin: "agentbox", scope: "personal", tmux: pane.name, transcriptPath: null, startedAt: now, lastActivityAt: now,
    archivedAt: null, facts: null, createdAt: now } as SessionRecord);
  return { fleet, delivered };
}

test("the session that lost a PR is told once, when it next wakes, and never again", async () => {
  const { fleet, delivered } = fleetFor("loser", { name: "ab-loser", pid: 99999991, dead: false, activity: now / 1000 } as PaneInfo);
  await fleet.tick();
  claimPr([], [], "o/r", 9100, "loser", now);
  releasePr("loser", { repo: "o/r", number: 9100 });
  claim("new", 9100);
  // Nothing is said at the release: the session is told when it next wakes.
  expect(delivered).toEqual([]);
  await fleet.note("loser", "are you still on 9100?");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("o/r#9100 is new's since");
  expect(delivered[0]).toContain("not yours");
  expect(delivered[0]).toContain("do not edit that branch or worktree");
  expect(delivered[0]).toContain("only your user can hand it back to you");
  expect(delivered[0]).toContain("are you still on 9100?");
  // The next thing delivered to it does not carry the line again.
  await fleet.note("loser", "and now?");
  expect(delivered).toHaveLength(2);
  expect(delivered[1]).toBe("and now?");
});

test("a session that is never woken is told nothing", async () => {
  const { fleet, delivered } = fleetFor("quiet", { name: "ab-quiet", pid: 99999992, dead: false, activity: now / 1000 } as PaneInfo);
  await fleet.tick();
  claimPr([], [], "o/r", 9101, "quiet", now);
  releasePr("quiet", { repo: "o/r", number: 9101 });
  claim("new", 9101);
  expect(delivered).toEqual([]);
  // The line waits for the next thing delivered to it.
  expect(prReleaseLine("quiet")).toContain("o/r#9101");
});

test("a session that took its PR back is told nothing", async () => {
  const { fleet, delivered } = fleetFor("taker", { name: "ab-taker", pid: 99999993, dead: false, activity: now / 1000 } as PaneInfo);
  await fleet.tick();
  claimPr([], [], "o/r", 9102, "taker", now);
  releasePr("taker", { repo: "o/r", number: 9102 });
  claim("new", 9102);
  // The holder lets go, and the user says the session may have it back.
  releasePr("new", { repo: "o/r", number: 9102 });
  claimPr(prClaims(sessions, []), sessions, "o/r", 9102, "taker", now);
  expect(prReleased("taker", { repo: "o/r", number: 9102 })).toBe(false);
  await fleet.note("taker", "back on it");
  expect(delivered).toEqual(["back on it"]);
});

test("a schedule's heir is told what its predecessor lost, and the predecessor is told it lost the PR", async () => {
  // The predecessor held one PR and had lost another to a session that holds it now.
  claimPr([], [], "o/r", 9103, "old", now);
  releasePr("old", { repo: "o/r", number: 9104 });
  claim("new", 9104);
  const live = new Map<string, Session>([["old", { id: "old", provider: "claude", host: "tmux", status: "waiting", cold: false, cacheWarmUntil: 0, contextUsed: 30_000, limitHit: null } as Session]]);
  const prompts: string[] = [];
  const fleet = {
    get: (id: string) => live.get(id)!,
    spawn: async (req: { prompt?: string }) => {
      prompts.push(req.prompt ?? "");
      live.set("heir", { id: "heir", provider: "claude", host: "tmux", status: "running", cold: false, cacheWarmUntil: 0, contextUsed: 0, limitHit: null } as Session);
      return { session: live.get("heir")! };
    },
    patch: async () => {},
    startedBy: () => [],
    handOver: async () => {},
    close: async () => {},
    note: async () => {},
  } as unknown as Fleet;
  insertSchedule({ id: "heir-tick", rule: { kind: "every", minutes: 10, from: now }, spec: { provider: "claude", cwd: dir, worktree: false, prompt: "take 9103 to green" } as Schedule["spec"],
    label: null, enabled: true, nextAt: now + 600_000, createdAt: now, lastRunAt: null, lastSessionId: "old", lastError: null, noteCmd: null, sameSession: true, freshOver: 20_000, retiring: null });
  const scheduler = new Scheduler(fleet, () => {}, () => now);
  expect(await scheduler.runNow("heir-tick")).toBe("heir");
  // The heir's first prompt names the PR its predecessor lost, and who holds it.
  expect(prompts[0]).toContain("o/r#9104 is new's since");
  expect(prompts[0]).toContain("take 9103 to green");
  // The PR its predecessor held is its own now, and the predecessor is told
  // that it lost it.
  const heirs = [...sessions, { id: "heir", host: "tmux", status: "running" } as Session];
  expect(prClaims(heirs, []).find(c => c.number === 9103)?.sessionId).toBe("heir");
  expect(prReleaseLine("old")).toContain("o/r#9103 is heir's since");
});
