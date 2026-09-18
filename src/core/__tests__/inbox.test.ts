import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { attentionOf, inboxItems } from "../conductor";
import type { PrInfo, Session } from "../types";

test("conductor.ts stays importable from the browser bundle", () => {
  // `web/src/views/Inbox.tsx` value-imports `inboxItems` so the Inbox order is
  // the server's derivation rather than a second one. That only works because
  // conductor.ts has no runtime imports — a `from "./db"` or a `node:*` here
  // breaks the vite build, and it breaks it at bundle time, far from the edit
  // that caused it. Type-only imports are erased, so they are fine.
  const source = readFileSync(new URL("../conductor.ts", import.meta.url), "utf8");
  const runtimeImports = [...source.matchAll(/^import\s+(?!type\s)(.+?)\s+from\s+["'](.+?)["']/gm)];
  expect(runtimeImports.map((m) => m[2])).toEqual([]);
});

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    title: "Add a health endpoint",
    prompt: "add a health endpoint",
    status: "waiting",
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
    pid: null,
    prNumber: null,
    repoFullName: "o/r",
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    subs: null,
    createdAt: 0,
    updatedAt: 1000,
    startedAt: 0,
    closedAt: null,
    parkedAt: null,
    ...patch,
  };
}

function pr(patch: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 7,
    repo: "o/r",
    title: "Add a health endpoint",
    headRef: "vk/ab-1",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/o/r/pull/7",
    author: "someone",
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(2000).toISOString(),
    sessionId: null,
    ...patch,
  };
}

describe("inboxItems", () => {
  test("sessions that are just working stay out of it", () => {
    const items = inboxItems([session({ status: "running" }), session({ id: "s2", status: "spawning" })], []);
    expect(items).toEqual([]);
  });

  test("idle is never an inbox item", () => {
    // The spec bug that produced a 72-item Inbox against real data: `idle`
    // means "a turn ended and nothing is wrong", which is the steady state of
    // most sessions, so its presence made the empty state unreachable.
    const items = inboxItems([session({ id: "a", status: "waiting" })], []);
    expect(items).toEqual([]);
  });

  test("idle still carries a rank, because the Sessions board sorts on it", () => {
    // Ordering and demanding attention are different jobs; dropping it from the
    // Inbox must not strip it from Attention.
    expect(attentionOf(session({ status: "waiting" })).kind).toBe("idle");
  });

  test("only the four acting kinds get in", () => {
    const items = inboxItems(
      [
        session({ id: "approval", blocked: true, permission: { id: "p", title: "Run it", tool: "execute", options: [] } }),
        session({ id: "flagged", status: "flagged" }),
        session({ id: "failed", status: "failed" }),
        session({ id: "dead", status: "dead" }),
        session({ id: "review", status: "done", prNumber: 7 }),
        session({ id: "idle", status: "waiting" }),
        session({ id: "running", status: "running" }),
      ],
      []
    );
    expect(items.map((i) => i.attention.kind)).toEqual([
      "approval", "flagged", "failed", "failed", "review",
    ]);
  });

  test("a closed session never appears, whatever it needs", () => {
    // Closing is the act of dealing with something. This exclusion used to
    // hold by accident — closed sessions never left the server — so it is
    // asserted across every kind that would otherwise get in.
    const closed = { closedAt: 123 };
    const items = inboxItems(
      [
        session({ id: "a", status: "failed", ...closed }),
        session({ id: "b", status: "flagged", ...closed }),
        session({ id: "c", status: "done", prNumber: 7, ...closed }),
        session({
          id: "d",
          blocked: true,
          permission: { id: "p", title: "Run it", tool: "execute", options: [] },
          ...closed,
        }),
      ],
      [pr({ sessionId: "c" })]
    );
    expect(items).toEqual([]);
  });

  test("closing one session does not hide its open siblings", () => {
    const items = inboxItems(
      [
        session({ id: "kept", status: "failed" }),
        session({ id: "gone", status: "failed", closedAt: 123 }),
      ],
      []
    );
    expect(items.map((i) => i.session.id)).toEqual(["kept"]);
  });

  test("a PR with no session behind it is not an inbox item", () => {
    // "Every open PR on the repo" is not a to-do list. A PR reaches the Inbox
    // only through the session that produced it.
    expect(inboxItems([], [pr({ sessionId: null })])).toEqual([]);
    expect(inboxItems([], [pr({ sessionId: "closed-session" })])).toEqual([]);
  });

  test("a review row carries the PR it opened", () => {
    const s = session({ id: "s1", status: "done", prNumber: 7 });
    const [item] = inboxItems([s], [pr({ sessionId: "s1" })]);
    expect(item.attention.kind).toBe("review");
    expect(item.pr?.number).toBe(7);
    expect(item.pr?.title).toBe("Add a health endpoint");
  });

  test("the PR number links it even when the branch match missed", () => {
    // sessionId is resolved by branch; a branch renamed after the PR opened
    // leaves it null, and the recorded number is the remaining link.
    const s = session({ id: "s1", status: "done", prNumber: 7, branch: "renamed" });
    const [item] = inboxItems([s], [pr({ sessionId: null })]);
    expect(item.pr?.number).toBe(7);
  });

  test("a PR in another repo with the same number is not attached", () => {
    const s = session({ id: "s1", status: "done", prNumber: 7, repoFullName: "o/r" });
    const [item] = inboxItems([s], [pr({ repo: "other/repo", sessionId: null })]);
    expect(item.pr).toBeNull();
  });

  test("a review row survives the PR cache not having caught up", () => {
    // `prs` refreshes on a slow interval, so a just-discovered PR is missing
    // from it. The row must still be there — just without its title.
    const s = session({ id: "s1", status: "done", prNumber: 7 });
    const [item] = inboxItems([s], []);
    expect(item.attention.kind).toBe("review");
    expect(item.pr).toBeNull();
  });

  test("ranked worst first, ties broken by recency", () => {
    const items = inboxItems(
      [
        session({ id: "review", status: "done", prNumber: 7 }),
        session({
          id: "blocked",
          blocked: true,
          permission: { id: "p", title: "Run `rm -rf build`", tool: "execute", options: [] },
        }),
        session({ id: "flagged", status: "flagged" }),
        session({ id: "older-failed", status: "failed", updatedAt: 1 }),
        session({ id: "newer-failed", status: "failed", updatedAt: 5000 }),
      ],
      []
    );
    expect(items.map((i) => i.key)).toEqual([
      "session:blocked",
      "session:flagged",
      "session:newer-failed",
      "session:older-failed",
      "session:review",
    ]);
  });

  test("keys are stable and unique", () => {
    const items = inboxItems(
      [session({ id: "a", status: "failed" }), session({ id: "b", status: "failed" })],
      []
    );
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });
});
