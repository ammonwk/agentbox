import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getWait, insertWait, updateWait } from "../db";
import { claimPr, prClaims, transferPr, releasePr, prReleased } from "../prclaims";
import type { Session } from "../types";

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
  const current = () => prClaims(sessions, byBranch);
  releasePr("next", { repo: "TEAM/REPO", number: 2 });
  const wait = insertWait({ sessionId: "holder", spec: { kind: "pr", ...ref, head: "aaaaaaa", all: true, checks: [], merged: false }, createdAt: 1, deadline: Date.now() + 60_000 });
  const pending = insertWait({ sessionId: "holder", spec: { kind: "pr", ...ref, head: "aaaaaaa", all: true, checks: [], merged: false }, createdAt: 1, deadline: Date.now() + 60_000 });
  updateWait(pending.id, { ended: "stuck", endedAt: 2, outcome: "old result" });
  transferPr(current(), sessions, "team/repo", 2, "holder", "holder", "next", 3);
  for (const id of [wait.id, pending.id]) expect(getWait(id)!.ended).toBe("cancelled");
  expect(prReleased("holder", { repo: "team/repo", number: 2 })).toBe(true);
  expect(prReleased("next", ref)).toBe(false);
  releasePr("next", ref);
  expect(current().some(c => c.number === 2)).toBe(false);
});
