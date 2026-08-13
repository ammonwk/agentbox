import { describe, expect, test } from "bun:test";
import { hrefOf, parseHash, type Route } from "./route";
import { ago, fmtCost, fmtTokens, mergeEventsBySeq } from "./api";
import type { TranscriptEvent } from "../../src/core/types";

describe("routing", () => {
  test("reads the three pages and a session deep link", () => {
    expect(parseHash("#/inbox")).toEqual({ page: "inbox" });
    expect(parseHash("#/settings")).toEqual({ page: "settings" });
    expect(parseHash("#/sessions")).toEqual({ page: "sessions", sessionId: null });
    expect(parseHash("#/sessions/abc123")).toEqual({ page: "sessions", sessionId: "abc123" });
  });

  test("anything unrecognised lands on the inbox rather than a blank screen", () => {
    for (const hash of ["", "#", "#/", "#/nope", "#/prs", "#/skills/x"]) {
      expect(parseHash(hash).page).toBe("inbox");
    }
  });

  test("round-trips every route, including ids needing escaping", () => {
    const routes: Route[] = [
      { page: "inbox" },
      { page: "settings" },
      { page: "sessions", sessionId: null },
      { page: "sessions", sessionId: "s-1" },
      { page: "sessions", sessionId: "feature/thing #2" },
    ];
    for (const r of routes) expect(parseHash(hrefOf(r))).toEqual(r);
  });

  test("a malformed escape does not throw", () => {
    // Asserting the whole route, not `.sessionId`: only the `sessions` member
    // of the union carries that field, and reaching for it unnarrowed is the
    // same type lie the old sidebar's `counts[id as "conductor"]` was.
    expect(parseHash("#/sessions/%E0%A4%A")).toEqual({
      page: "sessions",
      sessionId: "%E0%A4%A",
    });
  });
});

describe("mergeEventsBySeq", () => {
  const ev = (seq: number): TranscriptEvent => ({ seq, ts: seq * 1000, type: "assistant", text: `#${seq}` });

  test("appends and keeps seq order", () => {
    const held = new Map<number, TranscriptEvent>();
    expect(mergeEventsBySeq(held, [ev(1), ev(2)])?.map((e) => e.seq)).toEqual([1, 2]);
    expect(mergeEventsBySeq(held, [ev(3)])?.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("a reconnect replay does not duplicate", () => {
    const held = new Map<number, TranscriptEvent>();
    mergeEventsBySeq(held, [ev(1), ev(2), ev(3)]);
    expect(mergeEventsBySeq(held, [ev(2), ev(3)])).toBeNull();
    expect(held.size).toBe(3);
  });

  test("out-of-order arrival still sorts", () => {
    const held = new Map<number, TranscriptEvent>();
    expect(mergeEventsBySeq(held, [ev(5), ev(2), ev(9)])?.map((e) => e.seq)).toEqual([2, 5, 9]);
  });

  test("a later version of the same seq replaces the earlier one", () => {
    const held = new Map<number, TranscriptEvent>();
    mergeEventsBySeq(held, [ev(1)]);
    const updated: TranscriptEvent = { seq: 1, ts: 1000, type: "assistant", text: "rewritten" };
    // Same seq, so nothing is "added" — but the stored copy is the new one.
    expect(mergeEventsBySeq(held, [updated])).toBeNull();
    expect(held.get(1)).toBe(updated);
  });
});

describe("formatting", () => {
  test("ago is computed against a passed instant, not Date.now()", () => {
    const now = 1_000_000_000;
    expect(ago(now, now)).toBe("just now");
    expect(ago(now - 30_000, now)).toBe("30s ago");
    expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
    expect(ago(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(ago(now + 5000, now)).toBe("just now"); // clock skew must not read as the future
  });

  test("null costs and tokens render as an em dash, not 0", () => {
    expect(fmtCost(null)).toBe("—");
    expect(fmtTokens(null)).toBe("—");
    expect(fmtCost(0)).toBe("$0");
    expect(fmtTokens(0)).toBe("0");
  });

  test("sub-cent costs stay legible", () => {
    expect(fmtCost(0.0042)).toBe("0.42¢");
    expect(fmtCost(1.5)).toBe("$1.500");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(2_400_000)).toBe("2.4M");
  });
});
