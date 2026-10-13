import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { commandLine, wait as armWait, line } from "../../cli/waits";
import { lookPr, parseSpec } from "../waits";
import { readUntil, type PrRead } from "../waitreads";
import type { Wait, WaitSpec } from "../types";

const until = (argv: string[]) => readUntil({ kind: "until", cmd: commandLine(argv), cwd: tmpdir(), everyMs: 60_000 }, 1, "test");

describe("wait until", () => {
  test("a bash -c script given as an argv runs whole, so a PR that merged is seen as merged", async () => {
    // Wait 125's shape: a state read into a variable, then tests on it, all inside bash -c.
    const script = `s=$(printf 'fbe1d07 MERGED') && [ -n "$s" ] && [ "$s" != "fbe1d07 OPEN" ] && echo "#8439 now $s"`;
    expect(await until(["bash", "-c", script])).toEqual({ yes: true, said: "#8439 now fbe1d07 MERGED" });
    expect(await until([script])).toEqual({ yes: true, said: "#8439 now fbe1d07 MERGED" });
  });

  test("exit 1 with nothing on stderr is not yet", async () => {
    expect(await until(["bash", "-c", "echo still open; exit 1"])).toEqual({ yes: false, said: "still open" });
  });

  test("a read that failed before a test is a failed look, not a not yet", async () => {
    // gh failing on a 502: its error goes to stderr and the test after it is false.
    const script = `s=$(sh -c 'echo "HTTP 502: Bad Gateway" >&2; exit 1') ; [ "$s" = MERGED ]`;
    await expect(until(["bash", "-c", script])).rejects.toThrow("HTTP 502: Bad Gateway");
    await expect(until(["bash", "-c", "exit 3"])).rejects.toThrow("exited 3");
  });
});

describe("wait pr --merged", () => {
  const pr = (head: string | null) => parseSpec({ kind: "pr", repo: "o/r", number: 8439, merged: true, head }) as Extract<WaitSpec, { kind: "pr" }>;
  const read = (state: "OPEN" | "MERGED" | "CLOSED", head: string): PrRead => ({ state, head, base: "staging", mergeable: "MERGEABLE", checks: [] });
  const armed = 0;
  const later = 10 * 60_000;

  test("takes a head, and still refuses checks", () => {
    expect(pr("fbe1d07").head).toBe("fbe1d07");
    expect(() => parseSpec({ kind: "pr", repo: "o/r", number: 1, merged: true, checks: ["Build"] })).toThrow("its own wait");
  });

  test("a PR already merged ends it at once", () => {
    expect(lookPr(pr(null), {}, read("MERGED", "fbe1d07aaaa"), armed, armed)).toEqual({ end: { how: "happened", text: "PR #8439 merged." } });
    expect(lookPr(pr("aaaaaaa"), {}, read("MERGED", "fbe1d07aaaa"), armed, later)).toMatchObject({ end: { how: "happened" } });
  });

  test("with a head, the head moving ends it; without one, it waits on through pushes", () => {
    expect(lookPr(pr("fbe1d07"), {}, read("OPEN", "fbe1d07aaaa"), armed, later)).toMatchObject({ seen: "open on fbe1d07aaa, not merged" });
    expect(lookPr(pr("fbe1d07"), { head: "fbe1d07aaaa" }, read("OPEN", "c0c803fcba1"), armed, later)).toMatchObject({ end: { how: "stuck", text: expect.stringContaining("head moved to c0c803fcba before it merged") } });
    expect(lookPr(pr(null), {}, read("OPEN", "c0c803fcba1"), armed, later)).toMatchObject({ seen: "open on c0c803fcba, not merged" });
    expect(lookPr(pr(null), {}, read("CLOSED", "c0c803fcba1"), armed, later)).toMatchObject({ end: { how: "stuck" } });
  });
});


