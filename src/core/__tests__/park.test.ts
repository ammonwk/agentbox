/**
 * Two holds that kept sessions up for nothing (2026-10-17): xyiskn7f, done
 * for six and a half days, held by an `_owed57-observe.ts --prod` that had
 * not used a clock tick since its log stopped; and sixteen sessions that had
 * ended `STATUS: done` sitting out the hour before parking.
 */

import { expect, test } from "bun:test";
import { endedDone, shellHold, ShellStillness, STUCK_WORK_MS } from "../park";

const HOUR = 3_600_000;

test("work holds while its processes use CPU, and not once they have been still for a day", () => {
  const label = "npx tsx scripts/_owed57-observe.ts --prod";
  expect(shellHold("work", label, 6 * 24 * HOUR)).toContain("a background command is running");
  expect(shellHold("work", label, 6 * 24 * HOUR, STUCK_WORK_MS - 1)).toContain("a background command is running");
  expect(shellHold("work", label, 6 * 24 * HOUR, STUCK_WORK_MS)).toBeNull();
  // Followers and services keep their own rules.
  expect(shellHold("follower", "tail -f x", 0, 0)).toBeNull();
  expect(shellHold("service", "vite", HOUR, STUCK_WORK_MS)).toContain("a server is running");
});

test("stillness counts from the first look at the same ticks, and any movement starts it over", () => {
  const s = new ShellStillness();
  expect(s.still("41:900", 120, 0)).toBe(0);
  expect(s.still("41:900", 120, 10 * HOUR)).toBe(10 * HOUR);
  expect(s.still("41:900", 121, 11 * HOUR)).toBe(0);
  expect(s.still("41:900", 121, 36 * HOUR)).toBe(25 * HOUR);
  // Ticks going down (a subtree orphaned onto init) is movement too.
  expect(s.still("41:900", 90, 37 * HOUR)).toBe(0);
  // A recycled pid is another key.
  expect(s.still("41:1200", 90, 37 * HOUR)).toBe(0);
  s.prune((key) => key === "41:1200");
  expect(s.still("41:900", 90, 40 * HOUR)).toBe(0);
  expect(s.still("41:1200", 90, 40 * HOUR)).toBe(3 * HOUR);
});

test("a turn is done only when its last line says STATUS: done", () => {
  expect(endedDone("…ready, green and clean, and left unmerged.\n\nSTATUS: done")).toBe(true);
  expect(endedDone("Decisions waiting: 2 (372 Depot, 376 box1 delete)  STATUS: done")).toBe(false);
  expect(endedDone("All set.\n**STATUS: done**\n")).toBe(true);
  expect(endedDone("`STATUS: done`")).toBe(true);
  expect(endedDone("status: Done.")).toBe(true);
  expect(endedDone("STATUS: waiting on agentbox wait 17408 (PR #9549 checks)")).toBe(false);
  expect(endedDone("STATUS: needs Ammon — close it? If he does not answer, STATUS: done")).toBe(false);
  expect(endedDone("STATUS: done earlier, but now:\nSTATUS: waiting on CI")).toBe(false);
  expect(endedDone("STATUS: doneish")).toBe(false);
  expect(endedDone(null)).toBe(false);
  expect(endedDone("")).toBe(false);
});
