import { describe, expect, test } from "bun:test";
import { CodexFold } from "../providers/codex-transcript";

const rec = (timestamp: string, payload: object) => ({ timestamp, type: "event_msg", payload });
const capacity = { message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" };

function fold(records: object[]): CodexFold {
  const f = new CodexFold({ agentSessionId: "s" });
  records.forEach((r, i) => f.add(r, i));
  return f;
}

describe("codex: a turn refused for capacity", () => {
  test("is a transient turn error that waits ten minutes", () => {
    const f = fold([
      rec("2026-09-30T05:52:56.000Z", { type: "task_started", turn_id: "a" }),
      rec("2026-09-30T15:05:03.122Z", { type: "task_complete", turn_id: "a", last_agent_message: null, error: capacity }),
    ]).facts();
    expect(f.turnOpen).toBe(false);
    expect(f.turnError).toEqual({ at: Date.parse("2026-09-30T15:05:03.122Z"), kind: "transient", detail: capacity.message, retryAfterMs: 600_000 });
    expect(f.rateLimitHits).toEqual([]);
  });

  test("is cleared by the next turn", () => {
    const f = fold([
      rec("2026-09-30T15:05:03.122Z", { type: "task_complete", turn_id: "a", error: capacity }),
      rec("2026-09-30T16:56:10.947Z", { type: "task_started", turn_id: "b" }),
    ]).facts();
    expect(f.turnError).toBeNull();
  });

  test("a usage limit stays a limit hit, and a clean end is no error", () => {
    const limit = { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" };
    const f = fold([rec("2026-09-30T15:05:03.122Z", { type: "task_complete", turn_id: "a", error: limit })]).facts();
    expect(f.turnError).toBeNull();
    expect(f.rateLimitHits).toHaveLength(1);
    expect(fold([rec("2026-09-30T15:05:03.122Z", { type: "task_complete", turn_id: "a", last_agent_message: "done" })]).facts().turnError).toBeNull();
  });
});
