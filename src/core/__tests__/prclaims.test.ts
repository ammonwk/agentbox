/**
 * A session must never take its own claim for another's. At 11:40 on
 * 2026-10-11 j2g254q4 was told "#8154 is j2g254q4's", read its own id as
 * another session's, and stood down from four pull requests it held. The
 * claim is its own again, and a refusal says the holder is another session
 * and who the asker is, so the two ids are side by side.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db";
import { claimPr, PrHeld, prClaims } from "../prclaims";
import type { Session } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-prclaims-"));
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

const live = (id: string, title: string) => ({ id, title, status: "running", host: "tmux" }) as Session;
const sessions = [live("j2g254q4", "Steward refresh batch"), live("kny787jm", "Refresh four stale pull requests")];

test("claiming what you hold is yours again, not refused", () => {
  claimPr(prClaims(sessions, []), sessions, "o/r", 8154, "j2g254q4", 1);
  const again = claimPr(prClaims(sessions, []), sessions, "o/r", 8154, "j2g254q4", 2);
  expect(again.sessionId).toBe("j2g254q4");
});

test("a refusal names the holder as another session, and the asker beside it", () => {
  let err: unknown;
  try {
    claimPr(prClaims(sessions, []), sessions, "o/r", 8154, "kny787jm", 3);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PrHeld);
  expect((err as Error).message).toStartWith(
    "not claimed: o/r#8154 is held by another session, j2g254q4 (“Steward refresh batch”, running), which claimed it; you are kny787jm.",
  );
});
