import { describe, expect, test } from "bun:test";
import { MAX_TOOL_OUTPUT, ToolCallTracker, parseAdvisories, subagentsOf, summarizeToolOutput } from "../acp";
import capture from "./omp-tool-calls.capture.json";

/** A `tool_call` notification as omp sends it: no tool name anywhere. */
function startPayload(over: Record<string, unknown> = {}) {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Check whether the tests pass",
    kind: "execute",
    status: "pending",
    rawInput: { command: "bun test" },
    ...over,
  };
}

describe("ToolCallTracker", () => {
  test("assembles a start and its updates into one call keyed by toolCallId", () => {
    const t = new ToolCallTracker();
    const started = t.start(startPayload(), 1_000);
    expect(started).not.toBeNull();
    expect(started!).toMatchObject({
      id: "call-1",
      kind: "execute",
      title: "Check whether the tests pass",
      input: { command: "bun test" },
      status: "pending",
      output: null,
      startedAt: 1_000,
      endedAt: null,
    });

    const progress = t.update(
      { toolCallId: "call-1", status: "in_progress", locations: [{ path: "/w/a.ts", line: 3 }] },
      1_500
    );
    expect(progress).not.toBeNull();
    expect(progress!.finished).toBe(false);
    expect(progress!.call.status).toBe("running");
    expect(progress!.call.locations).toEqual(["/w/a.ts"]);
    // Fields the update did not mention survive.
    expect(progress!.call.input).toEqual({ command: "bun test" });
    expect(progress!.call.startedAt).toBe(1_000);

    const done = t.update(
      {
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { content: [{ type: "text", text: "12 pass" }], details: null, errorMessage: null },
      },
      2_000
    );
    expect(done!.finished).toBe(true);
    expect(done!.call.status).toBe("ok");
    expect(done!.call.output).toBe("12 pass");
    expect(done!.call.endedAt).toBe(2_000);
    expect(done!.call.title).toBe("Check whether the tests pass");
  });

  test("`finished` fires exactly once, so the supervisor is not double-counted", () => {
    const t = new ToolCallTracker();
    t.start(startPayload());
    expect(t.update({ toolCallId: "call-1", status: "completed" })!.finished).toBe(true);
    expect(t.update({ toolCallId: "call-1", status: "completed" })!.finished).toBe(false);
  });

  test("a call that arrives already complete is terminal at the start", () => {
    const t = new ToolCallTracker();
    const call = t.start(startPayload({ status: "completed", rawOutput: { content: "ok" } }), 500);
    expect(call!.status).toBe("ok");
    expect(call!.endedAt).toBe(500);
    expect(call!.output).toBe("ok");
  });

  test("failed maps to error and keeps the message", () => {
    const t = new ToolCallTracker();
    t.start(startPayload());
    const res = t.update({
      toolCallId: "call-1",
      status: "failed",
      rawOutput: { content: [], details: null, errorMessage: "exit 1: command not found" },
    });
    expect(res!.call.status).toBe("error");
    expect(res!.call.output).toBe("exit 1: command not found");
  });

  test("an update for a call we never saw start becomes a call rather than a hole", () => {
    const t = new ToolCallTracker();
    const res = t.update({
      toolCallId: "orphan",
      status: "completed",
      title: "Read src/index.ts",
      kind: "read",
      rawOutput: { content: "…" },
    });
    expect(res).not.toBeNull();
    expect(res!.finished).toBe(true);
    expect(res!.call).toMatchObject({ id: "orphan", kind: "read", title: "Read src/index.ts" });
  });

  test("unknown kinds and statuses degrade instead of throwing", () => {
    const t = new ToolCallTracker();
    const call = t.start(startPayload({ kind: "telepathy", status: "quantum", title: "" }));
    expect(call!.kind).toBe("other");
    expect(call!.status).toBe("pending");
    expect(call!.title).toBe("tool call");
  });

  test("two calls interleave without their updates crossing", () => {
    const t = new ToolCallTracker();
    t.start(startPayload({ toolCallId: "a", title: "A" }));
    t.start(startPayload({ toolCallId: "b", title: "B", kind: "read" }));
    const a = t.update({ toolCallId: "a", status: "completed", rawOutput: { content: "from a" } });
    const b = t.update({ toolCallId: "b", status: "failed", rawOutput: { errorMessage: "from b" } });
    expect(a!.call).toMatchObject({ title: "A", kind: "execute", status: "ok", output: "from a" });
    expect(b!.call).toMatchObject({ title: "B", kind: "read", status: "error", output: "from b" });
  });

  test("a payload with no toolCallId is ignored", () => {
    const t = new ToolCallTracker();
    expect(t.start({ sessionUpdate: "tool_call", title: "nameless" })).toBeNull();
    expect(t.update({ status: "completed" })).toBeNull();
  });
});

