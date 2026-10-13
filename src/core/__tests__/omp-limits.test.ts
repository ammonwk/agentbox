import { describe, expect, test } from "bun:test";
import { foldOmpRecord, goOutOfFunds, newOmpState } from "../providers/omp-transcript";

const failed = (provider: string, errorMessage: string, at: string) => ({
  type: "message",
  timestamp: at,
  message: { role: "assistant", provider, model: "m", content: [], stopReason: "error", errorMessage, errorStatus: 402 },
});

describe("omp limits", () => {
  test("an OpenCode Go key out of funds is that account's limit", () => {
    expect(goOutOfFunds("opencode-go", "Upstream request failed: Insufficient account funds")).toBe(true);
    expect(goOutOfFunds("opencode-go-responses", "insufficient balance")).toBe(true);
    expect(goOutOfFunds("anthropic", "Insufficient account funds")).toBe(false);
    expect(goOutOfFunds("opencode-go", "Invalid API key.")).toBe(false);
  });

  test("so it is a limit hit on opencode-go, while another provider's funds stay a fatal error", () => {
    const s = newOmpState();
    foldOmpRecord(s, failed("opencode-go", "Upstream request failed: Insufficient account funds", "2026-10-06T10:00:00Z"), 0);
    expect(s.rateLimitHits).toEqual([{ at: Date.parse("2026-10-06T10:00:00Z"), detail: "opencode-go/m: Upstream request failed: Insufficient account funds", provider: "opencode-go" }]);
    expect(s.turnError).toBeNull();
    foldOmpRecord(s, failed("anthropic", "Insufficient account funds", "2026-10-06T10:01:00Z"), 1);
    expect(s.rateLimitHits).toHaveLength(1);
    expect(s.turnError).toMatchObject({ kind: "fatal" });
  });
});