describe("wait pr when GitHub suppresses conflicting PR workflows", () => {
  const head = "d67b6266b9c7d20770f81eb61479cbdfd2ae7ac6";
  const spec = (all = true, checks = ["Reviewed head"]) => parseSpec({ kind: "pr", repo: "o/r", number: 8839, head, all, checks }) as Extract<WaitSpec, { kind: "pr" }>;
  const greptile = { name: "Greptile Review", done: true, ok: true, how: "success" };
  const read = (mergeable: PrRead["mergeable"], checks: PrRead["checks"] = [greptile]): PrRead => ({
    state: "OPEN", head, base: "staging", mergeable, checks,
  });

  test("a missing review ends on the first look, even while an external check runs", () => {
    for (const checks of [[], [greptile], [{ ...greptile, done: false, ok: false, how: "pending" }]]) {
      const result = lookPr(spec(), {}, read("CONFLICTING", checks), 0, 1);
      expect(result).toMatchObject({ end: { how: "stuck", text: expect.stringMatching(/conflicts with staging.*Resolve the conflicts/) } });
    }
  });

  test("an external check alone never makes a conflicting or unknown PR look validated", () => {
    expect(lookPr(spec(true, []), { head, readyAt: 1 }, read("CONFLICTING"), 0, 90_000)).toMatchObject({ end: { how: "stuck" } });
    const unknown = lookPr(spec(true, []), { head, readyAt: 1 }, read("UNKNOWN"), 0, 90_000);
    expect(unknown).toMatchObject({ seen: expect.stringContaining("still determining"), memo: { head } });
    expect("end" in unknown).toBe(false);
    expect("memo" in unknown && unknown.memo?.readyAt).toBeUndefined();
  });

  test("a mergeable PR still waits for its review and reports real check failures", () => {
    expect(lookPr(spec(), {}, read("MERGEABLE"), 0, 1)).toMatchObject({ seen: expect.stringContaining("Reviewed head (not reported yet)") });
    expect(lookPr(spec(), {}, read("MERGEABLE", [{ name: "Build", done: true, ok: false, how: "failure" }]), 0, 1)).toMatchObject({ end: { how: "happened", text: expect.stringContaining("FAILED") } });
  });

  test("explicit existing checks can finish through conflicts; missing ones get the diagnosis", () => {
    expect(lookPr(spec(false, ["Greptile Review"]), {}, read("CONFLICTING"), 0, 1)).toMatchObject({ end: { how: "happened", text: expect.stringContaining("1 passed") } });
    expect(lookPr(spec(false), {}, read("CONFLICTING"), 0, 1)).toMatchObject({ end: { how: "stuck" } });
    expect(lookPr({ ...spec(), merged: true, all: false, checks: [] }, {}, read("CONFLICTING"), 0, 1)).toMatchObject({ seen: expect.stringContaining("not merged") });
  });

  test("head movement takes precedence over a conflict on a different head", () => {
    expect(lookPr(spec(), { head }, { ...read("CONFLICTING"), head: "bbbbbbbbbbbb" }, 0, 90_000)).toMatchObject({ end: { how: "stuck", text: expect.stringContaining("head moved") } });
  });
});


