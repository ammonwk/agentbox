import { describe, expect, test } from "bun:test";
import { budget, healthWord, renderBudget, verdict, type AgentSnapshot } from "../health";
import type { ToolRecord } from "../subagents";

const NOW = 1_800_000_000_000;

function tool(seq: number, title: string, input: string | null, done = true): ToolRecord {
  return {
    seq,
    kind: "execute",
    title,
    status: done ? "ok" : "running",
    startedAtMs: NOW - 1000,
    ms: done ? 100 : null,
    input,
    output: done ? "out" : null,
  };
}

function snap(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: "a",
    cwd: "/repo",
    branch: "main",
    model: "m",
    readOnly: false,
    state: "running",
    startedAt: NOW - 60_000,
    turnStartedAt: NOW - 60_000,
    lastEventAt: NOW - 1_000,
    lastAction: "Read src/x.ts",
    turnToolCalls: 3,
    totalToolCalls: 3,
    uncollected: 0,
    contextUsed: 20_000,
    contextSize: 200_000,
    costUsd: 0.4,
    maxTurnMs: 4 * 60 * 60 * 1000,
    recent: [tool(1, "Read", "a"), tool(2, "Read", "b")],
    inFlightToolMs: null,
    ...over,
  };
}

describe("budgets, not progress bars", () => {
  test("consumption against ceilings, with no estimate in it", () => {
    const b = budget(snap(), NOW);
    expect(b.contextFraction).toBeCloseTo(0.1);
    expect(b.clockFraction).toBeCloseTo(60_000 / (4 * 3_600_000));
    expect(renderBudget(b)).toContain("ctx 20k/200k (10%)");
    expect(renderBudget(b)).toContain("of 4h");
    expect(renderBudget(b)).toContain("$0.40");
  });

  test("an unknown window is left unstated rather than guessed", () => {
    const b = budget(snap({ contextSize: null }), NOW);
    expect(b.contextFraction).toBeNull();
    expect(renderBudget(b)).toContain("ctx 20k");
    expect(renderBudget(b)).not.toContain("%");
  });

  test("a rate needs enough turn to divide by", () => {
    expect(budget(snap({ turnStartedAt: NOW - 5_000 }), NOW).toolsPerMinute).toBeNull();
    expect(budget(snap({ turnStartedAt: NOW - 60_000 }), NOW).toolsPerMinute).toBeCloseTo(3);
  });
});

describe("saying what is wrong, in words", () => {
  test("an agent doing ordinary work has nothing said about it", () => {
    const v = verdict(snap(), NOW);
    expect(v.concern).toBeNull();
    expect(v.escalate).toBe(false);
  });

  test("the same call three times in six is a loop, and it escalates", () => {
    const recent = [
      tool(1, "Bash", "bun test"),
      tool(2, "Read", "a"),
      tool(3, "Bash", "bun test"),
      tool(4, "Bash", "bun test"),
    ];
    const v = verdict(snap({ recent }), NOW);
    expect(v.concern).toBe("looping");
    expect(v.note).toContain("Bash");
    expect(v.escalate).toBe(true);
  });

  test("working through many different files is not a loop", () => {
    const recent = ["a", "b", "c", "d", "e", "f"].map((f, i) => tool(i, "Read", f));
    expect(verdict(snap({ recent }), NOW).concern).toBeNull();
  });

  /**
   * The distinction the whole thing turns on. A clock alone cannot separate an
   * agent that is wedged from one that is running your test suite, and a
   * reader who cannot tell them apart eventually kills the wrong one.
   */
  test("silence inside a long tool call is waiting; silence outside one is being stuck", () => {
    const long = verdict(snap({ lastEventAt: NOW - 600_000, inFlightToolMs: 600_000 }), NOW);
    expect(long.concern).toBe("slow-tool");
    expect(long.escalate).toBe(false);

    const wedged = verdict(snap({ lastEventAt: NOW - 600_000, inFlightToolMs: null }), NOW);
    expect(wedged.concern).toBe("quiet");
    expect(wedged.escalate).toBe(true);
  });

  test("a long turn with no tool calls at all is called out", () => {
    const v = verdict(snap({ turnToolCalls: 0, recent: [], turnStartedAt: NOW - 300_000 }), NOW);
    expect(v.findings.some((f) => f.concern === "silent")).toBe(true);
  });

  test("a nearly-full context window is worth saying before the answer gets worse", () => {
    const v = verdict(snap({ contextUsed: 190_000 }), NOW);
    expect(v.findings.some((f) => f.concern === "context")).toBe(true);
    // Real, but not worth breaking somebody's wait over.
    expect(v.escalate).toBe(false);
  });

  test("the worst thing leads, and everything true is still there", () => {
    const recent = [tool(1, "Bash", "x"), tool(2, "Bash", "x"), tool(3, "Bash", "x")];
    const v = verdict(snap({ recent, contextUsed: 190_000 }), NOW);
    expect(v.concern).toBe("looping");
    expect(v.findings.map((f) => f.concern)).toEqual(["looping", "context"]);
  });

  test("a finished agent is not in trouble; it is finished", () => {
    const recent = [tool(1, "Bash", "x"), tool(2, "Bash", "x"), tool(3, "Bash", "x")];
    expect(verdict(snap({ state: "idle", recent }), NOW).concern).toBeNull();
    expect(verdict(snap({ state: "dead", recent }), NOW).concern).toBeNull();
  });
});

describe("the word a roster shows", () => {
  /**
   * Every agent ends up dead, because being finished with is how an agent
   * ends. Rendering that identically to a process that fell over would hide
   * the loud case inside the ordinary one.
   */
  test("being finished with is not the same as falling over", () => {
    const done = snap({ state: "dead", endedReason: "stopped by the caller" });
    const died = snap({ state: "dead", endedReason: "omp exited with code -1" });
    expect(healthWord(verdict(done, NOW), done)).toBe("finished");
    expect(healthWord(verdict(died, NOW), died)).toBe("died");
  });

  test("a working agent says what is wrong with it, or that it is working", () => {
    const fine = snap();
    expect(healthWord(verdict(fine, NOW), fine)).toBe("working");
    const loop = snap({
      recent: [tool(1, "Bash", "x"), tool(2, "Bash", "x"), tool(3, "Bash", "x")],
    });
    expect(healthWord(verdict(loop, NOW), loop)).toBe("looping");
  });
});
