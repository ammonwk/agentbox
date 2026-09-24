import { describe, expect, test } from "bun:test";
import { place, type AccountState } from "../balancer";
import { DEFAULT_BALANCER } from "../db";
import type { UsageWindow } from "../types";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 24, 12);

function claude(
  id: string,
  weekly: number,
  short: number,
  opts: { weeklyResetH?: number; shortResetH?: number; outstanding?: number[]; enabled?: boolean } = {},
): AccountState {
  const windows: UsageWindow[] = [
    {
      id: "five_hour", kind: "short", label: "5-hour", usedPct: short,
      resetsAt: short === 0 && opts.shortResetH === undefined ? null : NOW + (opts.shortResetH ?? 3) * HOUR,
      windowMs: 5 * HOUR,
    },
    {
      id: "seven_day", kind: "weekly", label: "Weekly", usedPct: weekly,
      resetsAt: NOW + (opts.weeklyResetH ?? 72) * HOUR, windowMs: 168 * HOUR,
    },
  ];
  return { account: { id, label: id, enabled: opts.enabled ?? true }, windows, outstanding: opts.outstanding ?? [] };
}

function codex(id: string, weekly: number, weeklyResetH: number, outstanding: number[] = []): AccountState {
  return {
    account: { id, label: id, enabled: true },
    windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPct: weekly, resetsAt: NOW + weeklyResetH * HOUR, windowMs: 168 * HOUR }],
    outstanding,
  };
}

const req = (accounts: AccountState[], extra: { big?: boolean; model?: string; accountId?: string } = {}) => ({
  provider: "claude" as const,
  big: extra.big ?? false,
  model: extra.model,
  accountId: extra.accountId,
  accounts,
  settings: DEFAULT_BALANCER,
  now: NOW,
});

/** Place `n` sessions in a row, each one claiming on the account it landed on. */
function placeMany(accounts: AccountState[], n: number, big = false): string[] {
  const chosen: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = place(req(accounts, { big }));
    if (!p.accountId) {
      chosen.push("none");
      continue;
    }
    chosen.push(p.accountId);
    accounts.find((a) => a.account.id === p.accountId)!.outstanding.push(p.claim);
  }
  return chosen;
}

describe("the worked example from the design", () => {
  // A is 92% weekly / 0% short, B is 12% / 80%. Room is short-window room
  // capped by weekly left: A's 8 weekly points are a third of a 5-hour window.
  test("A first; then A's weekly is too thin to beat B; then B's 5-hour is spent", () => {
    const a = claude("A", 92, 0);
    const b = claude("B", 12, 80);
    expect(placeMany([a, b], 3)).toEqual(["A", "B", "A"]);

    const after = place(req([a, b]));
    const candA = after.candidates.find((c) => c.accountId === "A")!;
    expect(candA.eligible).toBe(false);
    expect(candA.weeklyEffective).toBe(102);
    expect(candA.reason).toContain("spoken for");
  });

  test("the first placement says why", () => {
    const p = place(req([claude("A", 92, 0), claude("B", 12, 80)]));
    expect(p.mode).toBe("auto");
    expect(p.claim).toBe(5);
    expect(p.why).toContain("most room");
    const a = p.candidates.find((c) => c.accountId === "A")!;
    // 8 weekly points left ÷ 24 per window = a third of a window.
    expect(a.legRoom).toBeCloseTo(33.3, 1);
    expect(a.weeklyEffective).toBe(92);
  });

  test("a nearly spent weekly does not look like a fresh account", () => {
    // The case that prompted the cap: 97% weekly with an idle 5-hour window
    // used to show room 96, level with an untouched account.
    const nearlyOut = claude("nearly-out", 97, 4);
    const fresh = claude("fresh", 0, 30);
    const p = place(req([nearlyOut, fresh]));
    expect(p.accountId).toBe("fresh");
    expect(p.candidates.find((c) => c.accountId === "nearly-out")!.legRoom).toBeCloseTo(12.5, 1);
  });
});

describe("claims", () => {
  test("claims spread sessions across two fresh accounts instead of piling onto one", () => {
    const chosen = placeMany([claude("A", 10, 0), claude("B", 10, 0)], 6);
    expect(chosen.filter((c) => c === "A").length).toBe(3);
    expect(chosen.filter((c) => c === "B").length).toBe(3);
  });

  test("a Big session claims 20 and occupies most of a short window", () => {
    const a = claude("A", 50, 0);
    const p = place(req([a], { big: true }));
    expect(p.claim).toBe(20);
    a.outstanding.push(p.claim);
    const c = place(req([a])).candidates[0]!;
    expect(c.weeklyEffective).toBe(70);
    // 20 weekly points at 24 per short window ≈ 83% of it.
    expect(c.shortEffective).toBeCloseTo(83.3, 0);
  });

  test("an account under 100 but with a claim that would take it over is still eligible", () => {
    // The gate is W' < 100, not W' + claim ≤ 100 — the claim is an estimate.
    const p = place(req([claude("A", 97, 0)]));
    expect(p.accountId).toBe("A");
    expect(p.mode).toBe("auto");
    expect(p.candidates[0]!.eligible).toBe(true);
  });
});

