/** A superagent's loop runs at its times into whichever session is its main,
 *  waits for a turn to end, and lets its check skip a time. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db";
import { nextRun } from "../schedule";
import { advance, loopsOf, loopText, Loops, removeLoop, ruleOf, setLoop, type Loop } from "./loops";
import { stateOf } from "./state";

const NOW = new Date(2026, 9, 14, 16, 20).getTime();
const HOUR = 3_600_000;
let home: string, previous: string | undefined;

beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "superagent-loops-"));
  process.env.AGENTBOX_HOME = home;
});
afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("a loop repeats at a time; anything else is refused", () => {
  expect(ruleOf("every hour", NOW).kind).toBe("every");
  expect(() => ruleOf("in 4 hours", NOW)).toThrow(/repeats at a time/);
  expect(() => setLoop("keeper", [], "hourly", { when: "every hour", prompt: "" }, NOW)).toThrow();
  // A manifest loop is changed in the manifest, not over it.
  expect(() => setLoop("keeper", ["hourly"], "hourly", { when: "every hour", prompt: "p" }, NOW)).toThrow(/manifest/);
});

test("a time that comes is due until it runs, and missed times fold into it", () => {
  const rule = ruleOf("every hour", NOW);
  const clock = { of: "x", nextAt: nextRun(rule, NOW), due: null, last: null };
  expect(advance(clock, rule, NOW)).toBe(clock);
  const first = advance(clock, rule, clock.nextAt! + 1000);
  expect(first.due).toBe(clock.nextAt);
  const later = advance(first, rule, first.nextAt! + 3 * HOUR);
  expect(later.due).toBe(clock.nextAt);
  expect(later.nextAt!).toBeGreaterThan(first.nextAt! + 3 * HOUR);
});

test("the main is told the check's output before the prompt; a manifest loop's file is read fresh", () => {
  expect(loopText("every hour", "Look at the ready PRs.", "#9220 ready\n")).toBe("Your loop (every hour). Its check said:\n\n#9220 ready\n\nLook at the ready PRs.");
  expect(loopText("every hour", "Look at the ready PRs.", "")).toBe("Your loop (every hour):\n\nLook at the ready PRs.");
  writeFileSync(join(home, "LOOP.md"), "From the file.");
  const loops = loopsOf(home, [{ when: "every hour", file: "LOOP.md" }, { when: "every day at 9am", file: "../outside.md" }], {});
  expect(loops.map((l) => [l.id, l.prompt])).toEqual([["loop-1", "From the file."], ["loop-2", "[agentbox: the loop's file ../outside.md is outside the superagent's directory]"]]);
});

test("a due loop waits while the main is busy, then is said once; set and removed loops follow the state", async () => {
  setLoop("keeper", [], "hourly", { when: "every hour", prompt: "Check in." }, NOW);
  const told: string[] = [];
  let busy = true;
  const loops: () => Loop[] = () => loopsOf(home, [], stateOf("keeper").loops ?? {});
  const runner = new Loops({ looped: () => [{ name: "keeper", dir: home, main: "m1", loops: loops() }], busy: () => busy, tell: async (_n, text) => void told.push(text) });
  const at = stateOf("keeper").loops!.hourly!.nextAt! + 1000;
  runner.tick(at);
  expect(told).toEqual([]);
  expect(stateOf("keeper").loops!.hourly!.due).toBeTruthy();
  busy = false;
  runner.tick(at + 1000);
  await Bun.sleep(10);
  runner.tick(at + 2000);
  await Bun.sleep(10);
  expect(told).toHaveLength(1);
  expect(told[0]).toContain("Check in.");
  expect(stateOf("keeper").loops!.hourly!.last?.result).toBe("sent");
  removeLoop("keeper", [], "hourly");
  expect(loops()).toEqual([]);
});
