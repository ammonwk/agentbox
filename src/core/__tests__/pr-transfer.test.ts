import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getWait, insertWait, updateWait } from "../db";
import { claimPr, prClaims, transferPr, releasePr, prReleased } from "../prclaims";
import { Waits } from "../waits";
import type { Session, Wait, WaitSpec } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-transfer-"));
const old = process.env.AGENTBOX_HOME;
process.env.AGENTBOX_HOME = dir;
closeDb();
afterAll(() => {
  closeDb();
  if (old === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = old;
  rmSync(dir, { recursive: true, force: true });
});
const sessions = ["holder", "next", "racer"].map((id) => ({ id, host: "tmux", status: "running" } as Session));
const branch = [{ repo: "team/repo", number: 1, sessionId: "holder", at: 1 }];
const claims = () => prClaims(sessions, branch);

test("only the current holder can transfer; a competing stale handoff cannot replace the winner", () => {
  expect(() => transferPr(claims(), sessions, "team/repo", 1, "racer", "holder", "next", 2)).toThrow("only the current holder");
  expect(() => transferPr(claims(), sessions, "team/repo", 1, "holder", "holder", "gone", 2)).toThrow("live");
  expect(transferPr(claims(), sessions, "team/repo", 1, "holder", "holder", "next", 2).sessionId).toBe("next");
  expect(() => transferPr(claims(), sessions, "team/repo", 1, "holder", "holder", "racer", 3)).toThrow("ownership changed");
  expect(() => claimPr(claims(), sessions, "team/repo", 1, "holder", 4)).toThrow("held by another session, next");
  // The old holder lets go as on a release: its own branch no longer holds it.
  expect(prReleased("holder", { repo: "team/repo", number: 1 })).toBe(true);
  expect(claims()).toHaveLength(1);
  expect(claims()[0]!.sessionId).toBe("next");
});

test("transfer revokes predecessor waits and branch fallback, then clears successor exclusions regardless of repo casing", () => {
  const ref = { repo: "Team/Repo", number: 2 };
  const byBranch = [{ ...ref, sessionId: "holder", at: 1 }];
  releasePr("next", { repo: "TEAM/REPO", number: 2 });
  const wait = insertWait({ sessionId: "holder", spec: { kind: "pr", ...ref, head: "aaaaaaa", all: true, checks: [], merged: false }, createdAt: 1, deadline: Date.now() + 60_000 });
  const pending = insertWait({ sessionId: "holder", spec: { kind: "pr", ...ref, head: "aaaaaaa", all: true, checks: [], merged: false }, createdAt: 1, deadline: Date.now() + 60_000 });
  updateWait(pending.id, { ended: "stuck", endedAt: 2, outcome: "old result" });
  transferPr(prClaims(sessions, byBranch), sessions, "team/repo", 2, "holder", "holder", "next", 3);
  for (const id of [wait.id, pending.id]) expect(getWait(id)!.ended).toBe("cancelled");
  expect(prReleased("holder", { repo: "team/repo", number: 2 })).toBe(true);
  expect(prReleased("next", ref)).toBe(false);
  releasePr("next", ref);
  expect(prClaims(sessions, byBranch).some(c => c.number === 2)).toBe(false);
});

test("a release keeps the --merged wait on the PR and cancels only the waits that act on it", () => {
  const ref = { repo: "team/repo", number: 3 };
  const byBranch = [{ ...ref, sessionId: "holder", at: 1 }];
  const armed = (spec: Extract<WaitSpec, { kind: "pr" }>) =>
    insertWait({ sessionId: "holder", spec, createdAt: 1, deadline: Date.now() + 60_000 });
  const base = { kind: "pr" as const, ...ref, head: "aaaaaaa", all: true, checks: [] as string[], merged: false };
  const every = armed(base);
  const named = armed({ ...base, all: false, checks: ["Build"] });
  const feedback = armed({ ...base, all: false, feedback: true });
  const stacked = armed({ ...base, all: false, merged: true });
  transferPr(prClaims(sessions, byBranch), sessions, "team/repo", 3, "holder", "holder", "next", 3);
  for (const id of [every.id, named.id, feedback.id]) {
    expect(getWait(id)).toMatchObject({ ended: "cancelled", outcome: expect.stringContaining("no longer holds") });
  }
  // Waiting for another PR's merge needs no ownership: it is the wait for a PR
  // yours is stacked on, and the successor's ownership does not end it.
  expect(getWait(stacked.id)).toMatchObject({ ended: null, outcome: null, sessionId: "holder" });
});

test("a released session can still arm and be told its --merged wait, naming the holder", async () => {
  const ref = { repo: "team/repo", number: 4 };
  const byBranch = [{ ...ref, sessionId: "holder", at: 1 }];
  const stacked: Extract<WaitSpec, { kind: "pr" }> = { kind: "pr", ...ref, head: "aaaaaaa", all: false, checks: [], merged: true };
  const wait = insertWait({ sessionId: "holder", spec: stacked, createdAt: 1, deadline: Date.now() + 60_000 });
  transferPr(prClaims(sessions, byBranch), sessions, "team/repo", 4, "holder", "holder", "next", 3);
  expect(getWait(wait.id)!.ended).toBeNull();
  const sent: string[] = [];
  const waits = new Waits({ get: (id) => sessions.find((s) => s.id === id)!, heir: (id) => id, note: async (_id, text) => { sent.push(text); } });
  const inner = waits as unknown as { tick: () => Promise<void>; tell: (w: Wait) => Promise<void> };
  inner.tick = async () => {}; // the ending is what this is about, not the GitHub read
  expect(waits.arm("holder", stacked)).toMatchObject({ already: true, wait: { id: wait.id } });
  updateWait(wait.id, { ended: "happened", endedAt: 2, outcome: "PR #4 merged." });
  await inner.tell(getWait(wait.id)!);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("PR #4 merged.");
  expect(sent[0]).toContain("assigned to next, not you (holder)");
  expect(sent[0]).not.toContain("You no longer hold");
});