describe("the short window", () => {
  test("an account about to reset counts as nearly fresh", () => {
    const soon = claude("soon", 30, 85, { shortResetH: 0.1 });
    const later = claude("later", 30, 40, { shortResetH: 4 });
    const p = place(req([soon, later]));
    expect(p.accountId).toBe("soon");
    const c = p.candidates.find((x) => x.accountId === "soon")!;
    expect(c.legRoom).toBeGreaterThan(80);
  });

  test("a reading whose window already reset counts as zero", () => {
    const stale = claude("stale", 30, 99, { shortResetH: -1 });
    const c = place(req([stale])).candidates[0]!;
    expect(c.short).toBe(0);
    expect(c.legRoom).toBe(100);
  });
});

describe("ties go to weekly that would otherwise expire", () => {
  test("within the band, the account whose weekly resets sooner with more left wins", () => {
    const expiring = claude("expiring", 40, 10, { weeklyResetH: 6 });
    const plenty = claude("plenty", 10, 5, { weeklyResetH: 150 });
    const p = place(req([plenty, expiring]));
    expect(p.accountId).toBe("expiring");
    expect(p.why).toContain("before it resets");
  });

  test("outside the band, leg room still wins", () => {
    const expiring = claude("expiring", 40, 50, { weeklyResetH: 6 });
    const fresh = claude("fresh", 10, 0, { weeklyResetH: 150 });
    expect(place(req([expiring, fresh])).accountId).toBe("fresh");
  });

  test("a switched-off account with a fresh window does not move the band", () => {
    const off = claude("off", 0, 0, { enabled: false });
    const a = claude("a", 10, 20, { weeklyResetH: 150 });
    const b = claude("b", 60, 25, { weeklyResetH: 10 });
    // Anchored on `off` (100) the band would be 90+, putting a and b outside it
    // and letting a win on leg room; among eligible ones they tie and b's
    // expiring weekly wins.
    expect(place(req([off, a, b])).accountId).toBe("b");
  });
});

describe("weekly-only providers (codex)", () => {
  test("most weekly left per hour until reset", () => {
    const p = place({ ...req([codex("x", 50, 24), codex("y", 20, 160)]), provider: "codex" });
    // x: 50 left over 24h ≈ 2.1/h; y: 80 over 160h = 0.5/h.
    expect(p.accountId).toBe("x");
  });

  test("claims move the rate, so sessions alternate", () => {
    const a = codex("a", 30, 100);
    const b = codex("b", 30, 100);
    const chosen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = place({ ...req([a, b]), provider: "codex" });
      chosen.push(p.accountId!);
      (p.accountId === "a" ? a : b).outstanding.push(p.claim);
    }
    expect(chosen.sort()).toEqual(["a", "a", "b", "b"]);
  });
});

describe("edges", () => {
  test("everything fully claimed but not exhausted overflows onto the least claimed", () => {
    const p = place(req([claude("A", 100, 0), claude("B", 99, 0, { outstanding: [5] }), claude("C", 90, 0, { outstanding: [5, 5] })]));
    expect(p.mode).toBe("overflow");
    // B is 99 + 5 = 104 effective, C is 90 + 10 = 100; A has no weekly left.
    expect(p.accountId).toBe("C");
    expect(p.why).toContain("fully claimed");
  });

  test("nothing with real weekly left says so and picks nothing", () => {
    const p = place(req([claude("A", 100, 0), claude("B", 100, 0, { enabled: false })]));
    expect(p.mode).toBe("none");
    expect(p.accountId).toBeNull();
    expect(p.why).toContain("pick one by hand");
  });

  test("a manual pick overrides, and says when it goes against the balancer", () => {
    const p = place(req([claude("A", 100, 0), claude("B", 10, 0)], { accountId: "A" }));
    expect(p.mode).toBe("manual");
    expect(p.accountId).toBe("A");
    expect(p.why).toContain("would not have");
  });

  test("a model-scoped weekly limit gates only that model", () => {
    const a = claude("A", 20, 0);
    a.windows.push({ id: "seven_day:Fable", kind: "weekly", label: "Fable weekly", usedPct: 100, resetsAt: NOW + 50 * HOUR, windowMs: 168 * HOUR, scope: { model: "Fable" } });
    const b = claude("B", 60, 50);
    expect(place(req([a, b], { model: "claude-fable-5-1" })).accountId).toBe("B");
    expect(place(req([a, b], { model: "claude-opus-5" })).accountId).toBe("A");
  });

  test("accounts with no usage reading are still usable, after known ones", () => {
    const unknown: AccountState = { account: { id: "u", label: "u", enabled: true }, windows: [], outstanding: [] };
    expect(place(req([unknown, claude("k", 50, 50)])).accountId).toBe("k");
    const only = place(req([unknown]));
    expect(only.accountId).toBe("u");
    expect(only.why).toContain("usage unknown");
  });

  test("no accounts at all", () => {
    expect(place(req([])).mode).toBe("none");
  });
});