/**
 * `omp-tool-calls.capture.json` is the real `session/update` stream from omp
 * v17.2.11 (`opencode-go/deepseek-v4-flash`), logged raw before any mapping,
 * for a task that read a file, ran a shell command that succeeded, ran one that
 * failed, and edited a file. Worktree paths were rewritten to `/w`; nothing
 * else was touched. Hand-written payloads test our reading of the docs — this
 * tests the dependency.
 */
describe("ToolCallTracker over a real omp capture", () => {
  function replay() {
    const t = new ToolCallTracker();
    const finished: ReturnType<ToolCallTracker["start"]>[] = [];
    let ticks = 0;
    for (const u of capture as Record<string, unknown>[]) {
      const now = ++ticks * 1_000;
      if (u.sessionUpdate === "tool_call") {
        const call = t.start(u, now);
        if (call?.endedAt !== null) finished.push(call);
      } else {
        const res = t.update(u, now);
        if (res?.finished) finished.push(res.call);
      }
    }
    return finished;
  }

  test("every call in the capture assembles and terminates exactly once", () => {
    const done = replay();
    expect(done.map((c) => c!.id).length).toBe(new Set(done.map((c) => c!.id)).size);
    expect(done.map((c) => [c!.kind, c!.status])).toEqual([
      ["read", "ok"],
      ["execute", "ok"],
      ["execute", "error"],
      ["edit", "ok"],
    ]);
  });

  test("the input survives from the start payload to the terminal one", () => {
    const [read, ok, failed, edit] = replay();
    // The update that completes a call carries no rawInput; without carry-over
    // the Activity view renders a call with no arguments.
    expect(read!.input).toEqual({ path: "src/greet.js" });
    expect(ok!.input).toEqual({ command: "ls -1 src" });
    expect(failed!.input).toEqual({ command: "cat src/does-not-exist.js" });
    expect(edit!.input).toMatchObject({ path: "src/greet.js", new_string: 'export const GREETING = "hi";' });
  });

  test("a shell failure lands as `error` with the reason in the output", () => {
    const failed = replay()[2]!;
    expect(failed.status).toBe("error");
    expect(failed.output).toContain("No such file or directory");
    expect(failed.output).toContain("Command exited with code 1");
  });

  test("titles are intent strings — never a tool name to classify on", () => {
    const [read, ok, , edit] = replay();
    expect(read!.title).toBe("reading greet file");
    expect(edit!.title).toBe("changing greeting to hi");
    expect(ok!.title).toBe("$ ls -1 src");
  });

  test("locations are absolute, and absent for shell calls", () => {
    const [read, ok, failed, edit] = replay();
    expect(read!.locations).toEqual(["/w/src/greet.js"]);
    expect(edit!.locations).toEqual(["/w/src/greet.js"]);
    expect(ok!.locations).toEqual([]);
    expect(failed!.locations).toEqual([]);
  });

  test("a pending shell call reports no output, only its terminal update does", () => {
    // omp puts the command echo in `content` on the pending call. Reading it as
    // output would show the input in the output slot of every running command.
    const t = new ToolCallTracker();
    const pending = (capture as Record<string, unknown>[]).find(
      (u) => u.sessionUpdate === "tool_call" && u.kind === "execute"
    )!;
    expect(t.start(pending)!.output).toBeNull();
  });

  test("the read's output is the file body, not its metadata", () => {
    expect(replay()[0]!.output).toBe(
      'export const GREETING = "hello";\nexport function greet(name) {\n  return `${GREETING} ${name}`;\n}'
    );
  });
});

