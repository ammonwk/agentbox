import { describe, expect, test } from "bun:test";
import { place, type AccountState } from "../balancer";
import { REFUSAL_HOLD_MS, refusedRoutes, type RouteOutcome } from "../refusals";
import { foldOmpRecord, newOmpState, refusesTheRoute } from "../providers/omp-transcript";
import type { BalancerSettings } from "../types";

const M = 60_000;
const NOW = 1_800_000_000_000;
const BUNNY = "opencode-go/space-bunny-free";
const UNAVAILABLE = "400 Upstream request failed: Model is unavailable.";

const refused = (accountId: string, ago: number, model = BUNNY, okAgo: number | null = null): RouteOutcome => ({
  accountId, model, refusedAt: NOW - ago, okAt: okAgo === null ? null : NOW - okAgo, detail: UNAVAILABLE,
});
const answered = (accountId: string, ago: number, model = BUNNY): RouteOutcome => ({ accountId, model, okAt: NOW - ago, refusedAt: null, detail: null });

describe("which accounts a model is refusing", () => {
  test("one refused session is not the route; two with nothing answered since are", () => {
    expect(refusedRoutes([refused("A", M)], BUNNY, ["A"], NOW).size).toBe(0);
    const r = refusedRoutes([refused("A", 3 * M, BUNNY, 60 * M), refused("A", M)], BUNNY, ["A"], NOW).get("A");
    expect(r).toEqual({ at: NOW - M, detail: UNAVAILABLE, sessions: 2, until: NOW - M + REFUSAL_HOLD_MS });
  });

  test("a session answered after the refusals opens the route, and another model's refusals never shut it", () => {
    expect(refusedRoutes([refused("A", 3 * M), refused("A", 2 * M), answered("A", M)], BUNNY, ["A"], NOW).size).toBe(0);
    expect(refusedRoutes([refused("A", 3 * M, "opencode-go/other"), refused("A", 2 * M, "opencode-go/other")], BUNNY, ["A"], NOW).size).toBe(0);
  });

  test("an hour after the last refusal one session is let through; the rest wait to hear, and its refusal shuts the route again", () => {
    const old = [refused("A", 61 * M), refused("A", 62 * M)];
    expect(refusedRoutes(old, BUNNY, ["A"], NOW).size).toBe(0);
    const trial: RouteOutcome = { accountId: "A", model: BUNNY, okAt: null, refusedAt: null, detail: null, startedAt: NOW - 20_000 };
    expect(refusedRoutes([...old, trial], BUNNY, ["A"], NOW).get("A")?.until).toBe(NOW - 20_000 + 10 * M);
    // One started before the hold ran out, or long ago, is not the trial.
    expect(refusedRoutes([...old, { ...trial, startedAt: NOW - 30 * M }], BUNNY, ["A"], NOW).size).toBe(0);
    expect(refusedRoutes([...old, refused("A", M)], BUNNY, ["A"], NOW).get("A")?.sessions).toBe(3);
    expect(refusedRoutes([...old, answered("A", M)], BUNNY, ["A"], NOW).size).toBe(0);
  });

  test("a refused session's earlier answers do not open the route: they may be another account's", () => {
    // Both answered a while ago (one of them on the account it woke from) and were refused since.
    expect(refusedRoutes([refused("A", 3 * M, BUNNY, 20 * M), refused("A", M, BUNNY, 2 * M)], BUNNY, ["A"], NOW).get("A")?.sessions).toBe(2);
  });

  test("each account is judged on its own sessions, and two refused alike speak for the untried", () => {
    // A's workspace is turned down: B and C, which nothing has run it on, are tried.
    expect([...refusedRoutes([refused("A", 2 * M), refused("A", M)], BUNNY, ["A", "B", "C"], NOW).keys()]).toEqual(["A"]);
    // The model is down: A and B both say so, and C need not find out.
    const down = [refused("A", 4 * M), refused("A", 3 * M), refused("B", 2 * M), refused("B", M)];
    expect([...refusedRoutes(down, BUNNY, ["A", "B", "C"], NOW).keys()]).toEqual(["A", "B", "C"]);
    // C is getting answers: it is A's and B's, not the model's.
    expect([...refusedRoutes([...down, answered("C", 5 * M)], BUNNY, ["A", "B", "C", "D"], NOW).keys()]).toEqual(["A", "B"]);
    // A's hold has run out and it is due a trial; that is not A answering, so C stays shut.
    const later = [refused("A", 64 * M), refused("A", 63 * M), refused("B", 2 * M), refused("B", M)];
    expect([...refusedRoutes(later, BUNNY, ["A", "B", "C"], NOW).keys()].sort()).toEqual(["B", "C"]);
  });
});

