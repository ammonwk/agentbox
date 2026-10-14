/** Automatic follows Codex's weekly left: Codex above 50%, implementation
 * sessions split from 10% to 50%, Claude below 10%; a pin always wins. */
import { test, expect } from "bun:test";
import { chooseProvider, type AgentProvider } from "./providers";
import type { Candidate, Placement } from "../types";

const place = (codexUsed: number | null, codexMode: Placement["mode"] = "auto") => (p: AgentProvider): Placement => {
  const accountId = `${p}-1`;
  const weekly = p === "codex" ? codexUsed : 20;
  const mode = p === "codex" ? codexMode : "auto";
  return {
    provider: p,
    accountId: mode === "none" ? null : accountId,
    mode,
    claim: 0,
    candidates: [{ accountId, weekly } as Candidate],
    why: mode === "none" ? "every account is spent." : "room",
  };
};
const choose = (codexUsed: number | null, o: { previous?: AgentProvider; pinned?: AgentProvider; writer?: { last: AgentProvider | null }; codexMode?: Placement["mode"] } = {}) => {
  const c = chooseProvider(place(codexUsed, o.codexMode), { installed: () => true, model: () => null, now: 1, previous: o.previous ?? null, pinned: o.pinned, writer: o.writer });
  if ("none" in c) throw Error(c.none);
  return c;
};

test("above 50% Codex weekly left, conversations and writers start on Codex", () => {
  const c = choose(30, { previous: "claude" });
  expect(c.provider).toBe("codex");
  expect(c.why).toContain("Codex has 70% of its weekly left, above 50%");
  expect(choose(30, { writer: { last: "codex" } }).provider).toBe("codex");
});

test("from 10% to 50% left, writers alternate and the conversation stays on Codex", () => {
  expect(choose(70, { previous: "claude" }).provider).toBe("codex");
  expect(choose(70, { writer: { last: null } }).provider).toBe("codex");
  const second = choose(70, { writer: { last: "codex" } });
  expect(second.provider).toBe("claude");
  expect(second.why).toContain("the last one ran on Codex");
  expect(choose(70, { writer: { last: "claude" } }).provider).toBe("codex");
  expect(choose(50, { writer: { last: "codex" } }).provider).toBe("claude");
  expect(choose(90, { writer: { last: "codex" } }).provider).toBe("claude");
});

test("below 10% left, Claude comes first", () => {
  const c = choose(95, { previous: "codex", writer: { last: "claude" } });
  expect(c.provider).toBe("claude");
  expect(c.why).toContain("below 10%");
  expect(choose(95, { previous: "codex" }).provider).toBe("claude");
});

test("a pin keeps its provider, and room still outranks the preferred order", () => {
  const pinned = choose(10, { pinned: "codex" });
  expect([pinned.provider, pinned.policy]).toEqual(["codex", "pinned"]);
  expect(choose(95, { pinned: "codex" }).provider).toBe("codex");
  const spent = choose(30, { codexMode: "none" });
  expect(spent.provider).toBe("claude");
  expect(spent.why).toContain("Codex: every account is spent.");
});

test("with Codex's weekly unknown, the previous provider then Claude", () => {
  expect(choose(null, { previous: "codex" }).provider).toBe("codex");
  expect(choose(null).provider).toBe("claude");
});
