import { describe, expect, test } from "bun:test";
import type { Attention, Session, ToolCall, ToolStatus, TranscriptEvent } from "../../../../src/core/types";
import { isPinnedToBottom, shouldAutoScroll, distanceFromBottom } from "./scroll";
import { activityEmptyReason, collapseRun, groupEvents, runSummary, type ToolEntry } from "./transcript";
import type { SessionRow } from "../../api";
import { neighbourId, sectionsFor, sortSessions } from "./list";
import { callDurationMs, canResume, canSteer, steerPlaceholder, toolSummary } from "./format";
import { looksTruncated, parsePatch, patchStats } from "./diff";

// ------------------------------------------------------------- fixtures

function call(id: string, status: ToolStatus = "ok", over: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    kind: "execute",
    title: `call ${id}`,
    input: { command: "ls" },
    status,
    locations: [],
    output: null,
    startedAt: 0,
    endedAt: 1000,
    ...over,
  };
}

function entry(id: string, status: ToolStatus = "ok"): ToolEntry {
  return { seq: Number(id), ts: Number(id) * 10, call: call(id, status) };
}

function toolEvent(seq: number, status: ToolStatus = "ok"): TranscriptEvent {
  return { seq, ts: seq * 10, type: "tool", call: call(String(seq), status) };
}

function session(over: Partial<SessionRow> & { id: string; attention: Attention }): SessionRow {
  const base: Session = {
    id: over.id,
    title: over.id,
    prompt: "do the thing",
    status: "waiting",
    repo: "/tmp/repo",
    branch: "ab-1",
    worktree: "/tmp/wt",
    model: "deepseek/chat",
    followUps: 0,
    lastMessage: null,
    toolCalls: 0,
    exitCode: null,
    pid: null,
    prNumber: null,
    repoFullName: null,
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    archivedAt: null,
  };
  return { ...base, ...over };
}

const none: Attention = { kind: "none", rank: 99, label: "" };

// ------------------------------------------------------------ auto-scroll

describe("auto-scroll pinning", () => {
  test("a reader at the bottom is pinned; one scrolled up is not", () => {
    expect(isPinnedToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  test("within the slack still counts as the bottom", () => {
    const box = { scrollTop: 870, scrollHeight: 1000, clientHeight: 100 };
    expect(distanceFromBottom(box)).toBe(30);
    expect(isPinnedToBottom(box)).toBe(true);
    expect(isPinnedToBottom(box, 10)).toBe(false);
  });

  test("content shorter than the viewport is pinned, not 'scrolled up'", () => {
    // The regression this guards: an empty/short transcript reads as
    // distance 0 only because of the clamp — but scrollHeight < clientHeight
    // must never be interpreted as the reader having scrolled away.
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 40, clientHeight: 500 })).toBe(true);
  });

  test("only follows the tail when the reader was already at it", () => {
    expect(shouldAutoScroll({ wasPinned: true, grew: true, initial: false })).toBe(true);
    // The case that matters: someone reading history must not be yanked.
    expect(shouldAutoScroll({ wasPinned: false, grew: true, initial: false })).toBe(false);
    // No new content: never move the viewport, pinned or not.
    expect(shouldAutoScroll({ wasPinned: true, grew: false, initial: false })).toBe(false);
    // Switching sessions lands at the tail even though nothing "grew".
    expect(shouldAutoScroll({ wasPinned: false, grew: false, initial: true })).toBe(true);
  });
});

// -------------------------------------------------------------- grouping

