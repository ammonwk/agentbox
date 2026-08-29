import { describe, expect, test } from "bun:test";
// Engine's compaction, on purpose: the failure text has to survive *their*
// summariser to reach my evidence, and that seam is only real if I test it.
import { summarizeToolOutput } from "../acp";
import {
  checkHeuristics,
  commandOf,
  evidenceFromEvents,
  fallbackEvidence,
  foldCall,
  newHeuristicState,
  parseVerdict,
  renderJudgePrompt,
  summarizeCall,
} from "../supervisor";
import type { ToolCall, ToolKind, ToolStatus, TranscriptEvent } from "../types";

let nextId = 0;

function call(
  kind: ToolKind,
  opts: {
    id?: string;
    input?: unknown;
    status?: ToolStatus;
    locations?: string[];
    title?: string;
  } = {},
): ToolCall {
  return {
    id: opts.id ?? `c${nextId++}`,
    kind,
    title: opts.title ?? kind,
    input: opts.input ?? {},
    status: opts.status ?? "ok",
    locations: opts.locations ?? [],
    output: null,
    startedAt: 0,
    endedAt: 1,
  };
}

function exec(command: string, status: ToolStatus = "ok", id?: string): ToolCall {
  return call("execute", { input: { command }, status, id });
}

/** Fold a whole sequence, checking after each call the way onToolCall does —
 *  checkHeuristics is stateful (it marks signatures as escalated), so a test
 *  that only checks at the end would not see a hit that fires mid-sequence. */
function runSequence(calls: ToolCall[]): string[] {
  const st = newHeuristicState();
  const hits: string[] = [];
  for (const c of calls) {
    foldCall(st, c);
    const hit = checkHeuristics(st);
    if (hit) hits.push(hit);
  }
  return hits;
}

describe("commandOf", () => {
  test("reads the common shapes and rejects the rest", () => {
    expect(commandOf({ command: "bun test" })).toBe("bun test");
    expect(commandOf({ cmd: "ls -la" })).toBe("ls -la");
    expect(commandOf({ command: ["git", "status"] })).toBe("git status");
    expect(commandOf("raw string")).toBe("raw string");
    expect(commandOf({ path: "src/a.ts" })).toBeNull();
    expect(commandOf(null)).toBeNull();
    expect(commandOf(42)).toBeNull();
  });
});

