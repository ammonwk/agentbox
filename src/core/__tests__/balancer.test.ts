import { expect, test } from "bun:test";
import { elsewhere, place, type AccountState } from "../balancer";
import type { BalancerSettings, UsageWindow } from "../types";

const M = 60_000;
const H = 60 * M;
const NOW = 1_800_000_000_000;

const settings: BalancerSettings = {
  claimNormal: 3,
  claimIdleMin: 60,
  resetHorizonMin: 60,
  shortLoadPct: 50,
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
function acct(label: string, o: { short: number; from?: number; resetsIn?: number; weekly?: number; weeklyResetsIn?: number; claims?: AccountState["claims"] }): AccountState {
  const resetsIn = o.resetsIn ?? 2 * H;
  const short = win("short", o.short, resetsIn);
  return {
    account: { id: label, label, enabled: true },
    windows: [short, win("weekly", o.weekly ?? 10, o.weeklyResetsIn ?? 5 * 24 * H)],
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

const run = (accounts: AccountState[]) => place({ provider: "claude", accounts, settings, now: NOW });

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
  const a = acct("A", { short: 20, from: 15.5, weekly: 10, claims: [{ outstanding: 16, since: NOW - 3 * H }] });
  const b = acct("B", { short: 5, weekly: 60 });
  expect(run([a, b]).accountId).toBe("A");
});

const D = 24 * H;

test("the account whose weekly resets soonest is used up first, however little it has left", () => {
  // A: 7 points left and a day and a half to use them. B: most of its week, and five days.
  const a = acct("A", { short: 0, weekly: 93, weeklyResetsIn: 38 * H });
  const b = acct("B", { short: 5, weekly: 25, weeklyResetsIn: 5 * D });
  const p = run([a, b]);
  expect(p.accountId).toBe("A");
  expect(p.why).toContain("A's weekly resets soonest (in 1d 14h; B's in 5d 0h), with 7% of it still to use");
});

test("it is loaded until its 5-hour window is forecast half full, then the next to reset takes over", () => {
  const b = acct("B", { short: 5, weekly: 25, weeklyResetsIn: 5 * D });
  // 30 used and a session's 12.5 keeps it under the line; 40 does not.
  expect(run([acct("A", { short: 30, weekly: 50, weeklyResetsIn: 38 * H }), b]).accountId).toBe("A");
  const over = run([acct("A", { short: 40, weekly: 50, weeklyResetsIn: 38 * H }), b]);
  expect(over.accountId).toBe("B");
  expect(over.candidates.find((c) => c.accountId === "A")).toMatchObject({ eligible: true, shortLoadTo: 50 });
});

test("an account that cannot finish its weekly at half load is loaded as far as it needs, short of full", () => {
  const b = acct("B", { short: 5, weekly: 25, weeklyResetsIn: 5 * D });
  // 60 points in 20 hours is 15 a window, 62.5% of one: the line moves there.
  const a = run([acct("A", { short: 45, weekly: 40, weeklyResetsIn: 20 * H }), b]);
  expect(a.candidates.find((c) => c.accountId === "A")!.shortLoadTo).toBe(62.5);
  expect(a.accountId).toBe("A");
  // 90 points in 10 hours cannot be done at all: 90% is as far as it goes.
  const rush = run([acct("A", { short: 80, weekly: 10, weeklyResetsIn: 10 * H }), b]);
  expect(rush.candidates.find((c) => c.accountId === "A")!.shortLoadTo).toBe(90);
  expect(rush.accountId).toBe("B");
});

test("an account with any weekly left takes one session more than fits, then no other; one whose week has not started goes last", () => {
  const b = acct("B", { short: 5, weekly: 25, weeklyResetsIn: 5 * D });
  // 2 points left and a session claims 3: it goes there, to use them up.
  expect(run([acct("A", { short: 0, weekly: 98, weeklyResetsIn: 38 * H }), b]).accountId).toBe("A");
  // With that session's claim on it the account is spoken for.
  const taken = run([acct("A", { short: 0, weekly: 98, weeklyResetsIn: 38 * H, claims: [{ outstanding: 3, since: NOW }] }), b]);
  expect(taken.accountId).toBe("B");
  expect(taken.candidates.find((c) => c.accountId === "A")!.reason).toContain("weekly is spoken for");
  const fresh = acct("C", { short: 0, weekly: 0 });
  fresh.windows[1]!.resetsAt = null;
  expect(run([fresh, b]).accountId).toBe("B");
});

test("a claim measured from sessions like it replaces the model's listed one", () => {
  const a = acct("A", { short: 30, weekly: 50, weeklyResetsIn: 38 * H });
  const b = acct("B", { short: 5, weekly: 25, weeklyResetsIn: 5 * D });
  // Listed, a session needs 12.5 of a window and A has room; measured at 6 points it needs 25 and does not.
  expect(place({ provider: "claude", accounts: [a, b], settings, now: NOW }).accountId).toBe("A");
  const p = place({ provider: "claude", accounts: [a, b], settings, now: NOW, claim: 6 });
  expect(p.claim).toBe(6);
  expect(p.accountId).toBe("B");
});

test("a session cut off at its account's limit goes to the balancer's next account that can take one, or nowhere", () => {
  // A is where it stopped: its reading is a minute stale and still looks open, and it is first to reset.
  const a = acct("A", { short: 96, weekly: 60, weeklyResetsIn: 38 * H });
  const b = acct("B", { short: 5, weekly: 25, weeklyResetsIn: 5 * D });
  const c = acct("C", { short: 5, weekly: 25, weeklyResetsIn: 3 * D });
  expect(elsewhere(run([a, b, c]), "A")!.accountId).toBe("C");
  const full = acct("B", { short: 100, weekly: 25, weeklyResetsIn: 5 * D });
  expect(elsewhere(run([a, full]), "A")).toBeNull();
});

test("a session's one move goes to an account whose weekly has room for it", () => {
  // 2026-10-11: nymkiect, claiming 2.4 points, was moved to the account first
  // to reset, which had 1.2 left, past two with 23 and 46.
  const own = acct("A", { short: 49, weekly: 100, weeklyResetsIn: 3 * D });
  const last = acct("B", { short: 10, weekly: 98.8, weeklyResetsIn: 3.5 * D });
  const roomy = acct("C", { short: 9, weekly: 77, weeklyResetsIn: 4 * D });
  const p = place({ provider: "claude", accounts: [own, last, roomy], settings, now: NOW, claim: 2.4 });
  expect(p.accountId).toBe("B");
  expect(elsewhere(p, "A")!.accountId).toBe("C");
  // With no such account, the one with the most weekly left rather than nowhere.
  const tight = acct("C", { short: 9, weekly: 98, weeklyResetsIn: 4 * D });
  expect(elsewhere(place({ provider: "claude", accounts: [own, last, tight], settings, now: NOW, claim: 2.4 }), "A")!.accountId).toBe("C");
});

test("an expired login is a wall: no session is placed or moved onto it, overflow included", () => {
  // 2026-10-22: ammon@plaibook.tech's login ended at 20:19 with 11% of its
  // week used; it stayed the account with the most room, and seven sessions
  // started on it died on their first call.
  const dead = { ...acct("A", { short: 0, weekly: 11 }), auth: "expired" as const };
  const busy = acct("B", { short: 40, weekly: 80 });
  const p = run([dead, busy]);
  expect(p.accountId).toBe("B");
  expect(p.candidates.find((c) => c.accountId === "A")).toMatchObject({ eligible: false, wall: true, reason: "its login has expired: log in again" });
  expect(elsewhere(p, "B")).toBeNull();
  // Every other account spoken for: overflow still passes it by.
  const spoken = acct("B", { short: 40, weekly: 99, claims: [{ outstanding: 3, since: NOW }] });
  expect(run([dead, spoken])).toMatchObject({ accountId: "B", mode: "overflow" });
});