describe("grouping consecutive tool events", () => {
  test("consecutive tool events become one run, other events break it", () => {
    const rows = groupEvents([
      { seq: 1, ts: 1, type: "assistant", text: "starting" },
      toolEvent(2),
      toolEvent(3),
      { seq: 4, ts: 4, type: "assistant", text: "done reading" },
      toolEvent(5),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["prose", "toolRun", "prose", "toolRun"]);
    const first = rows[1];
    if (first.kind !== "toolRun") throw new Error("expected a run");
    expect(first.entries.map((e) => e.seq)).toEqual([2, 3]);
  });

  test("a call streamed as call+update is one row, holding the newest state", () => {
    // Whether the server rewrites the event or appends a second one at a new
    // seq, the screen must show one row per tool call — not pending-then-done.
    const rows = groupEvents([
      { seq: 1, ts: 1, type: "tool", call: call("a", "running", { endedAt: null }) },
      { seq: 2, ts: 2, type: "tool", call: call("b", "running", { endedAt: null }) },
      { seq: 3, ts: 3, type: "tool", call: call("a", "error") },
    ]);
    expect(rows.length).toBe(1);
    const run = rows[0];
    if (run.kind !== "toolRun") throw new Error("expected a run");
    // Start order is kept (a before b) and the outcome is the latest one.
    expect(run.entries.map((e) => [e.call.id, e.call.status])).toEqual([
      ["a", "error"],
      ["b", "running"],
    ]);
  });

  test("an update arriving after prose does not open a second run", () => {
    const rows = groupEvents([
      { seq: 1, ts: 1, type: "tool", call: call("a", "running", { endedAt: null }) },
      { seq: 2, ts: 2, type: "assistant", text: "while that runs…" },
      { seq: 3, ts: 3, type: "tool", call: call("a", "ok") },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["toolRun", "prose"]);
  });

  test("consecutive assistant deltas are one block, joined with no separator", () => {
    // The live bug: the engine coalesces deltas on a ~200ms timer that cuts at
    // byte offsets, so "committed" arrived split across two events and
    // rendered as two paragraphs mid-sentence.
    const rows = groupEvents([
      { seq: 37, ts: 37, type: "assistant", text: "untouched.\n\nNot com" },
      { seq: 38, ts: 38, type: "assistant", text: "mitted, not pushed." },
    ]);
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row.kind !== "prose") throw new Error("expected prose");
    expect(row.text).toBe("untouched.\n\nNot committed, not pushed.");
    // First seq owns the key so a growing message keeps its React identity;
    // last ts, because that is when the message was last touched.
    expect(row.key).toBe("p-37");
    expect(row.seq).toBe(37);
    expect(row.ts).toBe(38);
  });

  test("a growing message keeps its key as deltas arrive", () => {
    const first = groupEvents([{ seq: 1, ts: 1, type: "assistant", text: "Loo" }]);
    const later = groupEvents([
      { seq: 1, ts: 1, type: "assistant", text: "Loo" },
      { seq: 2, ts: 2, type: "assistant", text: "king at it." },
    ]);
    expect(first[0].key).toBe(later[0].key);
    expect(later.length).toBe(1);
  });

  test("a tool call between messages breaks prose; a folded update does not", () => {
    const rows = groupEvents([
      { seq: 1, ts: 1, type: "assistant", text: "first" },
      { seq: 2, ts: 2, type: "tool", call: call("a", "running", { endedAt: null }) },
      { seq: 3, ts: 3, type: "assistant", text: "second" },
      // The update for call "a" is folded away, so it interrupts nothing.
      { seq: 4, ts: 4, type: "tool", call: call("a", "ok") },
      { seq: 5, ts: 5, type: "assistant", text: " continues" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["prose", "toolRun", "prose"]);
    const tail = rows[2];
    if (tail.kind !== "prose") throw new Error("expected prose");
    expect(tail.text).toBe("second continues");
  });

  test("a turn boundary ends the message", () => {
    const rows = groupEvents([
      { seq: 1, ts: 1, type: "assistant", text: "done" },
      { seq: 2, ts: 2, type: "turn", stopReason: "end_turn" },
      { seq: 3, ts: 3, type: "assistant", text: "next turn" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["prose", "event", "prose"]);
  });

  test("keys are stable and unique so React does not remount rows", () => {
    const rows = groupEvents([toolEvent(1), { seq: 2, ts: 2, type: "turn", stopReason: "end_turn" }, toolEvent(3)]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("collapsing a long run", () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(String(i + 1)));

  test("short runs are untouched", () => {
    const short = entries.slice(0, 5);
    const { visible, hiddenCount } = collapseRun(short);
    expect(hiddenCount).toBe(0);
    expect(visible.map((v) => v.entry)).toEqual(short);
    expect(visible.every((v) => v.hiddenBefore === 0)).toBe(true);
  });

  test("long runs keep the head and tail and fold the middle", () => {
    const { visible, hiddenCount } = collapseRun(entries);
    expect(visible.map((v) => v.entry.seq)).toEqual([1, 2, 10, 11, 12]);
    expect(hiddenCount).toBe(7);
    expect(visible.length + hiddenCount).toBe(entries.length);
    // The fold marker lands where the gap actually is.
    expect(visible.map((v) => v.hiddenBefore)).toEqual([0, 0, 7, 0, 0]);
  });

  test("an error in the middle is never folded away", () => {
    const withError = [...entries];
    withError[6] = entry("7", "error");
    const { visible, hiddenCount } = collapseRun(withError);
    expect(visible.map((v) => v.entry.seq)).toEqual([1, 2, 7, 10, 11, 12]);
    expect(hiddenCount).toBe(6);
    // Two separate gaps, each counted where it occurs.
    expect(visible.map((v) => v.hiddenBefore)).toEqual([0, 0, 4, 2, 0, 0]);
  });

  test("run summary counts outcomes", () => {
    expect(runSummary([entry("1"), entry("2", "error"), entry("3", "running")])).toEqual({
      total: 3,
      errors: 1,
      running: 1,
    });
  });
});

// ------------------------------------------------------------------ list

describe("list ordering", () => {
  test("attention rank wins, recency breaks ties", () => {
    const list = [
      session({ id: "old-urgent", attention: { kind: "approval", rank: 0, label: "" }, updatedAt: 1 }),
      session({ id: "fresh-calm", attention: none, updatedAt: 500 }),
      session({ id: "new-urgent", attention: { kind: "approval", rank: 0, label: "" }, updatedAt: 400 }),
    ];
    expect(sortSessions(list).map((s) => s.id)).toEqual(["new-urgent", "old-urgent", "fresh-calm"]);
  });

  test("sections bucket by attention then activity, and hide archived by default", () => {
    const list = [
      session({ id: "needs", attention: { kind: "flagged", rank: 1, label: "halted" } }),
      session({ id: "busy", attention: none, status: "running" }),
      session({ id: "idle", attention: none, status: "done" }),
      session({ id: "gone", attention: none, status: "done", archivedAt: 5 }),
    ];
    expect(sectionsFor(list, false).map((s) => [s.id, s.sessions.map((x) => x.id)])).toEqual([
      ["attention", ["needs"]],
      ["working", ["busy"]],
      ["quiet", ["idle"]],
    ]);
    expect(sectionsFor(list, true).find((s) => s.id === "quiet")!.sessions.map((s) => s.id)).toEqual([
      "idle",
      "gone",
    ]);
  });

  test("keyboard navigation clamps instead of wrapping", () => {
    const ordered = [session({ id: "a", attention: none }), session({ id: "b", attention: none })];
    expect(neighbourId(ordered, "a", 1)).toBe("b");
    expect(neighbourId(ordered, "b", 1)).toBe("b");
    expect(neighbourId(ordered, "a", -1)).toBe("a");
    // Nothing selected yet: ↓ takes the first row, ↑ the last.
    expect(neighbourId(ordered, null, 1)).toBe("a");
    expect(neighbourId(ordered, null, -1)).toBe("b");
    expect(neighbourId([], null, 1)).toBeNull();
  });
});

describe("why activity is empty", () => {
  test("a disconnected stream never claims the session did nothing", () => {
    expect(activityEmptyReason({ status: "running", toolCalls: 0, lastMessage: null }, false)).toEqual({
      kind: "disconnected",
    });
    // Even with evidence of history, not being subscribed wins: we cannot see.
    expect(activityEmptyReason({ status: "done", toolCalls: 40, lastMessage: "hi" }, false).kind).toBe(
      "disconnected",
    );
  });

  test("history with no events means the log is gone, not 'nothing yet'", () => {
    // A log that exists but does not parse now arrives as an error event from
    // the server, so it never lands here. Zero events plus evidence the
    // session ran means the file itself is missing or unreadable.
    expect(activityEmptyReason({ status: "done", toolCalls: 63, lastMessage: "done." }, true)).toEqual({
      kind: "missing",
      toolCalls: 63,
      hasMessage: true,
    });
    // Either piece of evidence alone is enough; toolCalls is a rework-era field
    // and reads 0 on old rows, so lastMessage has to carry the case on its own.
    expect(activityEmptyReason({ status: "done", toolCalls: 0, lastMessage: "done." }, true).kind).toBe(
      "missing",
    );
    expect(activityEmptyReason({ status: "dead", toolCalls: 12, lastMessage: null }, true).kind).toBe(
      "missing",
    );
  });

  test("a live session with no history is starting, not silent", () => {
    expect(activityEmptyReason({ status: "spawning", toolCalls: 0, lastMessage: null }, true).kind).toBe(
      "starting",
    );
    expect(activityEmptyReason({ status: "running", toolCalls: 0, lastMessage: "" }, true).kind).toBe(
      "starting",
    );
  });

  test("a halted session with no history at all recorded nothing", () => {
    expect(activityEmptyReason({ status: "failed", toolCalls: 0, lastMessage: null }, true).kind).toBe(
      "silent",
    );
  });
});

// ----------------------------------------------------------------- diff

describe("patch parsing", () => {
  const patch = [
    "diff --git a/x.ts b/x.ts",
    "index 111..222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    "",
  ].join("\n");

  test("classifies lines, and does not read the file headers as +/- changes", () => {
    const lines = parsePatch(patch);
    expect(lines.map((l) => l.kind)).toEqual([
      "meta", "meta", "meta", "meta", "hunk", "context", "del", "add", "add",
    ]);
    expect(patchStats(lines)).toEqual({ additions: 2, deletions: 1 });
  });

  test("a patch shorter than the reported counts is flagged as truncated", () => {
    const lines = parsePatch(patch);
    expect(looksTruncated(lines, { additions: 2, deletions: 1 })).toBe(false);
    expect(looksTruncated(lines, { additions: 90, deletions: 1 })).toBe(true);
    expect(looksTruncated(lines, { additions: 2, deletions: 40 })).toBe(true);
  });
});

// --------------------------------------------------------------- format

describe("formatting", () => {
  test("a call still running has no duration yet", () => {
    expect(callDurationMs(call("1", "ok", { startedAt: 1000, endedAt: 4500 }))).toBe(3500);
    expect(callDurationMs(call("2", "running", { startedAt: 1000, endedAt: null }))).toBeNull();
  });

  test("the steer placeholder distinguishes queued from immediate delivery", () => {
    expect(steerPlaceholder("running")).toContain("queued");
    expect(steerPlaceholder("waiting")).toContain("immediately");
  });

  test("all three halted states resume, and say so instead of refusing", () => {
    for (const status of ["flagged", "dead", "failed"] as const) {
      expect(canResume(session({ id: "x", attention: none, status }))).toBe(true);
      expect(canSteer(status)).toBe(false);
      // Not "cannot take messages" — resuming is how you send it one.
      expect(steerPlaceholder(status)).toContain("Resume");
    }
    for (const status of ["running", "waiting", "done", "spawning"] as const) {
      expect(canResume(session({ id: "x", attention: none, status }))).toBe(false);
      expect(canSteer(status)).toBe(true);
    }
  });

  test("tool summaries read the argument shape, since ACP sends no tool name", () => {
    expect(toolSummary(call("1", "ok", { kind: "execute", input: { command: "bun test" } }))).toBe("bun test");
    expect(toolSummary(call("2", "ok", { kind: "search", input: { pattern: "TODO" } }))).toBe("TODO");
    expect(toolSummary(call("3", "ok", { kind: "read", input: {}, locations: ["/a/b.ts"] }))).toBe("/a/b.ts");
    expect(toolSummary(call("4", "ok", { kind: "read", input: { file_path: "/x.ts" }, locations: ["/a/b.ts"] }))).toBe("/x.ts");
    // A blank string is not a summary — fall through rather than render "".
    expect(toolSummary(call("5", "ok", { kind: "execute", input: { command: "  " } }))).toBeNull();
    expect(toolSummary(call("6", "ok", { kind: "think", input: { thought: "hm" } }))).toBeNull();
  });
});
