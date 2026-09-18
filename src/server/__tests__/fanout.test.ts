/** What a browser is told about a session's fan-out.
 *
 * The rule under test is which of the two sources gets believed and when: the
 * session row while a host is writing it, omp's directory the rest of the
 * time. Getting that backwards is what drew a finished fan-out as live.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempHome } from "../../core/__tests__/tmp-home";
import { ompSlugFor } from "../../core/ompsession";
import type { Session, SubagentProgress } from "../../core/types";

let home: ReturnType<typeof useTempHome>;
let ompRoot: string;
let previousOmpHome: string | undefined;
let fanoutOf: typeof import("../fanout").fanoutOf;
let getSession: typeof import("../../core/db").getSession;
let insertSession: typeof import("../../core/db").insertSession;

const OMP_ID = "01a09496-0000-7000-0000-0000000000ff";
const CWD = "/tmp/agentbox-fanout-test/wt";

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1", title: "Take every PR to merge-ready", prompt: "p", status: "waiting",
    repo: "/repo", branch: "b", worktree: CWD, model: "m", followUps: 0, lastMessage: null,
    toolCalls: 3, exitCode: null, pid: null, hostPid: null, permission: null,
    prNumber: null, repoFullName: null, costUsd: null, tokens: null, blocked: false,
    flagReason: null, ompSessionId: OMP_ID, subs: null, createdAt: 1, updatedAt: 5_000,
    startedAt: null, closedAt: null, parkedAt: null, ...patch,
  };
}

/** The roster as the stream left it when the turn ended: still running. */
function midFlight(): SubagentProgress[] {
  return [
    { id: "Gnc5199", agent: "task", status: "running", task: "PR 5199", toolCount: 1,
      tokens: 100, cost: 0, durationMs: 60_000, observedAt: 5_000, source: "stream" },
  ];
}

beforeAll(async () => {
  home = useTempHome();
  previousOmpHome = process.env.AGENTBOX_OMP_HOME;
  ompRoot = mkdtempSync(join(tmpdir(), "agentbox-omp-fanout-"));
  process.env.AGENTBOX_OMP_HOME = ompRoot;

  // omp's record: the subagent finished, hours after the turn ended.
  const dir = join(ompRoot, "agent", "sessions", ompSlugFor(CWD), `2026-09-12T07-48-00-374Z_${OMP_ID}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "Gnc5199.jsonl"),
    [
      JSON.stringify({ type: "session", timestamp: "2026-09-12T07:50:00.000Z" }),
      // Three tool calls and a usage figure, so a deep scan has something to
      // count — the stream below stopped after one.
      JSON.stringify({ type: "custom", customType: "tool_execution_start", data: { toolName: "bash" } }),
      JSON.stringify({ type: "custom", customType: "tool_execution_start", data: { toolName: "bash" } }),
      JSON.stringify({ type: "custom", customType: "tool_execution_start", data: { toolName: "bash" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 9_000 } } }),
      JSON.stringify({
        type: "custom",
        customType: "session_exit",
        data: { reason: "dispose", kind: "normal", recordedAt: "2026-09-12T11:38:44.526Z" },
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(join(dir, "Gnc5199.md"), "PR 5199 is merge-ready.");

  ({ fanoutOf } = await import("../fanout"));
  ({ getSession, insertSession } = await import("../../core/db"));
});

afterAll(() => {
  process.env.AGENTBOX_OMP_HOME = previousOmpHome;
  rmSync(ompRoot, { recursive: true, force: true });
  home.restore();
});

describe("fanoutOf", () => {
  test("closes out a fan-out the stream left mid-flight", () => {
    const s = session({ id: "idle", subs: midFlight() });
    insertSession(s);
    const view = fanoutOf(s, 9_000_000, () => false);
    expect(view.subs[0]).toMatchObject({ id: "Gnc5199", status: "completed", hasResult: true });
    expect(view.recorded).toBe(true);
    expect(view.live).toBe(false);
  });

  test("writes the correction back, because nothing else ever will", () => {
    // A session recorded before any of this existed has a row that will stay
    // wrong forever otherwise: its host is gone and is not coming back.
    const s = session({ id: "repaired", subs: midFlight() });
    insertSession(s);
    fanoutOf(s, 9_000_000, () => false);
    expect(getSession("repaired")!.subs![0]!.status).toBe("completed");
  });

  test("leaves the row alone while a host owns it", () => {
    // Two writers taking turns on one blob is how a live roster would start
    // flickering between the stream's view and the disk's.
    const s = session({ id: "owned", subs: midFlight() });
    insertSession(s);
    const view = fanoutOf(s, 9_000_000, () => true);
    expect(getSession("owned")!.subs![0]!.status).toBe("running");
    // The caller is still told the truth; only the write is withheld.
    expect(view.subs[0]!.status).toBe("completed");
  });

  test("counts the work the stream never saw, even with a host connected", () => {
    // A host sits connected between turns without streaming anything, and
    // deferring to it there is how a roster kept reporting the tool count a
    // subagent had reached when its parent's turn happened to end.
    const s = session({ id: "idlehost", subs: midFlight() });
    insertSession(s);
    const view = fanoutOf(s, 9_000_000, () => true);
    expect(view.subs[0]).toMatchObject({ toolCount: 3, tokens: 9_000 });
  });

  test("a running session's roster is not re-counted from disk", () => {
    // Mid-turn the stream is the fresher source and the scan would be work
    // done on every request for a worse answer.
    const s = session({ id: "midturn", status: "running", subs: midFlight() });
    insertSession(s);
    const view = fanoutOf(s, 9_000_000, () => true);
    expect(view.subs[0]!.toolCount).toBe(1);
  });

  test("does not write when the disk taught it nothing new", () => {
    const s = session({ id: "settled", subs: midFlight() });
    insertSession(s);
    fanoutOf(s, 9_000_000, () => false);
    const settled = getSession("settled")!;
    // Second pass over an already-reconciled row: nothing material changes, so
    // reading it again must not be a write.
    fanoutOf(settled, 9_100_000, () => false);
    expect(getSession("settled")!.subs).toEqual(settled.subs);
  });

  test("a running session with a host has a live roster", () => {
    const s = session({ id: "live", status: "running", subs: midFlight() });
    expect(fanoutOf(s, 9_000_000, () => true).live).toBe(true);
  });

  test("says when omp has no record, instead of implying the roster is final", () => {
    const s = session({ id: "unrecorded", ompSessionId: null, subs: midFlight() });
    const view = fanoutOf(s, 9_000_000, () => false);
    expect(view.recorded).toBe(false);
    expect(view.subs[0]!.status).toBe("running");
    expect(view.ageMs).toBe(9_000_000 - 5_000);
  });

  test("a session that never fanned out has an empty roster", () => {
    const s = session({ id: "plain", subs: null, ompSessionId: null });
    expect(fanoutOf(s, 9_000_000, () => false).subs).toEqual([]);
  });
});