describe("PR owner waits exclude merge authorization", () => {
  const head = "abcdef0123456789";
  const spec = (all = true, checks = ["Reviewed head"]) => parseSpec({ kind: "pr", repo: "o/r", number: 1, head, all, checks }) as Extract<WaitSpec, { kind: "pr" }>;
  const passed = (name: string) => ({ name, done: true, ok: true, how: "success" });
  const gate = { name: "Merge gate", done: false, ok: false, how: "pending" };
  const read = (checks = [passed("Build"), passed("Reviewed head"), gate]): PrRead => ({ state: "OPEN", head, base: "staging", mergeable: "MERGEABLE", checks });

  test("CLI --require and --head finish when only Merge gate is pending, including the last-look display", async () => {
    // Exercise the CLI request and the server's evaluator against a fake PR, without GitHub or a live wait.
    let armed: Wait | undefined;
    await armWait(async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      expect([method, path]).toEqual(["POST", "/api/waits"]);
      const request = body as { pr: string; spec: unknown };
      expect(request.pr).toBe("1");
      const parsed = parseSpec({ ...(request.spec as object), repo: "o/r", number: 1 });
      armed = { id: 1, sessionId: "test", spec: parsed, createdAt: 1, deadline: 10_800_001,
        ended: null, outcome: null, endedAt: null, toldAt: null, untold: null, checkedAt: null,
        seen: null, failingSince: null, memo: {} };
      return { wait: armed, already: false } as T;
    }, ["pr", "1", "--require", "Reviewed head", "--head", head]);
    const w = armed!;
    expect(w.spec).toEqual(spec());
    const first = lookPr(w.spec as ReturnType<typeof spec>, w.memo, read(), 1, 1);
    expect(first).toMatchObject({ seen: expect.stringContaining("looking once more") });
    if ("end" in first) throw new Error("must preserve the second-look grace");
    expect(line({ ...w, seen: first.seen, checkedAt: 1 }, 1)).not.toContain("Merge gate");
    expect(lookPr(w.spec as ReturnType<typeof spec>, first.memo ?? {}, read(), 1, 90_001)).toEqual({
      end: { how: "happened", text: "PR #1: all 2 checks concluded on abcdef0123, 2 passed and none failed." },
    });
  });

  test("failed and successful gate statuses also have no effect on completion or counts", () => {
    for (const status of [gate, { ...gate, done: true, how: "failure" }, passed("Merge gate")]) {
      expect(lookPr(spec(), { readyAt: 1 }, read([passed("Build"), passed("Reviewed head"), status]), 1, 90_001))
        .toMatchObject({ end: { how: "happened", text: expect.stringContaining("all 2 checks") } });
    }
  });

  test("pending CI and failed CI are still named, without the gate", () => {
    const pending = { name: "Build", done: false, ok: false, how: "queued" };
    expect(lookPr(spec(), {}, read([pending, passed("Reviewed head"), gate]), 1, 1))
      .toMatchObject({ seen: "waiting on Build on abcdef0123" });
    expect(lookPr(spec(), {}, read([{ ...pending, done: true, how: "failure" }, gate]), 1, 1))
      .toMatchObject({ end: { text: "PR #1, FAILED on abcdef0123: Build (failure). Nothing else is running." } });
  });

  test("pending gate does not hide a missing review or make an empty CI set pass", () => {
    const missing = read([passed("Build"), gate]);
    const first = lookPr(spec(), {}, missing, 1, 1);
    expect(first).toMatchObject({ seen: "waiting on Reviewed head (not reported yet); nothing is running", memo: { absentAt: 1 } });
    expect(lookPr(spec(), { absentAt: 1 }, missing, 1, 1_800_001)).toMatchObject({ end: { how: "stuck" } });
    expect(lookPr(spec(true, []), {}, read([gate]), 1, 1)).toMatchObject({ seen: "no check reported yet on abcdef0123" });
  });

  test("--only omits the gate from other-running text, while --merged still waits for the merge", () => {
    expect(lookPr(spec(false), {}, read(), 1, 1)).toEqual({ end: { how: "happened", text: "PR #1: Reviewed head concluded on abcdef0123, 1 passed and none failed." } });
    expect(lookPr({ ...spec(), merged: true, all: false, checks: [] }, {}, read(), 1, 1))
      .toMatchObject({ seen: "open on abcdef0123, not merged" });
  });

  test("explicit merge authorization is refused and old persisted requests terminate", () => {
    for (const all of [true, false]) expect(() => spec(all, [" merge gate "])).toThrow("merge authorization");
    expect(lookPr({ ...spec(), checks: ["Merge gate"] }, {}, read(), 1, 1)).toMatchObject({ end: { how: "stuck" } });
  });
});