describe("what a transcript says of its model", () => {
  const msg = (at: string, m: Record<string, unknown>) => ({ type: "message", timestamp: at, message: { role: "assistant", provider: "opencode-go", model: "space-bunny-free", content: [], ...m } });
  const fold = (...recs: unknown[]) => {
    const s = newOmpState();
    recs.forEach((r, i) => foldOmpRecord(s, r, i));
    return s.modelOutcome;
  };
  const T = (min: number) => new Date(NOW + min * M).toISOString();

  test("a 4xx that is not about the request is a refusal, and only an answer clears it", () => {
    const down = msg(T(1), { stopReason: "error", errorStatus: 400, errorMessage: `${UNAVAILABLE}\nUpstream request failed` });
    expect(fold(msg(T(0), { stopReason: "stop", content: [{ type: "text", text: "Ready." }] }), down)).toEqual({ model: BUNNY, okAt: NOW, refusedAt: NOW + M, detail: UNAVAILABLE });
    // A prompt, and omp giving up on its retries, are not the route working.
    const prompt = { type: "message", timestamp: T(2), message: { role: "user", content: "Continue." } };
    const gaveUp = msg(T(3), { stopReason: "error", errorMessage: "Retry budget exhausted after 10 attempts" });
    expect(fold(down, prompt, gaveUp)?.refusedAt).toBe(NOW + M);
    expect(fold(down, prompt, msg(T(4), { stopReason: "toolUse" }))).toEqual({ model: BUNNY, okAt: NOW + 4 * M, refusedAt: null, detail: null });
  });

  test("a request the provider cannot take, a limit and a timeout say nothing about the route", () => {
    expect(refusesTheRoute({ errorStatus: 400, errorMessage: "400 This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it." })).toBe(true);
    expect(refusesTheRoute({ errorStatus: 400, errorMessage: "400 `arguments` must be valid JSON" })).toBe(false);
    expect(refusesTheRoute({ errorStatus: 400, errorMessage: "400 [invalid_request_error] invalid request" })).toBe(false);
    expect(refusesTheRoute({ errorStatus: 400, errorMessage: "prompt is too long: 210000 tokens" })).toBe(false);
    expect(refusesTheRoute({ errorStatus: 429, errorMessage: "Rate limit exceeded" })).toBe(false);
    expect(refusesTheRoute({ errorStatus: 402, errorMessage: "Insufficient account funds" })).toBe(false);
    expect(refusesTheRoute({ errorStatus: 400, errorMessage: "Insufficient credits" })).toBe(false);
    expect(refusesTheRoute({ errorStatus: 500, errorMessage: "Upstream request failed: Endpoint is unavailable." })).toBe(false);
    expect(refusesTheRoute({ errorMessage: "OpenAI completions stream timed out while waiting for the first event" })).toBe(false);
    expect(fold(msg(T(0), { stopReason: "error", errorStatus: 400, errorMessage: "400 `arguments` must be valid JSON" }))).toBeNull();
  });
});

describe("placing on a refused route", () => {
  const settings: BalancerSettings = { claimNormal: 3, shortWindowInWeekly: 24, claimIdleMin: 60, resetHorizonMin: 60, shortLoadPct: 50 };
  const acct = (id: string, isRefused: boolean): AccountState => ({
    account: { id, label: id, enabled: true },
    windows: [{ id: "weekly", kind: "weekly", label: "weekly", usedPct: 10, resetsAt: NOW + 5 * 24 * 60 * M, windowMs: 7 * 24 * 60 * M }],
    claims: [],
    refused: isRefused ? { at: NOW - M, detail: UNAVAILABLE, sessions: 2, until: NOW + 59 * M } : null,
  });
  const run = (accounts: AccountState[], accountId: string | null = null) => place({ provider: "omp", model: BUNNY, accountId, accounts, settings, now: NOW });

  test("the account it is refused on takes nothing, and another does", () => {
    const p = run([acct("A", true), acct("B", false)]);
    expect(p.accountId).toBe("B");
    const a = p.candidates.find((c) => c.accountId === "A")!;
    expect(a.eligible).toBe(false);
    expect(a.reason).toContain(`${BUNNY} is refused here: 2 sessions stand refused`);
    expect(a.reason).toContain("Model is unavailable.");
  });

  test("refused everywhere, it is placed nowhere, with the model named; a pick by hand still goes", () => {
    const p = run([acct("A", true), acct("B", true)]);
    expect(p.mode).toBe("none");
    expect(p.accountId).toBeNull();
    expect(p.why).toStartWith(`${BUNNY} is refused on every omp account that could otherwise take it`);
    expect(p.why).toContain("start it on another model");
    const byHand = run([acct("A", true), acct("B", true)], "A");
    expect(byHand.accountId).toBe("A");
    expect(byHand.why).toContain("which the balancer would not have");
  });
});
