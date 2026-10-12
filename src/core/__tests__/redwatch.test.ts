import { describe, expect, test } from "bun:test";
import { redNote, redStreak, type WorkflowRun } from "../redwatch";
import { describeRule, isRecurring, nextRun, parseWhen } from "../schedule";

const T0 = Date.parse("2026-10-08T12:00:00Z");
const min = (n: number) => new Date(T0 + n * 60_000).toISOString();

let nextId = 1;
function run(at: number, conclusion: string, status = "completed"): WorkflowRun {
  return {
    databaseId: nextId++,
    status,
    conclusion,
    createdAt: min(at),
    updatedAt: min(at + 20),
    url: `https://github.com/o/r/actions/runs/${at}`,
    headSha: "abcdef0123456789",
    displayTitle: `push at ${at}`,
    event: "push",
  };
}

describe("parseWhen: whenever a workflow is red", () => {
  const red = (t: string) => parseWhen(t, T0);

  test.each([
    ["whenever CD on staging is red", "cd", "staging"],
    ["Whenever staging CD is red", "cd", "staging"],
    ["every time staging CD fails", "cd", "staging"],
    ["when CD goes red on staging", "cd", "staging"],
    ["whenever the CD workflow on staging is red", "cd", "staging"],
    ['whenever "CD watch" on staging is red', "cd watch", "staging"],
    ['whenever staging "cd watch" fails', "cd watch", "staging"],
  ])("%s", (t, workflow, branch) => {
    expect(red(t)).toEqual({ rule: { kind: "red", workflow, branch, repo: null } });
  });

  test("no branch is the default one, and a repo can be named", () => {
    expect(red("whenever cd is red")).toEqual({ rule: { kind: "red", workflow: "cd", branch: null, repo: null } });
    expect(red("whenever o/r's CD on staging is red")).toEqual({ rule: { kind: "red", workflow: "cd", branch: "staging", repo: "o/r" } });
  });

  test("two branches, or a name with spaces unquoted, is refused", () => {
    expect(red("whenever cd on staging fails on master")).toHaveProperty("error");
    expect(red("whenever the cd watch thing is red")).toHaveProperty("error");
  });

  test("it is recurring, has no time, and reads back as itself", () => {
    for (const t of ["whenever CD on staging is red", "whenever cd is red", 'whenever "CD watch" on staging is red']) {
      const p = red(t);
      if ("error" in p) throw new Error(p.error);
      expect(isRecurring(p.rule)).toBe(true);
      expect(nextRun(p.rule, T0)).toBeNull();
      expect(parseWhen(describeRule(p.rule), T0)).toEqual(p);
    }
  });

  test("the other kinds still read as before", () => {
    expect(red("when PR 6644 merges")).toEqual({ rule: { kind: "merge", pr: 6644, repo: null } });
    expect(red("every 2 hours")).toEqual({ rule: { kind: "every", minutes: 120, from: T0 } });
  });
});

describe("redStreak", () => {
  test("green, or nothing finished, is no streak", () => {
    expect(redStreak([], null)).toBeNull();
    expect(redStreak([run(10, "success"), run(0, "failure")], null)).toBeNull();
    expect(redStreak([run(10, "", "in_progress")], null)).toBeNull();
  });

  test("the red runs since the last green one, newest first; cancelled ones are passed over", () => {
    const green = run(0, "success");
    const a = run(10, "failure");
    const b = run(30, "timed_out");
    const s = redStreak([run(40, "cancelled"), run(50, "", "in_progress"), green, a, b], null);
    expect(s).toEqual({ failed: [b, a], lastGreen: green });
  });

  test("a streak has had its session once one started after its last green run", () => {
    const runs = [run(0, "success"), run(10, "failure"), run(40, "failure")];
    // Started for this streak, at minute 35: more red runs do not start another.
    expect(redStreak(runs, T0 + 35 * 60_000)).toBeNull();
    // Started before the green run: that was the last streak.
    expect(redStreak(runs, T0 + 5 * 60_000)).not.toBeNull();
  });

  test("a streak longer than what was read keeps its session", () => {
    const runs = [run(10, "failure"), run(40, "failure")];
    expect(redStreak(runs, null)?.lastGreen).toBeNull();
    expect(redStreak(runs, T0)).toBeNull();
  });
});

describe("redNote", () => {
  const rule = { kind: "red" as const, workflow: "CD", branch: "staging", repo: "o/r" };

  test("names the red runs, the last green one and the last session", () => {
    const green = run(0, "success");
    const bad = run(10, "failure");
    const note = redNote(rule, { failed: [bad], lastGreen: green }, "abc12345");
    expect(note).toStartWith("[agentbox: CD on staging (o/r) is red.");
    expect(note).toContain(bad.url);
    expect(note).toContain(`The last green run: ${green.url}`);
    expect(note).toEndWith("The session this schedule started last: abc12345.]");
  });

  test("started by hand while green says so", () => {
    expect(redNote(rule, null, null)).toContain("not in a red streak right now");
  });
});