describe("repeated command heuristic", () => {
  test("fires on the third identical execute", () => {
    const hits = runSequence([exec("bun test"), exec("bun test"), exec("bun test")]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("same command 3 times");
    expect(hits[0]).toContain("bun test");
  });

  test("does not fire twice for the same command", () => {
    const hits = runSequence([
      exec("bun test"),
      exec("bun test"),
      exec("bun test"),
      exec("bun test"),
      exec("bun test"),
    ]);
    expect(hits).toHaveLength(1);
  });

  test("does not fire on distinct commands", () => {
    const hits = runSequence([
      exec("git status"),
      exec("bun test"),
      exec("git diff"),
      exec("ls src"),
      exec("cat package.json"),
      exec("git log --oneline -5"),
    ]);
    expect(hits).toEqual([]);
  });

  test("does not fire twice on the same command reported twice by ACP", () => {
    const hits = runSequence([
      exec("bun test", "pending", "a"),
      exec("bun test", "ok", "a"),
      exec("bun test", "pending", "b"),
      exec("bun test", "ok", "b"),
    ]);
    expect(hits).toEqual([]);
  });

  test("an execute with no command-shaped input is never compared", () => {
    const hits = runSequence([
      call("execute", { input: { foo: 1 } }),
      call("execute", { input: { foo: 1 } }),
      call("execute", { input: { foo: 1 } }),
      call("execute", { input: { foo: 1 } }),
    ]);
    expect(hits).toEqual([]);
  });
});

describe("consecutive error heuristic", () => {
  test("fires on the fourth failure in a row", () => {
    const hits = runSequence([
      exec("a", "error"),
      exec("b", "error"),
      exec("c", "error"),
      exec("d", "error"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("4 tool calls in a row failed");
  });

  test("a success in the middle resets the streak", () => {
    const hits = runSequence([
      exec("a", "error"),
      exec("b", "error"),
      exec("c", "error"),
      exec("d", "ok"),
      exec("e", "error"),
      exec("f", "error"),
      exec("g", "error"),
    ]);
    expect(hits).toEqual([]);
  });

  test("pending updates do not break the streak", () => {
    // ACP reports each call twice; the interleaved "pending" sighting is not
    // an outcome and must not count as a non-error.
    const hits = runSequence([
      exec("a", "pending", "1"),
      exec("a", "error", "1"),
      exec("b", "pending", "2"),
      exec("b", "error", "2"),
      exec("c", "pending", "3"),
      exec("c", "error", "3"),
      exec("d", "pending", "4"),
      exec("d", "error", "4"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("in a row failed");
  });

  test("a second run of failures can fire again", () => {
    const hits = runSequence([
      ...["a", "b", "c", "d"].map((c) => exec(c, "error")),
      exec("ok1", "ok"),
      ...["e", "f", "g", "h"].map((c) => exec(c, "error")),
    ]);
    expect(hits).toHaveLength(2);
  });
});

describe("same-file thrash heuristic", () => {
  test("fires on the seventh edit of one path", () => {
    const calls = Array.from({ length: 7 }, () =>
      call("edit", { locations: ["/w/src/a.ts"] }),
    );
    const hits = runSequence(calls);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("same file 7 times");
    expect(hits[0]).toContain("/w/src/a.ts");
  });

  test("six edits are still ordinary work", () => {
    const calls = Array.from({ length: 6 }, () =>
      call("edit", { locations: ["/w/src/a.ts"] }),
    );
    expect(runSequence(calls)).toEqual([]);
  });

  test("reads do not count as edits", () => {
    const calls = Array.from({ length: 20 }, () =>
      call("read", { locations: ["/w/src/a.ts"] }),
    );
    expect(runSequence(calls)).toEqual([]);
  });

  test("edits spread across files do not fire", () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      call("edit", { locations: [`/w/src/f${i}.ts`] }),
    );
    expect(runSequence(calls)).toEqual([]);
  });
});

describe("a benign long run stays quiet", () => {
  test("read, think, edit, test, commit", () => {
    const calls: ToolCall[] = [];
    for (let i = 0; i < 12; i++) calls.push(call("read", { locations: [`/w/src/f${i}.ts`] }));
    calls.push(call("search", { input: { pattern: "foo" } }));
    for (let i = 0; i < 5; i++) calls.push(call("edit", { locations: [`/w/src/f${i}.ts`] }));
    calls.push(exec("bun test src/core/__tests__/a.test.ts", "error"));
    calls.push(call("edit", { locations: ["/w/src/f0.ts"] }));
    calls.push(exec("bun test src/core/__tests__/a.test.ts", "ok"));
    calls.push(exec("git add -A"));
    calls.push(exec("git commit -m 'fix'"));
    calls.push(exec("git push -u origin feat/x"));
    calls.push(exec("gh pr create --fill"));
    expect(runSequence(calls)).toEqual([]);
  });
});

describe("the shapes that decide whether the judge can see a spiral", () => {
  // These pin a seam across two owners. The judge's ability to tell debugging
  // from thrashing rests entirely on the failure text reaching `detail`, and
  // every way that can break is silent: the verdict just becomes `ok`.

  test("a real ACP failure payload still yields failure text, with no errorMessage field", () => {
    // The captured shape is `{content, details, isError}` — there is NO
    // `errorMessage` key, though acp.ts reads one first. That read simply
    // misses and the `content` fallback carries the text. If a refactor ever
    // drops that fallback, `detail` empties and the judge silently reverts to
    // answering `ok` on genuine spirals.
    const raw = {
      content: [{ type: "text", text: "1 fail\nexpected 3 additions, got 0\n  at diff.test.ts:42" }],
      details: { exitCode: 1 },
      isError: true,
    };
    const output = summarizeToolOutput(raw);
    expect(output).toContain("expected 3 additions, got 0");

    const st = newHeuristicState();
    foldCall(st, { ...exec("bun test", "error"), output });
    const ev = fallbackEvidence(st)[0];
    expect(ev.t === "tool" && ev.detail).toContain("expected 3 additions, got 0");
  });

  test("a pending execute's command echo never reaches the evidence", () => {
    // omp puts the command itself in `content` while a call is pending, so a
    // summariser that read it early would show a command as its own result and
    // make every repeat look like it produced identical output — a false
    // `nudge`. `detail` is gated on status "error", which is terminal, so
    // the echo cannot get in.
    const st = newHeuristicState();
    foldCall(st, { ...exec("bun test", "pending"), output: "bun test" });
    const ev = fallbackEvidence(st)[0];
    expect(ev.t === "tool" && ev.detail).toBeUndefined();
  });

  test("execute calls carry no locations, so the file heuristic ignores them", () => {
    // Confirmed against a real ACP stream: only read/edit populate `locations`.
    // A shell loop must therefore be caught by the repeated-command heuristic,
    // never by the same-file one.
    const calls = Array.from({ length: 12 }, () => exec("npm test", "error"));
    for (const c of calls) expect(c.locations).toEqual([]);
    const st = newHeuristicState();
    for (const c of calls) foldCall(st, c);
    expect(st.edits.size).toBe(0);
  });

  test("the most common real spiral — an edit between every identical test run — IS caught", () => {
    // Edits land on *different* files, so the same-file heuristic never fires,
    // and the runs are not consecutive, so a "consecutive repeats" rule would
    // miss it too. The repeated-command counter is cumulative rather than
    // consecutive, which is what catches this shape.
    const st = newHeuristicState();
    const hits: string[] = [];
    for (let i = 0; i < 4; i++) {
      foldCall(st, call("edit", { locations: [`/w/src/f${i}.ts`] }));
      const afterEdit = checkHeuristics(st);
      if (afterEdit) hits.push(afterEdit);
      foldCall(st, exec("npm test", "error"));
      const afterRun = checkHeuristics(st);
      if (afterRun) hits.push(afterRun);
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toContain("npm test");
  });
});

describe("parseVerdict", () => {
  test("parses a clean object", () => {
    const v = parseVerdict('{"state":"nudge","reason":"loops on bun test","nudge":"Fix the test."}', 25, "model");
    expect(v).toEqual({
      state: "nudge",
      reason: "loops on bun test",
      nudge: "Fix the test.",
      source: "model",
      atToolCall: 25,
    });
  });

  test("digs the object out of a fence and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"state":"ok","reason":"reading files"}\n```\nHope that helps.';
    expect(parseVerdict(raw, 1, "heuristic")?.state).toBe("ok");
  });

  test("keeps the nudge text on nudge", () => {
    const v = parseVerdict(
      '{"state":"nudge","reason":"stubbed the parser","nudge":"Implement parse() for real."}',
      7,
      "heuristic",
    );
    expect(v?.state).toBe("nudge");
    expect(v?.nudge).toBe("Implement parse() for real.");
    expect(v?.source).toBe("heuristic");
  });

  test("nudge with no nudge text downgrades to ok — there is nothing to send", () => {
    const v = parseVerdict('{"state":"nudge","reason":"seems off"}', 3, "model");
    expect(v?.state).toBe("ok");
    expect(v?.nudge).toBeUndefined();
  });

  for (const [label, raw] of [
    ["empty output", ""],
    ["prose only", "The agent seems to be doing fine, honestly."],
    ["truncated json", '{"state":"spiral'],
    ["unknown state", '{"state":"panicking","reason":"x"}'],
    ["state is not a string", '{"state":3,"reason":"x"}'],
    ["null", "null"],
    ["an array", '["ok"]'],
    ["json with no state", '{"reason":"x"}'],
  ] as const) {
    test(`returns null for ${label}`, () => {
      expect(parseVerdict(raw, 0, "model")).toBeNull();
    });
  }

  test("a missing reason still yields a usable verdict", () => {
    const v = parseVerdict('{"state":"nudge","nudge":"try again"}', 0, "model");
    expect(v?.state).toBe("nudge");
    expect(v?.reason.length).toBeGreaterThan(0);
  });

  test("does not choke on a huge reason", () => {
    const v = parseVerdict(JSON.stringify({ state: "ok", reason: "x".repeat(5000) }), 0, "model");
    expect(v?.reason.length).toBeLessThanOrEqual(300);
  });
});

describe("evidence", () => {
  test("interleaves assistant text with tool calls, newest kept", () => {
    const events: TranscriptEvent[] = [
      { seq: 1, ts: 0, type: "assistant", text: "Looking at the parser." },
      { seq: 2, ts: 0, type: "tool", call: exec("bun test", "error") },
      { seq: 3, ts: 0, type: "turn", stopReason: "end_turn" },
      { seq: 4, ts: 0, type: "assistant", text: "  " },
    ];
    const ev = evidenceFromEvents(events);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({ t: "text", text: "Looking at the parser." });
    expect(ev[1]).toMatchObject({ t: "tool", kind: "execute", status: "error" });
  });

  test("keeps the whole conversation — a long run is judged on all of it", () => {
    const events: TranscriptEvent[] = Array.from({ length: 200 }, (_, i) => ({
      seq: i,
      ts: 0,
      type: "tool" as const,
      call: exec(`cmd${i}`),
    }));
    expect(evidenceFromEvents(events)).toHaveLength(200);
  });

  test("the fallback window tracks the outcome of an already-seen call", () => {
    const st = newHeuristicState();
    foldCall(st, exec("bun test", "pending", "x"));
    foldCall(st, exec("bun test", "error", "x"));
    const ev = fallbackEvidence(st);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ status: "error" });
  });

  test("the failure text arrives on the completion update, not the first sighting", () => {
    // ACP reports pending first with no output. If the window kept that line,
    // the judge would never see an error message — and measured against the
    // real judge, the error text is the only thing that separates a debugging
    // loop from a spiral.
    const st = newHeuristicState();
    const id = "y";
    foldCall(st, { ...exec("bun test", "pending", id), output: null });
    foldCall(st, { ...exec("bun test", "error", id), output: "expected 3, got 0" });
    expect(fallbackEvidence(st)[0]).toMatchObject({
      status: "error",
      detail: "expected 3, got 0",
    });
  });

  test("a successful call carries no detail — output is bulk in a compact window", () => {
    const st = newHeuristicState();
    foldCall(st, { ...exec("bun test", "ok"), output: "x".repeat(5000) });
    expect(fallbackEvidence(st)[0]).not.toHaveProperty("detail");
  });

  test("failure text is bounded", () => {
    const st = newHeuristicState();
    foldCall(st, { ...exec("bun test", "error"), output: "e".repeat(5000) });
    const ev = fallbackEvidence(st)[0];
    expect(ev.t === "tool" && ev.detail!.length).toBeLessThanOrEqual(200);
  });

  test("the fallback window is bounded", () => {
    const st = newHeuristicState();
    for (let i = 0; i < 500; i++) foldCall(st, exec(`cmd${i}`));
    expect(fallbackEvidence(st).length).toBeLessThanOrEqual(40);
  });
});

describe("summarizeCall", () => {
  test("prefers the command, then the path, then the title", () => {
    expect(summarizeCall(exec("git status"))).toBe("git status");
    expect(summarizeCall(call("edit", { locations: ["/w/a.ts"] }))).toBe("/w/a.ts");
    expect(summarizeCall(call("think", { title: "planning" }))).toBe("planning");
  });

  test("survives circular raw input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      summarizeCall(call("other", { input: circular, title: "" })),
    ).not.toThrow();
  });
});

describe("renderJudgePrompt", () => {
  test("fills every placeholder and carries the trigger", () => {
    const out = renderJudgePrompt(
      "Add a --json flag to the CLI",
      [{ t: "tool", kind: "execute", summary: "bun test", status: "error" }],
      "It has run the same command 3 times",
    );
    expect(out).not.toContain("{{");
    expect(out).toContain("Add a --json flag to the CLI");
    expect(out).toContain("same command 3 times");
    expect(out).toContain("! execute: bun test");
  });

  test("renders the failure text after an arrow, so repeats can be compared", () => {
    const out = renderJudgePrompt(
      "Task",
      [
        { t: "tool", kind: "execute", summary: "bun test", status: "error", detail: "expected 3, got 0" },
        { t: "tool", kind: "execute", summary: "bun test", status: "error", detail: "expected 3, got 1" },
      ],
      null,
    );
    expect(out).toContain("! execute: bun test → expected 3, got 0");
    expect(out).toContain("! execute: bun test → expected 3, got 1");
  });

  test("leaves no trigger section when nothing escalated", () => {
    const out = renderJudgePrompt("Task", [], null);
    expect(out).not.toContain("{{");
    expect(out).not.toContain("cheap check");
    expect(out).toContain("(nothing recorded yet)");
  });
});
