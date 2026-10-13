import { describe, expect, test } from "bun:test";
import { attentionOf, retrying } from "../attention";
import type { Session } from "../types";

const at = Date.now() + 4 * 60_000;
const session = (over: Partial<Session>): Session => ({ id: "s1", host: "tmux", status: "waiting", turnError: null, autoResume: null, subagent: null, ...over }) as Session;
const transient = { at: 0, kind: "transient" as const, detail: "API Error: 529 overloaded" };

describe("a session agentbox will retry", () => {
  test("an error screen it retries ranks with the working sessions, not as blocked", () => {
    const s = session({ status: "blocked", autoResume: { at, attempt: 1, of: 3, after: "error" } });
    expect(retrying(s)).toBe(true);
    const a = attentionOf(s, "error — agentbox retries it at 4:15 PM");
    expect(a.kind).toBe("running");
    expect(a.reason).toBe("error — agentbox retries it at 4:15 PM");
  });

  test("a turn error it retries is not your turn, and says when", () => {
    const a = attentionOf(session({ turnError: transient, autoResume: { at, attempt: 2, of: 3, after: "error" } }));
    expect(a.kind).toBe("running");
    expect(a.reason).toContain("API Error: 529 overloaded");
    expect(a.reason).toContain("agentbox retries it at");
  });

  test("once the retries are spent it is yours again", () => {
    expect(attentionOf(session({ status: "blocked" }), "error").kind).toBe("blocked");
    expect(attentionOf(session({ turnError: transient })).kind).toBe("waiting");
  });

  test("waiting out a 5-hour reset is still your turn", () => {
    const s = session({ autoResume: { at, attempt: 1, of: 1, after: "reset" } });
    expect(retrying(s)).toBe(false);
    expect(attentionOf(s).kind).toBe("waiting");
  });
});
