import { describe, expect, test } from "bun:test";
import { pauseTree, ResourceCleanup, type CleanupIO, type PauseProcess } from "../cleanup";
import type { Session } from "../types";

function harness(options: { failSpawn?: boolean; denyPause?: number; denyResume?: number; available?: boolean } = {}) {
  const rows = new Map<number, PauseProcess>([
    [1, { pid: 1, ppid: 0, stopped: false }],
    [10, { pid: 10, ppid: 1, stopped: false }], // server
    [20, { pid: 20, ppid: 1, stopped: false }], // agent
    [21, { pid: 21, ppid: 20, stopped: false }], // tool
    [22, { pid: 22, ppid: 20, stopped: true }], // already stopped
    [30, { pid: 30, ppid: 1, stopped: false }], // unrelated
  ]);
  const born = new Map([...rows.keys()].map(pid => [pid, pid * 1000]));
  let saved: ReturnType<CleanupIO["load"]> = null;
  const signals: [number, string][] = [];
  const io: CleanupIO = {
    ownPid: 10, table: async () => [...rows.values()].map(p => ({ ...p })),
    identity: pid => born.get(pid) ?? null,
    signal(pid, signal) {
      if (signal === "SIGSTOP" && options.denyPause === pid || signal === "SIGCONT" && options.denyResume === pid) throw new Error("permission denied");
      signals.push([pid, signal]);
      rows.get(pid)!.stopped = signal === "SIGSTOP";
    },
    load: () => structuredClone(saved), save: value => { saved = structuredClone(value); },
  };
  const sessions = [{ id: "work", pid: 20, host: "tmux" }] as Session[];
  let starts = 0, helper = "";
  const fleet = {
    sessions: () => sessions,
    settleActivity: async () => {},
    placement: () => ({ accountId: options.available === false ? null : "account" }),
    spawn: async (req: { id: string }) => { starts++; helper = req.id; if (options.failSpawn) throw new Error("spawn failed"); },
    stopSession: async () => {},
  };
  const cleanup = new ResourceCleanup(fleet, () => {}, io, () => true);
  return { cleanup, io, fleet, rows, born, signals, sessions, starts: () => starts, helper: () => helper, saved: () => saved };
}

describe("machine cleanup preserves live work", () => {
  test("refuses the server and its ancestors before signaling anything", async () => {
    const h = harness();
    h.sessions[0]!.pid = 1;
    await expect(h.cleanup.start()).rejects.toThrow("Agentbox server");
    expect(h.signals).toEqual([]);
    expect(h.cleanup.state()).toBeNull();
    expect(h.starts()).toBe(0);
  });

  test("only pauses agent descendants, parent first, and never resumes an existing stop", async () => {
    const h = harness();
    expect(pauseTree([...h.rows.values()], [21, 20], 10).map(p => p.pid)).toEqual([20, 21, 22]);
    await h.cleanup.start();
    expect(h.signals).toEqual([[20, "SIGSTOP"], [21, "SIGSTOP"]]);
    expect(h.cleanup.allows("work")).toBe(false);
    expect(h.cleanup.allows(h.helper())).toBe(true);
    expect(h.cleanup.allows()).toBe(false);
    await h.cleanup.resume();
    expect(h.signals.slice(2)).toEqual([[21, "SIGCONT"], [20, "SIGCONT"]]);
    expect(h.rows.get(22)!.stopped).toBe(true);
    expect(h.cleanup.allows()).toBe(true);
  });

  test("duplicate requests start exactly one agent", async () => {
    const h = harness();
    const results = await Promise.all([h.cleanup.start(), h.cleanup.start()]);
    expect(results[0]?.sessionId).toBe(results[1]?.sessionId);
    await h.cleanup.start();
    expect(h.starts()).toBe(1);
    await h.cleanup.resume();
  });

  test("a launch failure rolls back every suspension", async () => {
    const h = harness({ failSpawn: true });
    await expect(h.cleanup.start()).rejects.toThrow("spawn failed");
    expect(h.rows.get(20)!.stopped).toBe(false);
    expect(h.rows.get(21)!.stopped).toBe(false);
    expect(h.saved()).toBeNull();
  });

  test("a partial pause failure resumes only the processes it stopped", async () => {
    const h = harness({ denyPause: 21 });
    await expect(h.cleanup.start()).rejects.toThrow("permission denied");
    expect(h.signals).toEqual([[20, "SIGSTOP"], [20, "SIGCONT"]]);
    expect(h.starts()).toBe(0);
  });

  test("server restart retains the pause; reused PIDs are never resumed", async () => {
    const h = harness();
    await h.cleanup.start();
    h.born.set(21, 999999);
    const restarted = new ResourceCleanup(h.fleet, () => {}, h.io, () => true);
    expect(restarted.allows()).toBe(false);
    await restarted.resume();
    expect(h.signals.slice(2)).toEqual([[20, "SIGCONT"]]);
  });

  test("a failed resume keeps a recoverable journal and activity gate", async () => {
    const options = { denyResume: 21 };
    const h = harness(options);
    await h.cleanup.start();
    expect((await h.cleanup.resume())?.error).toContain("Could not resume 1");
    expect(h.cleanup.allows()).toBe(false);
    options.denyResume = 0;
    expect(await h.cleanup.resume()).toBeNull();
    expect(h.rows.get(21)!.stopped).toBe(false);
  });

  test("no available helper leaves every session alone", async () => {
    const h = harness({ available: false });
    await expect(h.cleanup.start()).rejects.toThrow("No agent account");
    expect(h.signals).toEqual([]);
    expect(h.saved()).toBeNull();
  });
});
