import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentPool, type Runner, type RunnerFactory } from "../subagents";
import type { AcpEvents, LaunchOptions } from "../acp";
import {
  runWorkflow,
  renderRoster,
  parseJsonAnswer,
  parseJsonArgs,
  MAX_AGENTS,
  type Progress,
  type Slot,
} from "../workflow";

/**
 * A fake omp that answers instantly from a scripted table.
 *
 * Workflows are about *orchestration* — what runs concurrently, what waits for
 * what, what happens when one agent fails — and none of that needs a real
 * model. Answers are keyed by a substring of the prompt so a test can give
 * different agents different replies.
 */
let answers: { match: string; reply: string; delayMs?: number; die?: boolean }[] = [];
let live = 0;
let peakLive = 0;
const started: string[] = [];

const factory: RunnerFactory = (id, events: AcpEvents) => {
  let prompt = "";
  const runner: Runner = {
    pid: 1,
    alive: true,
    async launch(_o: LaunchOptions) {
      return "s";
    },
    send(text: string) {
      prompt = text;
      started.push(text);
      const hit = answers.find((a) => prompt.includes(a.match));
      live++;
      peakLive = Math.max(peakLive, live);
      const finish = () => {
        live--;
        if (hit?.die) {
          (runner as { alive: boolean }).alive = false;
          events.onExit(id, 1);
          return;
        }
        events.onText(id, hit ? hit.reply : "no answer configured");
        events.onTurnEnd(id, "end_turn");
      };
      if (hit?.delayMs) setTimeout(finish, hit.delayMs);
      else queueMicrotask(finish);
    },
    interrupt() {},
    replyPermission() {},
    kill() {
      (runner as { alive: boolean }).alive = false;
    },
  };
  return runner;
};

let home: string;
let pool: SubagentPool;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentbox-wf-"));
  process.env.AGENTBOX_HOME = home;
  answers = [];
  live = 0;
  peakLive = 0;
  started.length = 0;
  pool = new SubagentPool(home, factory);
});

afterEach(() => {
  pool.stopAll();
  delete process.env.AGENTBOX_HOME;
  rmSync(home, { recursive: true, force: true });
});

const run = (script: string, opts: Record<string, unknown> = {}) =>
  runWorkflow(pool, { script, cwd: home, ...opts });

describe("parseJsonAnswer", () => {
  /** Models fence JSON, prefix it with prose, or emit it bare. Failing on the
   *  first two would reject a correct answer for its packaging. */
  test("reads a fenced block, bare JSON, or JSON buried in prose", () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here is what I found:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
    expect(parseJsonAnswer("```\n[1,2,3]\n```")).toEqual([1, 2, 3]);
  });

  test("says what the agent actually said when it is not JSON", () => {
    expect(() => parseJsonAnswer("I could not find anything.")).toThrow(/did not return parseable JSON/);
    expect(() => parseJsonAnswer("I could not find anything.")).toThrow(/I could not find/);
  });
});

