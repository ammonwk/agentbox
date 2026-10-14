import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db";
import { claimPr, prClaims, prReleased, transferPr } from "../prclaims";
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
