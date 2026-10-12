import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { commandLine } from "../../cli/waits";
import { lookPr, parseSpec } from "../waits";
import { readUntil } from "../waitreads";
import type { WaitSpec } from "../types";

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
  const read = (state: "OPEN" | "MERGED" | "CLOSED", head: string) => ({ state, head, checks: [] });
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
