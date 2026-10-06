import { expect, test } from "bun:test";
import { mapGoUsage } from "../accounts/usage";

const HOUR = 3_600_000;
const now = Date.parse("2026-10-06T23:00:00.000Z");

test("Go's usage report becomes a 5-hour, a weekly and a monthly window", () => {
  const windows = mapGoUsage(
    {
      usage: {
        rolling: { status: "ok", percent: 54, resetsAt: "2026-10-07T00:07:31.000Z" },
        weekly: { status: "ok", percent: 61, resetsAt: "2026-10-12T00:00:00.000Z" },
        monthly: { status: "ok", percent: 30, resetsAt: "2026-11-05T02:33:42.000Z" },
      },
    },
    now,
  );
  expect(windows.map((w) => [w.id, w.kind, w.usedPct, w.resetsAt])).toEqual([
    ["opencode-go:rolling-5h", "short", 54, Date.parse("2026-10-07T00:07:31.000Z")],
    ["opencode-go:weekly", "weekly", 61, Date.parse("2026-10-12T00:00:00.000Z")],
    ["opencode-go:monthly", "monthly", 30, Date.parse("2026-11-05T02:33:42.000Z")],
  ]);
});

test("a rate-limited window is full, and an empty 5-hour window has no reset", () => {
  const windows = mapGoUsage(
    {
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: new Date(now + 5 * HOUR).toISOString() },
        weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-12T00:00:00.000Z" },
      },
    },
    now,
  );
  expect(windows.map((w) => [w.id, w.usedPct, w.resetsAt])).toEqual([
    ["opencode-go:rolling-5h", 0, null],
    ["opencode-go:weekly", 100, Date.parse("2026-10-12T00:00:00.000Z")],
  ]);
});

test("a 5-hour window under one percent keeps the reset its last call set", () => {
  const resetsAt = now + 2 * HOUR;
  const [w] = mapGoUsage({ usage: { rolling: { status: "ok", percent: 0, resetsAt: new Date(resetsAt).toISOString() } } }, now);
  expect(w!.resetsAt).toBe(resetsAt);
});

test("anything else is no windows", () => {
  expect(mapGoUsage({ type: "error", error: { type: "AuthError" } }, now)).toEqual([]);
  expect(mapGoUsage(null, now)).toEqual([]);
});
