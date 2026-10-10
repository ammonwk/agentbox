import { expect, test } from "bun:test";
import { expectedCost, fitForecast, readingAt, type Sample, type SessionSeries } from "../forecast";

const M = 60_000;
const H = 60 * M;
const T0 = 1_790_000_000_000;

/** A session that spends `perMin` a minute for `minutes`, from T0 + `from`. */
function burn(from: number, minutes: number, perMin: number, start = 0): Sample[] {
  return Array.from({ length: minutes }, (_, i) => ({ at: T0 + from + i * M, cost: start + (i + 1) * perMin }));
}

test("a reading is what was spent in the last ten minutes and so far this stretch", () => {
  const samples = burn(0, 30, 0.1);
  const r = readingAt(samples, T0, T0 + 29 * M)!;
  expect(r.soFar).toBeCloseTo(3, 5);
  expect(r.recent).toBeCloseTo(1, 5);
  // Twenty minutes after its last sample it has spent nothing lately.
  const idle = readingAt(samples, T0, T0 + 50 * M)!;
  expect(idle.recent).toBe(0);
  expect(idle.soFar).toBeCloseTo(3, 5);
});

test("an hour's silence ends the stretch, unless the session is mid-turn", () => {
  const samples = burn(0, 30, 0.1);
  expect(readingAt(samples, T0, T0 + 2 * H)).toBeNull();
  expect(readingAt(samples, T0, T0 + 2 * H, true)).toEqual({ recent: 0, soFar: expect.closeTo(3, 5) });
  expect(readingAt([], T0, T0)).toBeNull();
});

test("a new stretch counts from where the last one ended", () => {
  const samples = [...burn(0, 30, 0.1), ...burn(3 * H, 5, 0.2, 3)];
  const r = readingAt(samples, T0, T0 + 3 * H + 4 * M)!;
  expect(r.soFar).toBeCloseTo(1, 5);
  expect(r.recent).toBeCloseTo(1, 5);
});

test("what a session first seen long after it started already held is not this stretch's", () => {
  const samples = burn(0, 5, 0.1, 400);
  expect(readingAt(samples, T0 - 3 * H, T0 + 4 * M)!.soFar).toBeCloseTo(0.4, 5);
  expect(readingAt(samples, T0, T0 + 4 * M)!.soFar).toBeCloseTo(400.5, 5);
});

/** `n` sessions that each work for `minutes` at `perMin`, a day apart. */
function fleetOf(n: number, minutes: number, perMin: number, provider = "claude"): SessionSeries[] {
  return Array.from({ length: n }, (_, i) => ({ provider, startedAt: T0 + i * 24 * H, samples: burn(i * 24 * H, minutes, perMin) }));
}

test("a session that has stopped spending is expected to spend nothing more, one mid-burn the average of what such sessions went on to", () => {
  const until = T0 + 60 * 24 * H;
  const table = fitForecast(fleetOf(30, 120, 0.2), until);
  // Idle after 24 of cost-equivalent: every such moment was followed by nothing.
  expect(expectedCost(table, "claude", { recent: 0, soFar: 24 })).toBe(0);
  // Burning 2 in ten minutes, with between 4 and 16 behind it (minutes 20 to 80): 8 to 20 still to come.
  const mid = expectedCost(table, "claude", { recent: 2, soFar: 10 })!;
  expect(mid).toBeGreaterThan(8);
  expect(mid).toBeLessThan(20);
  // And less is left near the end than in the middle.
  expect(expectedCost(table, "claude", { recent: 2, soFar: 20 })!).toBeLessThan(mid);
});

test("a provider with little history of its own reads every provider's; a pair nobody has been in says nothing", () => {
  const until = T0 + 60 * 24 * H;
  const table = fitForecast([...fleetOf(30, 120, 0.2), ...fleetOf(3, 120, 0.2, "codex")], until);
  expect(expectedCost(table, "codex", { recent: 2, soFar: 10 })).toBeCloseTo(expectedCost(table, "*", { recent: 2, soFar: 10 })!, 5);
  expect(expectedCost(table, "claude", { recent: 50, soFar: 0.01 })).toBeNull();
});

test("a stretch still running when the samples end is not evidence", () => {
  const table = fitForecast(fleetOf(30, 120, 0.2), T0 + 29 * 24 * H + 2 * H);
  const all = fitForecast(fleetOf(30, 120, 0.2), T0 + 60 * 24 * H);
  const key = "claude|0|4";
  expect(table.get(key)!.stretches).toBe(29);
  expect(all.get(key)!.stretches).toBe(30);
});