describe("summarizeToolOutput", () => {
  test("prefers the error message, then content, then details", () => {
    expect(summarizeToolOutput({ errorMessage: "boom", content: "body", details: { a: 1 } }))
      .toBe("boom\nbody");
    expect(summarizeToolOutput({ content: [{ type: "text", text: "body" }], details: { a: 1 } }))
      .toBe("body");
    expect(summarizeToolOutput({ content: [], details: { exitCode: 2 } })).toBe('{"exitCode":2}');
  });

  test("falls back to the ACP content blocks when rawOutput is absent", () => {
    expect(summarizeToolOutput(undefined, [{ type: "content", content: { type: "text", text: "hi" } }]))
      .toBe("hi");
    expect(summarizeToolOutput(undefined, [{ type: "diff", path: "/w/a.ts" }])).toBe("[diff /w/a.ts]");
  });

  test("nothing to say reads as null, not an empty row", () => {
    expect(summarizeToolOutput(undefined)).toBeNull();
    expect(summarizeToolOutput({ content: [], details: null, errorMessage: null })).toBeNull();
  });

  test("bounds the output and says that it did", () => {
    const out = summarizeToolOutput({ content: "x".repeat(50_000) })!;
    expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT + 100);
    expect(out).toContain("truncated, 50000 chars total");
  });
});

