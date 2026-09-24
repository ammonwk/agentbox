import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apportion, Attributor, claimsByAccount } from "../claims";
import { estimateShortInWeekly, percentiles } from "../calibration";
import {
  attributedPoints,
  closeDb,
  DEFAULT_BALANCER,
  insertTokenSample,
  insertUsageSample,
  type UsageSampleRow,
} from "../db";
import { useTempHome } from "./tmp-home";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 24, 12);

describe("claimsByAccount", () => {
  const base = { title: "t", big: false, claim: 5, running: false };

  test("outstanding is what is left of the claim, and never negative", () => {
    const m = claimsByAccount(
      [
        { ...base, sessionId: "a", accountId: "x", lastActivityAt: NOW },
        { ...base, sessionId: "b", accountId: "x", lastActivityAt: NOW },
      ],
      new Map([["a", 2], ["b", 9]]),
      DEFAULT_BALANCER,
      NOW,
    );
    expect(m.get("x")!.map((c) => c.outstanding)).toEqual([3, 0]);
  });

  test("an idle session's claim lapses; a running one's never does", () => {
    const old = NOW - 2 * HOUR;
    const m = claimsByAccount(
      [
        { ...base, sessionId: "idle", accountId: "x", lastActivityAt: old },
        { ...base, sessionId: "busy", accountId: "x", lastActivityAt: old, running: true },
      ],
      new Map(),
      DEFAULT_BALANCER,
      NOW,
    );
    const [idle, busy] = m.get("x")!;
    expect(idle!.lapsed).toBe(true);
    expect(idle!.outstanding).toBe(0);
    expect(busy!.outstanding).toBe(5);
  });
});

describe("apportion", () => {
  test("splits by weight, ignores zero and negative weights", () => {
    const out = apportion(6, new Map([["a", 1], ["b", 2], ["c", 0], ["d", -1]]));
    expect(out.get("a")).toBeCloseTo(2);
    expect(out.get("b")).toBeCloseTo(4);
    expect(out.has("c")).toBe(false);
  });

  test("nothing to split when nobody did anything", () => {
    expect(apportion(3, new Map([["a", 0]])).size).toBe(0);
  });
});

describe("Attributor", () => {
  let restore: () => void;
  beforeAll(() => {
    closeDb();
    restore = useTempHome().restore;
  });
  afterAll(() => {
    closeDb();
    restore();
  });

  const tokens = (costEquiv: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv });
  const weekly = (at: number, usedPct: number, resetsAt = NOW + 50 * HOUR) => ({
    windowId: "seven_day", at, usedPct, resetsAt,
  });

  test("a weekly rise is split by what each session did in the interval", () => {
    insertTokenSample("s1", NOW - 10 * MIN, tokens(1));
    insertTokenSample("s2", NOW - 10 * MIN, tokens(1));
    insertTokenSample("s1", NOW, tokens(4)); // +3
    insertTokenSample("s2", NOW, tokens(2)); // +1

    const a = new Attributor();
    // The service stored the first reading before telling us about it.
    insertUsageSample("acct", NOW - 10 * MIN, { id: "seven_day", kind: "weekly", label: "w", usedPct: 40, resetsAt: NOW + 50 * HOUR, windowMs: 0 }, "endpoint");
    expect(a.observe("acct", weekly(NOW - 10 * MIN, 40), ["s1", "s2"]).size).toBe(0);
    const shares = a.observe("acct", weekly(NOW, 44), ["s1", "s2"]);
    expect(shares.get("s1")).toBeCloseTo(3);
    expect(shares.get("s2")).toBeCloseTo(1);
    expect(attributedPoints(["s1", "s2"]).get("s1")).toBeCloseTo(3);
  });

  test("a reset between readings attributes nothing", () => {
    const a = new Attributor();
    a.observe("acct2", weekly(NOW, 80), ["s1"]);
    expect(a.observe("acct2", weekly(NOW + HOUR, 3, NOW + 170 * HOUR), ["s1"]).size).toBe(0);
  });
});

describe("calibration", () => {
  test("percentiles interpolate", () => {
    expect(percentiles([1, 2, 3, 4, 5])).toEqual({ p50: 3, p75: 4, p90: 4.6 });
    expect(percentiles([])).toEqual({ p50: null, p75: null, p90: null });
  });

  test("recovers the short→weekly ratio from windows that moved together", () => {
    const k = 22; // weekly points per full short window
    const rows: UsageSampleRow[] = [];
    let weeklyPct = 10;
    for (let w = 0; w < 6; w++) {
      const start = NOW + w * 6 * HOUR;
      const resets = start + 5 * HOUR;
      const rise = 20 + w * 10; // short window rises 20..70%
      rows.push({ accountId: "a", at: start, windowId: "five_hour", kind: "short", usedPct: 0, resetsAt: resets, source: "endpoint" });
      rows.push({ accountId: "a", at: start, windowId: "seven_day", kind: "weekly", usedPct: weeklyPct, resetsAt: NOW + 160 * HOUR, source: "endpoint" });
      weeklyPct += (k * rise) / 100;
      rows.push({ accountId: "a", at: start + 4 * HOUR, windowId: "five_hour", kind: "short", usedPct: rise, resetsAt: resets, source: "endpoint" });
      rows.push({ accountId: "a", at: start + 4 * HOUR, windowId: "seven_day", kind: "weekly", usedPct: weeklyPct, resetsAt: NOW + 160 * HOUR, source: "endpoint" });
    }
    const est = estimateShortInWeekly(rows);
    expect(est.samples).toBe(6);
    expect(est.estimate).toBeCloseTo(k, 0);
    expect(est.r2).toBeGreaterThan(0.95);
  });

  test("ignores windows during which the weekly reset", () => {
    const rows: UsageSampleRow[] = [
      { accountId: "a", at: NOW, windowId: "five_hour", kind: "short", usedPct: 0, resetsAt: NOW + 5 * HOUR, source: "x" },
      { accountId: "a", at: NOW, windowId: "seven_day", kind: "weekly", usedPct: 90, resetsAt: NOW + HOUR, source: "x" },
      { accountId: "a", at: NOW + 3 * HOUR, windowId: "five_hour", kind: "short", usedPct: 50, resetsAt: NOW + 5 * HOUR, source: "x" },
      { accountId: "a", at: NOW + 3 * HOUR, windowId: "seven_day", kind: "weekly", usedPct: 8, resetsAt: NOW + 169 * HOUR, source: "x" },
    ];
    expect(estimateShortInWeekly(rows).samples).toBe(0);
  });
});
