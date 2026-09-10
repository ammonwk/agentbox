import { describe, expect, test } from "bun:test";
import type { Attention, Session, ToolCall, ToolStatus, TranscriptEvent } from "../../../../src/core/types";
import { isPinnedToBottom, shouldAutoScroll, distanceFromBottom, isAtTop, anchoredScrollTop } from "./scroll";
import {
  activityEmptyReason, collapseRun, failedPromptSeqs, groupEvents, queuedPromptSeqs, rosterCounts, runSummary,
  subagentDetail, subagentRoster, type ToolEntry,
} from "./transcript";
import type { SessionRow } from "../../api";
import { neighbourId, sectionsFor, sortSessions } from "./list";
import { callDurationMs, canResume, canSteer, prBaseOf, splitPRRefs, steerPlaceholder, subagentCallOf, subagentStepLabel, toolSummary } from "./format";
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
    hostPid: null,
    permission: null,
    pid: null,
    prNumber: null,
    repoFullName: null,
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    subs: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    closedAt: null,
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

describe("load-older on scroll", () => {
  test("near the top counts as at the top", () => {
    expect(isAtTop({ scrollTop: 0, scrollHeight: 5000, clientHeight: 400 })).toBe(true);
    expect(isAtTop({ scrollTop: 100, scrollHeight: 5000, clientHeight: 400 })).toBe(true);
    expect(isAtTop({ scrollTop: 300, scrollHeight: 5000, clientHeight: 400 })).toBe(false);
    // The slack is overridable, like the bottom's.
    expect(isAtTop({ scrollTop: 100, scrollHeight: 5000, clientHeight: 400 }, 10)).toBe(false);
  });

  test("prepending history keeps the viewport anchored on the same content", () => {
    // 2000px of content, reader 300px from the top; 1500px of older events
    // land above. The same rows must stay under the viewport.
    const prev = { scrollTop: 300, scrollHeight: 2000 };
    expect(anchoredScrollTop(prev, { scrollHeight: 3500 })).toBe(1800);
  });

  test("anchoring is exact when the reader sits at the very top", () => {
    const prev = { scrollTop: 0, scrollHeight: 2000 };
    expect(anchoredScrollTop(prev, { scrollHeight: 4000 })).toBe(2000);
    // ...which puts the new head exactly where the old head was, so the next
    // scroll-up reaches the next page rather than re-reading this one.
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

  test("sections bucket by attention then activity, and never show closed", () => {
    const list = [
      session({ id: "needs", attention: { kind: "flagged", rank: 1, label: "halted" } }),
      session({ id: "busy", attention: none, status: "running" }),
      // Observed live: every finished session carries `idle`, so bucketing it
      // as "Needs you" put all three real sessions under that heading.
      session({ id: "resting", attention: { kind: "idle", rank: 5, label: "waiting for you" } }),
      session({ id: "idle", attention: none, status: "done" }),
      session({ id: "gone", attention: none, status: "done", closedAt: 5 }),
    ];
    expect(sectionsFor(list).map((s) => [s.id, s.sessions.map((x) => x.id)])).toEqual([
      ["attention", ["needs"]],
      ["working", ["busy"]],
      ["idle", ["resting"]],
      ["quiet", ["idle"]],
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

  test("PR references split out of plain text; single digits stay prose", () => {
    expect(prBaseOf("widget-dev/widget-platform")).toBe("https://github.com/widget-dev/widget-platform/pull/");
    expect(prBaseOf(null)).toBeNull();
    expect(splitPRRefs("Target PR #4144, then #4125 failed. See #7 later.")).toEqual([
      { text: "Target PR ", pr: null },
      { text: "#4144", pr: 4144 },
      { text: ", then ", pr: null },
      { text: "#4125", pr: 4125 },
      { text: " failed. See #7 later.", pr: null },
    ]);
    expect(splitPRRefs("no refs here")).toEqual([{ text: "no refs here", pr: null }]);
  });

  test("the steer placeholder distinguishes next-step from immediate delivery", () => {
    expect(steerPlaceholder("running")).toContain("after its current step");
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

  test("a closed session resumes whatever its status says", () => {
    // Closing a `done` session keeps `done` — the PR really is open — so
    // status alone would hide the button on a session the server would have
    // happily resumed. This must agree with `canResume` in sessions.ts.
    for (const status of ["done", "dead", "waiting"] as const) {
      expect(canResume(session({ id: "x", attention: none, status, closedAt: 123 }))).toBe(true);
    }
  });

  test("tool summaries handle the shapes a live omp run actually produced", () => {
    // Captured from session 62b6cf7e on 4499: 13 real calls. Titles are intent
    // strings or rendered commands, never tool names.
    const run = call("1", "ok", {
      kind: "execute",
      title: "$ node test.js",
      input: { command: "node test.js" },
      locations: [],
    });
    // The title already reads "$ node test.js" — repeating it is noise.
    expect(toolSummary(run)).toBeNull();

    const read = call("2", "ok", {
      kind: "read",
      title: "read package.json",
      input: { path: "./package.json" },
      locations: ["/tmp/wt/package.json"],
    });
    expect(toolSummary(read)).toBe("./package.json");

    // `search` arrived carrying a path, not a pattern — the original guess
    // list would have returned null and dropped the only useful detail.
    const search = call("3", "ok", {
      kind: "search",
      title: "list repo files",
      input: { path: "." },
      locations: ["/tmp/wt"],
    });
    expect(toolSummary(search)).toBe(".");

    const edit = call("4", "ok", {
      kind: "edit",
      title: "add JSDoc to greet function",
      input: { path: "./greet.js", old_string: "function greet", new_string: "/** … */\nfunction greet" },
      locations: ["/tmp/wt/greet.js"],
    });
    expect(toolSummary(edit)).toBe("./greet.js");
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

// -------------------------------------------------------------- subagents

/** Shapes captured from a live omp fan-out (session 0c40c014). */
describe("subagent call classification", () => {
  test("a dispatch carries a tasks array", () => {
    const dispatch = call("1", "ok", {
      kind: "other",
      title: "Audit PR1 worker reliability plan",
      input: {
        context: "You are adversarially auditing…",
        tasks: [
          { name: "AuditPR1", agent: "reviewer", task: "Attack local://plan-pr1…" },
          { name: "AuditPR2", agent: "reviewer", task: "Attack local://plan-pr2…" },
        ],
      },
    });
    expect(subagentCallOf(dispatch)).toEqual({
      kind: "dispatch",
      tasks: [
        { name: "AuditPR1", agent: "reviewer", task: "Attack local://plan-pr1…" },
        { name: "AuditPR2", agent: "reviewer", task: "Attack local://plan-pr2…" },
      ],
    });
  });

  test("a wait is the op, and may carry a DM to one subagent", () => {
    expect(subagentCallOf(call("1", "ok", { kind: "other", input: { op: "wait", timeoutMs: 600000 } }))).toEqual({
      kind: "wait", to: null, message: null,
    });
    expect(
      subagentCallOf(call("2", "ok", {
        kind: "other",
        input: { op: "wait", timeoutMs: 600000, to: "Batch09", message: "send the findings array" },
      })),
    ).toEqual({ kind: "wait", to: "Batch09", message: "send the findings array" });
  });

  test("a collect is an agent:// read, query strings stripped", () => {
    expect(subagentCallOf(call("1", "ok", { kind: "read", input: { path: "agent://Batch10" } }))).toEqual({
      kind: "collect", name: "Batch10",
    });
    expect(subagentCallOf(call("2", "ok", { kind: "read", input: { path: "agent://Batch7?q=summary" } }))).toEqual({
      kind: "collect", name: "Batch7",
    });
  });

  test("ordinary calls classify as nothing", () => {
    expect(subagentCallOf(call("1", "ok", { kind: "execute", input: { command: "ls" } }))).toBeNull();
    expect(subagentCallOf(call("2", "ok", { kind: "read", input: { path: "apps/api/src/x.ts" } }))).toBeNull();
    expect(subagentCallOf(call("3", "ok", { kind: "other", input: { op: "done", phase: "Recon" } }))).toBeNull();
    expect(subagentCallOf(call("4", "ok", { kind: "other", input: { context: "no tasks key" } }))).toBeNull();
    expect(subagentCallOf(call("5", "ok", { kind: "other", input: { tasks: [] } }))).toBeNull();
  });
});

describe("subagent roster", () => {
  const dispatch: TranscriptEvent = {
    seq: 1, ts: 100, type: "tool",
    call: call("d", "ok", {
      kind: "other",
      input: {
        tasks: [
          { name: "AuditPR1", agent: "reviewer", task: "Attack plan 1" },
          { name: "AuditPR2", agent: "reviewer", task: "Attack plan 2" },
        ],
      },
    }),
  };
  const snapshot = (seq: number, ts: number, id: string, status: string, durationMs: number): TranscriptEvent => ({
    seq, ts, type: "tool",
    call: call(`w${seq}`, "running", {
      kind: "other",
      input: { op: "wait", timeoutMs: 600000 },
      endedAt: null,
      subs: [{ id, agent: "reviewer", status: status as "running", task: "", toolCount: 4, tokens: 900, cost: 0.02, durationMs }],
    }),
  });

  test("dispatches name the roster; snapshots update it; later events win", () => {
    const roster = subagentRoster([
      dispatch,
      snapshot(2, 200, "AuditPR1", "running", 60_000),
      snapshot(3, 300, "AuditPR1", "completed", 120_000),
      { seq: 4, ts: 400, type: "tool", call: call("c", "ok", { kind: "read", input: { path: "agent://AuditPR1" } }) },
    ]);
    expect(roster.map((e) => e.name)).toEqual(["AuditPR1", "AuditPR2"]);
    expect(roster[0]).toMatchObject({
      status: "completed", durationMs: 120_000, toolCount: 4, collected: true, agent: "reviewer",
    });
    expect(roster[1]).toMatchObject({ status: "pending", collected: false, task: "Attack plan 2" });
    // `pending` is "dispatched, nothing heard" — not counted as running.
    expect(rosterCounts(roster)).toEqual({ total: 2, running: 0, failed: 0, done: 1 });
  });

  test("a failed subagent shows in the counts", () => {
    const roster = subagentRoster([
      dispatch,
      snapshot(2, 200, "AuditPR1", "failed", 5_000),
      snapshot(3, 300, "AuditPR2", "running", 60_000),
    ]);
    expect(rosterCounts(roster)).toEqual({ total: 2, running: 1, failed: 1, done: 0 });
  });
});

describe("subagent drilldown", () => {
  const dispatch: TranscriptEvent = {
    seq: 1, ts: 100, type: "tool",
    call: call("d", "ok", {
      kind: "other",
      input: {
        tasks: [
          { name: "AuditPR1", agent: "reviewer", task: "Attack plan 1" },
          { name: "AuditPR2", agent: "reviewer", task: "Attack plan 2" },
        ],
      },
    }),
  };
  const snap = (
    seq: number,
    ts: number,
    id: string,
    toolCount: number,
    recentTools: string[],
    status = "running",
  ): TranscriptEvent => ({
    seq, ts, type: "tool",
    call: call(`w${seq}`, "running", {
      kind: "other",
      input: { op: "wait", timeoutMs: 600000 },
      endedAt: null,
      subs: [{
        id, agent: "reviewer", status: status as "running", task: "",
        toolCount, tokens: 900, cost: 0.02, durationMs: ts - 100,
        recentTools: recentTools.map((tool) => ({ tool })),
      }],
    }),
  });

  test("rebuilds the tool timeline from snapshot deltas, oldest first", () => {
    const detail = subagentDetail([
      dispatch,
      snap(2, 200, "AuditPR1", 2, ["Grep", "Read"]),
      snap(3, 300, "AuditPR1", 4, ["Edit", "Bash", "Grep", "Read"]),
    ], "AuditPR1")!;
    expect(detail.status).toBe("running");
    expect(detail.task).toBe("Attack plan 1");
    expect(detail.toolCount).toBe(4);
    expect(detail.steps.map((s) => s.tool)).toEqual(["Read", "Grep", "Bash", "Edit"]);
    expect(detail.steps[0].ts).toBe(200);
    expect(detail.steps[3].ts).toBe(300);
  });

  test("an interleaved stale snapshot does not double-count tools", () => {
    const detail = subagentDetail([
      dispatch,
      snap(2, 200, "AuditPR1", 2, ["Grep", "Read"]),
      snap(3, 250, "AuditPR1", 4, ["Edit", "Bash", "Grep", "Read"]),
      // A second parent call still streaming an older view of the same sub.
      snap(4, 260, "AuditPR1", 2, ["Grep", "Read"]),
    ], "AuditPR1")!;
    expect(detail.steps.map((s) => s.tool)).toEqual(["Read", "Grep", "Bash", "Edit"]);
    expect(detail.toolCount).toBe(4);
  });

  test("the collect call's output is the result", () => {
    const detail = subagentDetail([
      dispatch,
      snap(2, 200, "AuditPR1", 1, ["Read"], "completed"),
      {
        seq: 3, ts: 300, type: "tool",
        call: call("c", "ok", { kind: "read", input: { path: "agent://AuditPR1" }, output: "3 findings, 1 blocker" }),
      },
    ], "AuditPR1")!;
    expect(detail.result).toBe("3 findings, 1 blocker");
    expect(detail.resultError).toBe(false);
    expect(detail.status).toBe("completed");
  });

  test("an unknown name has no detail", () => {
    expect(subagentDetail([dispatch], "Nobody")).toBeNull();
  });
});

describe("folding keeps subagent structure visible", () => {
  test("a dispatch in the middle of a long run is never folded away", () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(String(i + 1)));
    const withDispatch = [...entries];
    withDispatch[6] = {
      seq: 7, ts: 70,
      call: call("7", "ok", { kind: "other", input: { tasks: [{ name: "A", agent: "scout", task: "t" }] } }),
    };
    const { visible } = collapseRun(withDispatch);
    expect(visible.map((v) => v.entry.seq)).toContain(7);
  });
});

describe("subagentStepLabel", () => {
  test("a hub step with no reported arguments says what the tool is for", () => {
    expect(subagentStepLabel({ tool: "hub", args: "" })).toBe("hub — background jobs");
    expect(subagentStepLabel({ tool: "hub", args: null })).toBe("hub — background jobs");
  });

  test("everything else passes through untouched", () => {
    expect(subagentStepLabel({ tool: "bash", args: "git status" })).toBe("bash");
    expect(subagentStepLabel({ tool: "hub", args: '{"op":"wait"}' })).toBe("hub");
  });
});

describe("failedPromptSeqs", () => {
  const user = (seq: number, text: string, from: "human" | "auto" = "human"): TranscriptEvent =>
    ({ seq, ts: seq * 10, type: "user", text, from });
  const assistant = (seq: number, text: string): TranscriptEvent =>
    ({ seq, ts: seq * 10, type: "assistant", text });
  const turn = (seq: number, stopReason: string): TranscriptEvent =>
    ({ seq, ts: seq * 10, type: "turn", stopReason });
  const error = (seq: number, message: string): TranscriptEvent =>
    ({ seq, ts: seq * 10, type: "error", message });

  test("a prompt the provider ate with a 404-as-completion is retriable", () => {
    const failed = failedPromptSeqs([
      user(1, "Do it"),
      assistant(2, "404 Thank you for participating in the Stealth Ox Alpha testing period."),
      turn(3, "end_turn"),
    ]);
    expect(failed.has(1)).toBe(true);
  });

  test("a turn that ended error is retriable", () => {
    const failed = failedPromptSeqs([user(1, "Do it"), turn(2, "error")]);
    expect(failed.has(1)).toBe(true);
  });

  test("a stderr error before any work marks the prompt retriable", () => {
    const failed = failedPromptSeqs([user(1, "Do it"), error(2, "provider unreachable"), turn(3, "end_turn")]);
    expect(failed.has(1)).toBe(true);
  });

  test("a answered prompt is not retriable, even with a later stray error", () => {
    const failed = failedPromptSeqs([
      user(1, "Do it"),
      assistant(2, "Done — all checks green."),
      turn(3, "end_turn"),
      error(4, "stderr noise after the fact"),
    ]);
    expect(failed.size).toBe(0);
  });

  test("a prompt the agent actually worked on is not retriable", () => {
    const failed = failedPromptSeqs([
      user(1, "Do it"),
      { seq: 2, ts: 20, type: "tool", call: call("2") },
      assistant(3, "Halfway there."),
      turn(4, "end_turn"),
    ]);
    expect(failed.size).toBe(0);
  });

  test("the span closes at the next prompt, of any kind", () => {
    const failed = failedPromptSeqs([
      user(1, "Do it"),
      turn(2, "end_turn"),
      user(3, "Continue", "auto"),
      assistant(4, "Done."),
      turn(5, "end_turn"),
    ]);
    expect(failed.size).toBe(0);
  });
});

describe("queuedPromptSeqs", () => {
  const user = (seq: number, queued?: boolean): TranscriptEvent =>
    ({ seq, ts: seq * 10, type: "user", text: `m${seq}`, from: "human", ...(queued ? { queued } : {}) });
  const delivered = (seq: number, refs: number[]): TranscriptEvent =>
    ({ seq, ts: seq * 10, type: "delivered", refs });

  test("a message sent mid-turn reads as queued until the agent has it", () => {
    expect([...queuedPromptSeqs([user(1, true), user(2, true)])]).toEqual([1, 2]);
    expect([...queuedPromptSeqs([user(1, true), user(2, true), delivered(3, [1])])]).toEqual([2]);
    expect(queuedPromptSeqs([user(1, true), user(2, true), delivered(3, [1, 2])]).size).toBe(0);
  });

  test("a message delivered on the spot was never queued", () => {
    expect(queuedPromptSeqs([user(1)]).size).toBe(0);
  });

  test("a delivery landing inside a tool run does not split it", () => {
    const rows = groupEvents([toolEvent(1), delivered(2, [0]), toolEvent(3)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("toolRun");
  });
});