describe("subagent progress extraction", () => {
  // The shape omp actually streams: `details.progress[]` on a wait call's
  // partial results, one entry per dispatched subagent (session 0c40c014).
  const snapshot = {
    content: [{ type: "text", text: "Running agent AuditPR1..." }],
    details: {
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 61_000,
      progress: [
        {
          index: 0, id: "AuditPR1", agent: "reviewer", agentSource: "bundled",
          status: "running", task: "Attack local://plan-pr1…",
          currentTool: "read", currentToolArgs: "local://plan-pr1-worker-reliability.md",
          lastIntent: "reading the plan", recentTools: [{ tool: "read", args: "local://plan-pr1…", endMs: 1 }],
          toolCount: 4, requests: 2, tokens: 900, cost: 0.02, durationMs: 61_000,
        },
        {
          index: 1, id: "AuditPR2", agent: "reviewer", status: "pending",
          task: "Attack local://plan-pr2…", toolCount: 0, requests: 0, tokens: 0, cost: 0,
          durationMs: 0,
        },
      ],
    },
  };

  test("pulls the roster out of rawOutput.details.progress", () => {
    const subs = subagentsOf(snapshot)!;
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      id: "AuditPR1", agent: "reviewer", status: "running", task: "Attack local://plan-pr1…",
      currentTool: "read", lastIntent: "reading the plan", toolCount: 4, tokens: 900,
      cost: 0.02, durationMs: 61_000,
    });
    expect(subs[0].recentTools).toEqual([{ tool: "read", args: "local://plan-pr1…" }]);
    expect(subs[1]).toMatchObject({ id: "AuditPR2", status: "pending" });
  });

  test("ordinary tool output yields undefined, not an empty roster", () => {
    expect(subagentsOf({ content: "12 pass", details: null })).toBeUndefined();
    expect(subagentsOf({ details: { progress: [] } })).toBeUndefined();
    expect(subagentsOf(undefined)).toBeUndefined();
    expect(subagentsOf({ details: { progress: [{ agent: "reviewer" }] } })).toBeUndefined();
  });

  test("the tracker carries snapshots on the call, later ones replacing earlier whole", () => {
    const t = new ToolCallTracker();
    t.start(
      {
        sessionUpdate: "tool_call", toolCallId: "wait-1", title: "Wait for plan audits",
        kind: "other", status: "in_progress", rawInput: { op: "wait", timeoutMs: 600000 },
      },
      1_000
    );
    const mid = t.update({ toolCallId: "wait-1", status: "in_progress", rawOutput: snapshot }, 2_000)!;
    expect(mid.call.subs).toHaveLength(2);
    // An update without a snapshot leaves the previous one standing.
    const quiet = t.update({ toolCallId: "wait-1", status: "in_progress" }, 3_000)!;
    expect(quiet.call.subs).toHaveLength(2);
    // A new snapshot replaces whole — the dropped subagent is gone.
    const next = t.update(
      {
        toolCallId: "wait-1", status: "in_progress",
        rawOutput: { details: { progress: [{ id: "AuditPR1", agent: "reviewer", status: "completed", task: "", toolCount: 9, tokens: 4000, cost: 0.1, durationMs: 120_000 }] } },
      },
      4_000
    )!;
    expect(next.call.subs).toEqual([
      expect.objectContaining({ id: "AuditPR1", status: "completed" }),
    ]);
  });

  test("the supervisor's evidence line tallies a fan-out", () => {
    // Via the rendered evidence rather than the internal helper: this is the
    // line the judge actually reads.
    const { evidenceFromEvents, renderEvidence } = require("../supervisor") as {
      evidenceFromEvents: (events: unknown[]) => { t: string; detail?: string }[];
      renderEvidence: (e: { t: string; detail?: string }[]) => string;
    };
    const line = evidenceFromEvents([
      {
        seq: 1, ts: 1, type: "tool",
        call: {
          id: "w", kind: "other", title: "Wait for plan audits", status: "ok",
          input: { op: "wait" }, locations: [], output: null,
          startedAt: 0, endedAt: 600_000,
          subs: [
            { id: "AuditPR1", agent: "reviewer", status: "completed", task: "", toolCount: 9, tokens: 4000, cost: 0.1, durationMs: 120_000 },
            { id: "AuditPR2", agent: "reviewer", status: "running", task: "", toolCount: 2, tokens: 500, cost: 0.01, durationMs: 30_000 },
            { id: "AuditPR3", agent: "reviewer", status: "failed", task: "", toolCount: 1, tokens: 100, cost: 0.001, durationMs: 5_000 },
          ],
        },
      },
    ]);
    expect(line).toHaveLength(1);
    expect(renderEvidence(line)).toContain("3 subagents");
    expect(renderEvidence(line)).toContain("1 failed (AuditPR3)");
  });
});

describe("parseAdvisories", () => {
  test("pulls advisor notes out of a user chunk", () => {
    const found = parseAdvisories(
      'chatter <advisory severity="blocker">You deleted the tests.</advisory> more ' +
        "<advisory severity='nit'>Name it better.</advisory>"
    );
    expect(found).toEqual([
      { severity: "blocker", text: "You deleted the tests." },
      { severity: "nit", text: "Name it better." },
    ]);
  });

  test("an unknown severity is a concern, not a crash", () => {
    expect(parseAdvisories('<advisory severity="apocalyptic">hm</advisory>')).toEqual([
      { severity: "concern", text: "hm" },
    ]);
    expect(parseAdvisories("<advisory>hm</advisory>")).toEqual([{ severity: "concern", text: "hm" }]);
  });

  test("ordinary user text yields nothing", () => {
    expect(parseAdvisories("please also update the README")).toEqual([]);
    expect(parseAdvisories('<advisory severity="nit">   </advisory>')).toEqual([]);
  });
});
