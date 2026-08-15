import { describe, expect, test } from "bun:test";
import { ATTENTION_RANK, attentionOf } from "../conductor";
import type { PermissionRequest, Session, SessionStatus } from "../types";

const ALL_STATUSES: SessionStatus[] = [
  "spawning", "running", "waiting", "done", "flagged", "failed", "dead",
];

const PERMISSION: PermissionRequest = {
  id: "p1",
  title: "Run `rm -rf build`",
  tool: "execute",
  options: [{ id: "allow", name: "Allow" }],
};

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    title: "Add a health endpoint",
    prompt: "add a health endpoint",
    status: "running",
    repo: "/repo",
    branch: "vk/ab-1",
    worktree: "/wt/s1",
    model: "m",
    followUps: 0,
    lastMessage: null,
    toolCalls: 0,
    exitCode: null,
    hostPid: null,
    permission: null,
    pid: 1,
    prNumber: null,
    repoFullName: "o/r",
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    closedAt: null,
    ...patch,
  };
}

describe("attentionOf", () => {
  test("every status × blocked × permission combination resolves, rank matching kind", () => {
    for (const status of ALL_STATUSES) {
      for (const blocked of [false, true]) {
        for (const permission of [null, PERMISSION]) {
          const a = attentionOf(session({ status, blocked, permission }));
          expect(a.rank).toBe(ATTENTION_RANK[a.kind]);
          expect(a.label.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("a live permission outranks the status underneath it", () => {
    // A session is `running` while the agent waits on a permission prompt: the
    // prompt is what needs a human, not the run.
    for (const status of ALL_STATUSES) {
      expect(attentionOf(session({ status, blocked: true, permission: PERMISSION })).kind).toBe("approval");
    }
  });

  test("a blocked flag with no live permission does not offer a dead button", () => {
    // `blocked` persists; the ACP connection that would receive the answer does
    // not. Approve/Deny could only fail, so the human gets the action that works
    // for the status instead.
    //
    // The engine's `reconcile()` clears `blocked` at boot, so in practice this
    // state should not survive to a broadcast — `waiting` is what a
    // restart-blocked session actually presents as, since `onPermission` sets
    // that status. This pins the behaviour for the case where the guard is the
    // only thing standing between a human and a button that cannot work.
    expect(attentionOf(session({ status: "waiting", blocked: true, permission: null })).kind).toBe("idle");
    expect(attentionOf(session({ status: "dead", blocked: true, permission: null })).kind).toBe("failed");
    expect(attentionOf(session({ status: "flagged", blocked: true, permission: null })).kind).toBe("flagged");
  });

  test("approval is the most urgent thing there is", () => {
    const ranks = ALL_STATUSES.map((status) => attentionOf(session({ status })).rank);
    const approval = attentionOf(session({ blocked: true, permission: PERMISSION })).rank;
    for (const r of ranks) expect(approval).toBeLessThanOrEqual(r);
    expect(ATTENTION_RANK.approval).toBe(0);
  });

  test("only spawning and running are silent", () => {
    const silent = ALL_STATUSES.filter((s) => attentionOf(session({ status: s })).kind === "none");
    expect(silent.sort()).toEqual(["running", "spawning"]);
  });

  test("statuses map to the kind that describes them", () => {
    expect(attentionOf(session({ status: "flagged" })).kind).toBe("flagged");
    expect(attentionOf(session({ status: "failed" })).kind).toBe("failed");
    expect(attentionOf(session({ status: "dead" })).kind).toBe("failed");
    expect(attentionOf(session({ status: "done", prNumber: 7 })).kind).toBe("review");
    expect(attentionOf(session({ status: "waiting" })).kind).toBe("idle");
  });

  test("a rescuable halt outranks a terminal one", () => {
    const flagged = attentionOf(session({ status: "flagged" })).rank;
    const failed = attentionOf(session({ status: "failed" })).rank;
    const review = attentionOf(session({ status: "done", prNumber: 1 })).rank;
    const idle = attentionOf(session({ status: "waiting" })).rank;
    expect(flagged).toBeLessThan(failed);
    expect(failed).toBeLessThan(review);
    expect(review).toBeLessThan(idle);
  });

  test("every halted-but-resumable status names the retry in its label", () => {
    // The engine's RESUMABLE set is flagged | dead | failed, so all three render
    // a working Resume button. A label that implies there is nothing to do while
    // sitting beside a live button teaches people to stop reading labels.
    for (const status of ["flagged", "dead", "failed"] as const) {
      expect([status, attentionOf(session({ status })).label.toLowerCase()]).toEqual([
        status,
        expect.stringContaining("resume"),
      ]);
    }
  });

  test("labels carry the specifics a human needs", () => {
    expect(attentionOf(session({ status: "failed", exitCode: 127 })).label).toContain("127");
    expect(attentionOf(session({ status: "done", prNumber: 42 })).label).toContain("#42");
    expect(
      attentionOf(session({ status: "flagged", flagReason: "Ran the same test 6 times" })).label
    ).toContain("ran the same test 6 times.");
    expect(
      attentionOf(session({ blocked: true, permission: { ...PERMISSION, title: "Delete src/old.ts" } })).label
    ).toContain("delete src/old.ts");
  });

  test("labels read as sentences, not status codes", () => {
    for (const status of ALL_STATUSES) {
      const label = attentionOf(session({ status })).label;
      expect(label[0]).toBe(label[0].toUpperCase());
      expect(label.endsWith(".")).toBe(true);
    }
  });

  test("a missing flag reason still produces a usable line", () => {
    const a = attentionOf(session({ status: "flagged", flagReason: null }));
    expect(a.kind).toBe("flagged");
    expect(a.label).toContain("supervisor");
  });
});