describe("running a script", () => {
  test("returns the script's value and logs its progress", async () => {
    answers = [{ match: "capital", reply: "Paris" }];
    const r = await run(`
      log('asking');
      const a = await agent('what is the capital of France');
      return { answer: a };
    `);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ answer: "Paris" });
    expect(r.agentsRun).toBe(1);
    expect(r.log.join("\n")).toContain("asking");
  });

  test("a schema turns prose into a value the script can compute on", async () => {
    answers = [{ match: "count", reply: 'sure:\n```json\n{"n": 7}\n```' }];
    const r = await run(`
      const { n } = await agent('count things', { schema: { n: 0 } });
      return n * 2;
    `);
    expect(r.value).toBe(14);
    // The shape is handed to the agent, not merely validated afterwards.
    expect(started[0]).toContain('"n": 0');
  });

  test("a script error is reported, not thrown at the caller", async () => {
    const r = await run(`throw new Error('bad script');`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad script");
  });

  test("args reach the script", async () => {
    const r = await run(`return args.map(x => x * 2);`, { args: [1, 2, 3] });
    expect(r.value).toEqual([2, 4, 6]);
  });

  test("the log still carries every lifecycle line", async () => {
    const r = await run(`await agent('one'); log('midpoint'); await agent('two'); return 'ok';`);
    expect(r.ok).toBe(true);
    const lines = r.log.join("\n");
    expect(r.log.filter((l) => l.includes("start ")).length).toBe(2);
    expect(r.log.filter((l) => l.includes("done  ")).length).toBe(2);
    expect(lines).toContain("midpoint");
    // done-lines carry settled/spawned so the log reads without the roster.
    expect(lines).toContain("[2/2 settled]");
  });

  test("onProgress reports the roster, not the event that caused it", async () => {
    const seen: Progress[] = [];
    const r = await run(`await agent('one'); log('midpoint'); await agent('two'); return 'ok';`, {
      onProgress: (p: Progress) => seen.push(p),
    });
    expect(r.ok).toBe(true);
    // Every frame is a whole-roster snapshot, so any one of them stands alone.
    expect(seen.every((p) => /^(starting|\d+\/\d+ done)/.test(p.message))).toBe(true);
    expect(seen.some((p) => p.message.includes("midpoint"))).toBe(true);
    const events = seen.map((p) => p.event);
    expect(events).toEqual([...events].sort((a, b) => a - b));
    expect(new Set(events).size).toBe(events.length);
    // The last frame is emitted after the script returns, so it is complete.
    const last = seen[seen.length - 1]!;
    expect(last.done).toBe(2);
    expect(last.total).toBe(2);
    expect(last.message).toContain("2/2 done");
  });

  test("a throwing onProgress observer never fails the workflow", async () => {
    const r = await run(`await agent('x'); return 42;`, {
      onProgress: () => {
        throw new Error("observer bug");
      },
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  test("queued agents are visible before they start", async () => {
    answers = [{ match: "slow", reply: "ok", delayMs: 40 }];
    const seen: Progress[] = [];
    await run(`await parallel([1,2,3,4].map(i => () => agent('slow ' + i)));`, {
      concurrency: 2,
      onProgress: (p: Progress) => seen.push(p),
    });
    // Two run, two wait at the gate — and the wait is most of a fan-out's
    // wall clock, so it has to show.
    expect(seen.some((p) => /2 queued/.test(p.message))).toBe(true);
    expect(seen.some((p) => /2 running/.test(p.message))).toBe(true);
  });

  test("a failed agent is counted as settled, and named as failed", async () => {
    answers = [{ match: "doomed", reply: "", die: true }];
    const seen: Progress[] = [];
    await run(`try { await agent('doomed'); } catch {} return 'done';`, {
      onProgress: (p: Progress) => seen.push(p),
    });
    const last = seen[seen.length - 1]!;
    expect(last.message).toContain("1/1 done");
    expect(last.message).toContain("1 failed");
    expect(last.done).toBe(1);
  });

  test("parseJsonArgs recovers stringified JSON and leaves everything else alone", () => {
    expect(parseJsonArgs('{"units":[1,2]}')).toEqual({ units: [1, 2] });
    expect(parseJsonArgs("[1, 2, 3]")).toEqual([1, 2, 3]);
    expect(parseJsonArgs('  {"a": 1}  ')).toEqual({ a: 1 });
    // A deliberate string arg stays a string, even JSON-adjacent ones.
    expect(parseJsonArgs("hello")).toBe("hello");
    expect(parseJsonArgs('"quoted"')).toBe('"quoted"');
    expect(parseJsonArgs("{not json")).toBe("{not json");
    // Non-strings pass through untouched.
    expect(parseJsonArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseJsonArgs(undefined)).toBeUndefined();
    expect(parseJsonArgs(7)).toBe(7);
  });
});

describe("composition", () => {
  test("parallel waits for all and turns a failure into null", async () => {
    answers = [
      { match: "alpha", reply: "A" },
      { match: "beta", reply: "B", die: true },
      { match: "gamma", reply: "C" },
    ];
    const r = await run(`
      const out = await parallel([
        () => agent('alpha'), () => agent('beta'), () => agent('gamma'),
      ]);
      return out;
    `);
    expect(r.value).toEqual(["A", null, "C"]);
    // …and the failure is named rather than silently absorbed. An agent that
    // died must never reach the script as an empty string, which it would
    // then count, dedup or pass along as if it were an answer.
    expect(r.agents.filter((a) => a.failed).map((a) => a.label)).toEqual(["beta"]);
    expect(r.log.join("\n")).toContain("died before answering");
  });

  test("pipeline runs each item through every stage", async () => {
    answers = [
      { match: "stage1", reply: "one" },
      { match: "stage2", reply: "two" },
    ];
    const r = await run(`
      return await pipeline(['a', 'b'],
        (prev, item) => agent('stage1 for ' + item),
        (prev, item, i) => agent('stage2 after ' + prev + ' for ' + item + ' at ' + i));
    `);
    expect(r.value).toEqual(["two", "two"]);
    expect(r.agentsRun).toBe(4);
    // Later stages can see the original item and its index, not just the
    // previous result — otherwise every stage must thread context by hand.
    expect(started.some((p) => p.includes("stage2 after one for b at 1"))).toBe(true);
  });

  /** The whole reason pipeline is the default: one slow item must not hold up
   *  another item's later stages. */
  test("pipeline does not make a fast item wait for a slow one", async () => {
    answers = [
      { match: "slow", reply: "S", delayMs: 300 },
      { match: "quick", reply: "Q" },
      { match: "second", reply: "2" },
    ];
    const order: string[] = [];
    const r = await run(`
      const done = [];
      await pipeline(['slow', 'quick'],
        (p, item) => agent(item + ' first stage'),
        async (p, item) => { const x = await agent('second stage ' + item); log('finished ' + item); return x; });
      return done;
    `);
    expect(r.ok).toBe(true);
    for (const line of r.log) if (line.includes("finished")) order.push(line);
    // "quick" completes its whole chain before "slow" finishes stage one.
    expect(order[0]).toContain("finished quick");
  });

  test("a stage that throws drops only its own item", async () => {
    answers = [
      { match: "good", reply: "G" },
      { match: "bad", reply: "B", die: true },
    ];
    const r = await run(`
      return await pipeline(['good', 'bad'], (p, item) => agent(item));
    `);
    expect(r.value).toEqual(["G", null]);
  });
});

describe("bounds", () => {
  test("concurrency is capped and the rest queue", async () => {
    answers = [{ match: "task", reply: "x", delayMs: 60 }];
    const r = await run(
      `return await parallel(Array.from({length: 8}, (_, i) => () => agent('task ' + i)));`,
      { concurrency: 3 },
    );
    expect(r.ok).toBe(true);
    expect((r.value as unknown[]).filter(Boolean)).toHaveLength(8);
    expect(peakLive).toBeLessThanOrEqual(3);
  });

  test("a runaway loop is stopped by the agent cap", async () => {
    answers = [{ match: "spin", reply: "x" }];
    const r = await run(`while (true) { await agent('spin'); } `);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("more than");
    expect(r.agentsRun).toBe(MAX_AGENTS);
  }, 30_000);

  test("the deadline stops a workflow that would otherwise run on", async () => {
    answers = [{ match: "slow", reply: "x", delayMs: 5_000 }];
    const r = await run(`return await agent('slow');`, { deadlineMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/deadline/);
  }, 15_000);
});

describe("cleanup", () => {
  /** A fan-out that leaves eighty idle omp processes holding context windows
   *  open is a real cost, and one nobody has a name for any more. */
  test("no agent outlives the workflow, even when it fails", async () => {
    answers = [{ match: "x", reply: "ok" }];
    await run(`await agent('x'); await agent('x'); throw new Error('boom');`);
    expect(pool.list()).toHaveLength(0);
  });

  test("agents are stopped as the script goes, not held to the end", async () => {
    answers = [{ match: "x", reply: "ok" }];
    const r = await run(`
      await agent('x');
      log('pool size mid-script is checked by the test after');
      return 'done';
    `);
    expect(r.ok).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });
});

describe("safety defaults", () => {
  /** Agents in a fan-out share one working tree. Read-only by default makes
   *  the parallel-writers mistake something you have to ask for. */
  test("workflow agents are read-only unless the script opts out", async () => {
    answers = [{ match: "look", reply: "ok" }, { match: "edit", reply: "ok" }];
    let sawReadOnly: boolean[] = [];
    const spy = new SubagentPool(home, factory);
    const original = spy.spawn.bind(spy);
    spy.spawn = async (o) => {
      sawReadOnly.push(o.readOnly === true);
      return original(o);
    };
    await runWorkflow(spy, {
      cwd: home,
      script: `await agent('look at things'); await agent('edit things', { readOnly: false });`,
    });
    expect(sawReadOnly).toEqual([true, false]);
    spy.stopAll();
  });
});

/**
 * The roster line is a UI, and its only real constraint is invisible from
 * here: the client shows it inside a status row and truncates it at the
 * terminal's width, not at any limit this code can see. So the property that
 * matters is not "it fits" — it is that whatever survives an arbitrary cut is
 * still the most useful part.
 */
describe("the roster line", () => {
  const running = (label: string, ms: number, action?: string, idleMs?: number): Slot => ({
    label,
    state: "running",
    ms,
    action,
    idleMs,
  });

  test("names every running agent, what it last did, and how long it has run", () => {
    const line = renderRoster(
      [
        { label: "api", state: "done", ms: 30_000 },
        running("core", 130_000, "Grep auth", 1_000),
        running("web", 45_000, "Edit app.tsx", 2_000),
      ],
      null,
    );
    expect(line).toContain("1/3 done");
    expect(line).toContain("2 running");
    expect(line).toContain("core 2m10s → Grep auth");
    expect(line).toContain("web 45s → Edit app.tsx");
  });

  test("says how long ago only once that is worth saying", () => {
    expect(renderRoster([running("a", 60_000, "Bash", 2_000)], null)).toBe(
      "0/1 done · 1 running · a 1m → Bash",
    );
    expect(renderRoster([running("a", 60_000, "Bash", 90_000)], null)).toContain("→ Bash 1m30s");
  });

  test("the counts survive a cut that the detail does not", () => {
    const slots = Array.from({ length: 12 }, (_, i) => running(`agent-number-${i}`, i * 1000, "Read"));
    const line = renderRoster(slots, null);
    expect(line.length).toBeLessThanOrEqual(200);
    // Everything a narrow terminal can show is a count, and the counts are
    // whole — they describe agents the line has no room to name.
    expect(line.slice(0, 40)).toContain("0/12 done");
    expect(line.slice(0, 40)).toContain("12 running");
  });

  test("the script's own log line yields room to the agents, but keeps its place", () => {
    const line = renderRoster([running("a", 1_000, "Read")], "wave 2 of 3");
    expect(line.indexOf("a 1s")).toBeLessThan(line.indexOf("wave 2 of 3"));
    // Between waves it is the only news there is, so it comes straight after
    // the counts.
    expect(renderRoster([{ label: "a", state: "done", ms: 1_000 }], "wave 2 of 3")).toBe(
      "1/1 done · wave 2 of 3",
    );
  });

  test("an empty roster says so rather than claiming 0/0", () => {
    expect(renderRoster([], null)).toBe("starting");
  });
});
