import { expect, test } from "bun:test";
import { place, type AccountState } from "../balancer";
import type { BalancerSettings, UsageWindow } from "../types";

const M = 60_000;
const H = 60 * M;
const NOW = 1_800_000_000_000;

const settings: BalancerSettings = {
  claimNormal: 3,
  claimBig: 6,
  shortWindowInWeekly: 24,
  claimIdleMin: 60,
  resetHorizonMin: 60,
};

function win(kind: "short" | "weekly", usedPct: number, resetsIn: number): UsageWindow {
  return {
    id: kind,
    kind,
    label: kind,
    usedPct,
    resetsAt: NOW + resetsIn,
    windowMs: kind === "short" ? 5 * H : 7 * 24 * H,
  };
}

/** An account whose 5-hour window went from `from` to `short` over the last 45 minutes. */
function acct(label: string, o: { short: number; from?: number; resetsIn?: number; weekly?: number; claims?: AccountState["claims"] }): AccountState {
  const resetsIn = o.resetsIn ?? 2 * H;
  const short = win("short", o.short, resetsIn);
  return {
    account: { id: label, label, enabled: true },
    windows: [short, win("weekly", o.weekly ?? 10, 5 * 24 * H)],
    shortSamples:
      o.from === undefined
        ? []
        : [
            { at: NOW - 45 * M, usedPct: o.from, resetsAt: short.resetsAt },
            { at: NOW, usedPct: o.short, resetsAt: short.resetsAt },
          ],
    claims: o.claims ?? [],
  };
}

const run = (accounts: AccountState[]) => place({ provider: "claude", big: false, accounts, settings, now: NOW });

test("with a pace, claims of sessions it has measured add nothing to the forecast", () => {
  // 36% used, filling at 6/h for 2 more hours: 48 at reset. 16 weekly points
  // of claims (67 of the 5-hour window) from sessions running all along.
  const p = run([acct("A", { short: 36, from: 31.5, claims: [{ outstanding: 16, since: NOW - 3 * H }] })]);
  const c = p.candidates[0]!;
  expect(c.shortPace).toBe(6);
  expect(c.shortEffective).toBe(48);
  expect(c.legRoom).toBe(52);
});

test("a claim counts for the part of the pace's span its session was not yet there", () => {
  // Started 15 minutes into the 45: the pace missed a third of it, 2 of its
  // 6 weekly points, which is 8.3 of the 5-hour window on top of 48.
  const p = run([acct("A", { short: 36, from: 31.5, claims: [{ outstanding: 6, since: NOW - 30 * M }] })]);
  expect(p.candidates[0]!.shortEffective).toBe(56.3);
  // Started just now: all of it.
  const q = run([acct("A", { short: 36, from: 31.5, claims: [{ outstanding: 6, since: NOW }] })]);
  expect(q.candidates[0]!.shortEffective).toBe(73);
});

test("without a pace, every claim counts", () => {
  const p = run([acct("A", { short: 36, claims: [{ outstanding: 16, since: NOW - 3 * H }] })]);
  const c = p.candidates[0]!;
  expect(c.shortPace).toBeNull();
  expect(c.shortEffective).toBe(102.7);
  expect(c.legRoom).toBe(0);
});

test("a lightly used account with old claims outranks on weekly rather than losing its room to them", () => {
  // A: busy with old sessions but barely filling; lots of weekly to spend.
  // B: fresh, but its weekly resets later with more used.
  const a = acct("A", { short: 36, from: 31.5, weekly: 10, claims: [{ outstanding: 16, since: NOW - 3 * H }] });
  const b = acct("B", { short: 5, weekly: 60 });
  expect(run([a, b]).accountId).toBe("A");
});
