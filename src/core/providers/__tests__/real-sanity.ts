/** Invariants the real-data smoke tests check on whatever they read. Not a
 *  test file itself, so importing it registers no suites. */

import { expect } from "bun:test";
import type { TimelineEvent } from "../../types";
import type { TranscriptFacts } from "../types";

export function saneFacts(f: TranscriptFacts): void {
  for (const v of Object.values(f.tokens)) expect(Number.isFinite(v) && v >= 0).toBe(true);
  if (f.startedAt !== null && f.lastActivityAt !== null) expect(f.startedAt).toBeLessThanOrEqual(f.lastActivityAt);
  if (f.contextUsed !== null) expect(f.contextUsed).toBeGreaterThanOrEqual(0);
  if (f.contextLimit !== null) expect(f.contextLimit).toBeGreaterThan(0);
  expect(typeof f.turnOpen).toBe("boolean");
  for (const h of f.rateLimitHits) expect(h.detail.length).toBeGreaterThan(0);
}

export function saneEvents(events: TimelineEvent[]): void {
  const ids = new Set<string>();
  for (const e of events) {
    expect(ids.has(e.id)).toBe(false);
    ids.add(e.id);
    expect(Number.isFinite(e.at)).toBe(true);
    if (e.kind === "tool") {
      expect(["running", "ok", "error"]).toContain(e.status);
      expect((e.output ?? "").length).toBeLessThanOrEqual(8 * 1024 + 64);
      expect((e.input ?? "").length).toBeLessThanOrEqual(4 * 1024 + 64);
    }
  }
}

