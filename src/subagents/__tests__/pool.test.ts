import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDLE_PARK_MS,
  SubagentPool,
  ago,
  normalizeName,
  pruneTranscripts,
  renderAgentLine,
  resolveModel,
  waitForTurn,
  type PoolTiming,
  type Runner,
  type RunnerFactory,
} from "../pool";
import { useTempHome } from "../../core/__tests__/tmp-home";
import * as live from "../live";
import type { AcpEvents, LaunchOptions } from "../acp";
import type { ToolCall } from "../types";

/**
 * A stand-in for the omp process.
 *
 * Every subagent bug worth having a test for is a question of *ordering* — a
 * turn that fails a beat before the exit that caused it is reported, a second
 * message queued behind the first, a process killed with a caller still
 * waiting. Against a live model none of those can be provoked on demand, which
 * is precisely why they shipped. Here they are one method call.
 */
class FakeRunner implements Runner {
  pid: number | null = 4242;
  alive = true;
  sent: string[] = [];
  launched: LaunchOptions | null = null;
  interrupted = 0;
  killed = 0;

  constructor(
    readonly id: string,
    readonly events: AcpEvents,
    readonly autoApprove: () => boolean,
  ) {}

  async launch(opts: LaunchOptions): Promise<string> {
    this.launched = opts;
    return "omp-session-1";
  }
  send(text: string) {
    this.sent.push(text);
  }
  interrupt() {
    this.interrupted++;
  }
  permReplies: { id: string; approved: boolean }[] = [];
  replyPermission(id: string, approved: boolean) {
    this.permReplies.push({ id, approved });
  }
  kill() {
    this.killed++;
    this.alive = false;
  }

  // -- what omp would do to us, on demand

  say(text: string) {
    this.events.onText(this.id, text);
  }
  tool(
    id: string,
    title: string,
    done = true,
    kind: ToolCall["kind"] = "read",
    input: unknown = { path: "x.ts" },
  ) {
    const call: ToolCall = {
      id,
      kind,
      title,
      input,
      status: done ? "ok" : "running",
      locations: [],
      output: done ? "contents" : null,
      subs: undefined,
      startedAt: 1,
      endedAt: done ? 2 : null,
    };
    this.events.onToolStart(this.id, call);
    if (done) this.events.onToolEnd(this.id, call, null);
  }
  endTurn(stopReason = "end_turn") {
    this.events.onTurnEnd(this.id, stopReason);
  }
  askPermission(id: string, kind: string, title = "do a thing") {
    this.events.onPermission(this.id, { id, title, tool: kind, options: [] });
  }
  /** What a hard kill looks like from in here: the in-flight prompt request
   *  rejects, and only afterwards does the exit arrive. */
  crash() {
    this.events.onError(this.id, "ACP connection closed");
    this.events.onTurnEnd(this.id, "error");
    this.alive = false;
    queueMicrotask(() => this.events.onExit(this.id, -1));
  }
}

let fakes: FakeRunner[] = [];
const factory: RunnerFactory = (id, events, autoApprove) => {
  const f = new FakeRunner(id, events, autoApprove);
  fakes.push(f);
  return f;
};

let home: string;
let restoreHome: () => void;
let pool: SubagentPool;

beforeEach(() => {
  ({ home, restore: restoreHome } = useTempHome());
  fakes = [];
  pool = new SubagentPool(home, factory, TIMING);
});

afterEach(() => {
  // Stop every agent before the home is removed. Without this, a test that
  // ends mid-backoff leaves a live timer that fires during a LATER test —
  // sending to a stale fake and appending into a deleted directory, where
  // `log`'s catch swallows the error and the damage is invisible.
  pool.stopAll();
  restoreHome();
});

const only = () => fakes[fakes.length - 1]!;

/**
 * The pool's waits on a failed turn, shortened so a test waits out a backoff
 * in milliseconds rather than seconds. The one relation the tests lean on is
 * the real one: the grace window is well inside the first backoff.
 */
const TIMING: PoolTiming = { deathGraceMs: 50, continueBackoffMs: [150, 200, 250] };
/** Room for a timer that is due to have fired, on a loaded machine. */
const SLACK = 60;
const insideGrace = () => Bun.sleep(TIMING.deathGraceMs / 5);
const insideBackoff = () => Bun.sleep(TIMING.deathGraceMs + TIMING.continueBackoffMs[0]! / 2);
/** Past the resume for `attempt`, measured from the failed turn's end. */
const pastResume = (attempt = 1) => Bun.sleep(TIMING.deathGraceMs + TIMING.continueBackoffMs[attempt - 1]! + SLACK);

describe("names", () => {
  test("are lowercased and stripped to something typeable", () => {
    expect(normalizeName("  Test Sweep!! ")).toBe("test-sweep");
    expect(normalizeName("--migrate__imports--")).toBe("migrate__imports");
  });

  test("are generated when not given, and never collide", async () => {
    await pool.spawn({ prompt: "a" });
    await pool.spawn({ prompt: "b", name: "agent-2" });
    const third = await pool.spawn({ prompt: "c" });
    expect(pool.list().map((a) => a.name).sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(third.name).toBe("agent-3");
  });

  test("a live agent will not give its name up", async () => {
    await pool.spawn({ prompt: "a", name: "dup" });
    await expect(pool.spawn({ prompt: "b", name: "dup" })).rejects.toThrow(/already running/);
  });

  /**
   * The obvious move after a crash is to start the same agent again — but the
   * crash left a report nobody read, and freeing the name drops the mailbox
   * with it. So the name is released only once that answer has been taken.
   */
  test("a dead agent holds its name until its last answer is collected", async () => {
    const first = await pool.spawn({ prompt: "a", name: "dup" });
    only().crash();
    await Bun.sleep(1);
    expect(first.state).toBe("dead");
    expect(first.uncollected).toBe(1);

    await expect(pool.spawn({ prompt: "b", name: "dup" })).rejects.toThrow(/uncollected answer/);

    expect((await first.settle(50))!.state).toBe("dead");
    const second = await pool.spawn({ prompt: "b", name: "dup" });
    expect(second.name).toBe("dup");
    expect(second).not.toBe(first);
  });

  /** …and discarding it deliberately is always allowed. */
  test("stopping a dead agent frees the name even with mail unread", async () => {
    await pool.spawn({ prompt: "a", name: "dup" });
    only().crash();
    await Bun.sleep(1);
    pool.remove("dup");
    await expect(pool.spawn({ prompt: "b", name: "dup" })).resolves.toBeDefined();
  });

  test("an unknown name says what is running instead", async () => {
    expect(() => pool.get("nope")).toThrow(/none are running/);
    await pool.spawn({ prompt: "a", name: "real" });
    expect(() => pool.get("nope")).toThrow(/Running: real/);
  });
});

describe("model resolution", () => {
  test("prefers the explicit id, then the env, then the default", () => {
    process.env.AGENTBOX_SUBAGENT_MODEL = "env/model";
    expect(resolveModel("explicit/model")).toBe("explicit/model");
    expect(resolveModel()).toBe("env/model");
    delete process.env.AGENTBOX_SUBAGENT_MODEL;
    expect(resolveModel()).toBe("opencode-go-responses/muse-spark-1.3-contributor");
  });
});

describe("launching", () => {
  test("runs in the given cwd and writes a system prompt that exists", async () => {
    const agent = await pool.spawn({ prompt: "do the thing", cwd: home });
    const opts = only().launched!;
    expect(opts.worktree).toBe(home);
    expect(opts.advisor).toBe(false);
    // omp silently treats an unreadable path as literal prompt text, so the
    // file existing is the whole contract here.
    expect(existsSync(opts.promptFile)).toBe(true);
    expect(readFileSync(opts.promptFile, "utf8")).toContain("final message is your entire return value");
    expect(only().sent).toEqual(["do the thing"]);
    expect(agent.state).toBe("running");
  });

  test("meta.json names omp's session, so its transcript in omp's store can be traced back", async () => {
    const agent = await pool.spawn({ prompt: "do the thing", cwd: home, name: "tracer" });
    const meta = JSON.parse(readFileSync(join(agent.dir, "meta.json"), "utf8"));
    expect(meta.name).toBe("tracer");
    expect(meta.ompSessionId).toBe("omp-session-1");
    expect(meta.prompt).toBe("do the thing");
  });

  test("an agent whose omp never started still has a meta.json, without a session id", async () => {
    const p = new SubagentPool(home, (id, events, autoApprove) => {
      const f = new FakeRunner(id, events, autoApprove);
      f.launch = async () => {
        throw new Error("no omp here");
      };
      return f;
    });
    await expect(p.spawn({ prompt: "p", cwd: home, name: "stillborn" })).rejects.toThrow(/no omp here/);
    const [dir] = readdirSync(join(home, "subagents")).filter((d) => d.endsWith("-stillborn"));
    const meta = JSON.parse(readFileSync(join(home, "subagents", dir!, "meta.json"), "utf8"));
    expect(meta.name).toBe("stillborn");
    expect(meta.ompSessionId).toBeUndefined();
  });

  test("a role is appended to the contract, not substituted for it", async () => {
    await pool.spawn({ prompt: "p", role: "READ ONLY: change nothing." });
    const body = readFileSync(only().launched!.promptFile, "utf8");
    expect(body).toContain("You are a subagent.");
    expect(body).toContain("READ ONLY: change nothing.");
  });

  /** The one way this design could strand a caller completely: omp starts but
   *  never negotiates, and nothing below has a deadline. */
  test("a launch that never finishes fails instead of blocking forever", async () => {
    const wedged: RunnerFactory = (id, events, autoApprove) => {
      const f = new FakeRunner(id, events, autoApprove);
      fakes.push(f);
      f.launch = () => new Promise<string>(() => {});
      return f;
    };
    const p = new SubagentPool(home, wedged);
    // Proven by construction rather than by waiting out the real 60s: the
    // race is against a timer, so a fake timer proves the wiring.
    const realSetTimeout = globalThis.setTimeout;
    // @ts-expect-error narrowing a test double onto the global
    globalThis.setTimeout = (fn: () => void, ms: number) =>
      realSetTimeout(fn, ms >= 60_000 ? 5 : ms);
    try {
      await expect(p.spawn({ prompt: "x", name: "wedged" })).rejects.toThrow(/did not finish starting/);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(p.list()).toHaveLength(0);
  });

  test("a cwd that is not a directory is refused before anything starts", async () => {
    await expect(pool.spawn({ prompt: "p", cwd: join(home, "nope") })).rejects.toThrow(/not a directory/);
    expect(fakes).toHaveLength(0);
  });
});

describe("turns", () => {
  test("the report is the turn's prose, and stats say what it cost", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.say("Found it: ");
    f.tool("t1", "reading paths.ts");
    f.say("src/core/paths.ts:20.");
    f.events.onUsage("x", 0.0123);
    f.events.onContext("x", 19_000, 200_000);
    f.endTurn();

    const r = await agent.settle(50);
    expect(r).not.toBeNull();
    expect(r!.report).toBe("Found it: src/core/paths.ts:20.");
    expect(r!.stopReason).toBe("end_turn");
    expect(r!.toolCalls).toBe(1);
    expect(r!.costUsd).toBe(0.0123);
    expect(r!.contextTokens).toBe(19_000);
    expect(agent.state).toBe("idle");
  });

  /**
   * Prose written before the last tool call is still the agent's findings.
   * Keeping only the trailing paragraph would read as "the final message" and
   * silently delete work the caller can never know it was not shown.
   */
  test("prose from before the last tool call survives", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.say("The bug is in router.ts.");
    f.tool("t1", "verifying");
    f.endTurn();
    expect((await agent.settle(50))!.report).toBe("The bug is in router.ts.");
  });

  test("a finished turn waits in the mailbox for a caller who timed out", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    // Nobody is waiting when this lands.
    only().say("done");
    only().endTurn();
    expect(agent.summary().uncollected).toBe(1);
    const r = await agent.settle(50);
    expect(r!.report).toBe("done");
    expect(agent.summary().uncollected).toBe(0);
  });

  test("a caller already waiting is handed the turn directly", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const pending = agent.settle(1000);
    only().say("late");
    only().endTurn();
    expect((await pending)!.report).toBe("late");
  });

  test("a timeout returns null and leaves the agent running", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    expect(await agent.settle(20)).toBeNull();
    expect(agent.state).toBe("running");
    // …and the answer is not lost by having stopped waiting.
    only().say("eventually");
    only().endTurn();
    expect((await agent.settle(50))!.report).toBe("eventually");
  });

  /** Blocking here would burn the caller's whole timeout on a turn that can
   *  never arrive, which reads as a hung agent. */
  test("settling on an idle agent returns at once", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().endTurn();
    await agent.settle(50);
    const started = Date.now();
    expect(await agent.settle(5000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("two queued messages are two turns, each with its own report", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    agent.send("two");
    expect(only().sent).toEqual(["one", "two"]);

    only().say("first");
    only().endTurn();
    // Still owed a second turn, so it is working — not idle.
    expect(agent.state).toBe("running");
    only().say("second");
    only().endTurn();

    expect((await agent.settle(50))!.report).toBe("first");
    expect((await agent.settle(50))!.report).toBe("second");
    expect(agent.state).toBe("idle");
    expect(agent.summary().turns).toBe(2);
  });

  test("an interrupted turn is reported as cancelled and the agent lives on", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    agent.interrupt();
    expect(only().interrupted).toBe(1);
    only().endTurn("cancelled");
    const r = await agent.settle(50);
    expect(r!.stopReason).toBe("cancelled");
    expect(agent.state).toBe("idle");
    agent.send("do this instead");
    expect(only().sent).toContain("do this instead");
  });
});

describe("resuming through provider errors", () => {
  /** A rejected `session/prompt` is a 429 or a 500, not the agent finishing.
   *  Reporting it as a completed turn hands back a truncated answer wearing
   *  the costume of a finished one. */
  test("a provider error resumes instead of reporting a finished turn", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.say("Half of the ans");
    f.events.onError("x", "HTTP 429 rate limited");
    f.events.onTurnEnd("x", "error");

    // Nothing is reported: the turn is still owed.
    await insideBackoff();
    expect(agent.state).toBe("running");
    expect(agent.uncollected).toBe(0);

    // …and omp is asked to carry on, after a backoff.
    await pastResume();
    expect(f.sent[1]).toContain("Continue from exactly where you stopped");

    // The salvaged prose is still there for the resumed text to join.
    f.say("wer is 42.");
    f.endTurn();
    const r = await agent.settle(500);
    expect(r!.report).toBe("Half of the answer is 42.");
    expect(r!.stopReason).toBe("end_turn");
    expect(r!.turn).toBe(1);
    expect(r!.errors.join(" ")).toContain("resumed automatically (attempt 1 of 3)");
  }, 10_000);

  test("it gives up after a bounded number of attempts", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    for (let i = 0; i < 4; i++) {
      f.events.onError("x", "HTTP 500");
      f.events.onTurnEnd("x", "error");
      await (i < 3 ? pastResume(i + 1) : Bun.sleep(TIMING.deathGraceMs + SLACK));
    }
    const r = await agent.settle(500);
    expect(r).not.toBeNull();
    expect(r!.stopReason).toBe("error");
    // Three resumes attempted, then the failure is the caller's to see.
    expect(f.sent.filter((m) => m.includes("Continue from exactly")).length).toBe(3);
    expect(r!.errors.join(" ")).toContain("attempt 3 of 3");
    expect(agent.state).toBe("idle");
  }, 30_000);

  /** A dead process is not a provider hiccup; resuming it is impossible. */
  test("a crash is never resumed", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().crash();
    const r = await agent.settle(2000);
    expect(r!.state).toBe("dead");
    expect(r!.stopReason).toBe("died");
    expect(only().sent).toHaveLength(1); // no Continue was sent
  });

  /** The budget is per-turn: a fresh message starts with a full one. */
  test("the resume budget resets on the next message", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.events.onTurnEnd("x", "error");
    await pastResume();
    f.endTurn();
    await agent.settle(500);

    agent.send("second");
    f.events.onTurnEnd("x", "error");
    await pastResume();
    expect(f.sent.filter((m) => m.includes("Continue from exactly")).length).toBe(2);
  }, 15_000);

  test("interrupting during the backoff ends the turn rather than stranding it", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.say("partial");
    f.events.onTurnEnd("x", "error");
    await insideBackoff();          // inside the backoff, before the resume
    expect(agent.interrupt()).toBe(true);
    const r = await agent.settle(500);
    expect(r!.stopReason).toBe("cancelled");
    expect(r!.report).toBe("partial");
    expect(agent.state).toBe("idle");
    await pastResume();
    expect(f.sent.filter((m) => m.includes("Continue from exactly"))).toHaveLength(0);
  }, 10_000);
});

describe("resume: the ordering hazards", () => {
  /**
   * Two turns failing inside one grace window. The first version kept the
   * prose in a single shared slot, so the second end overwrote the first —
   * and because the resume decision re-read `owed` at timer-fire time, after
   * a decrement, it also resumed a turn the caller was already steering.
   */
  test("a second failure inside the window does not eat the first turn's prose", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const f = only();
    agent.send("two");                       // owed = 2
    f.say("PROSE-A");
    f.events.onTurnEnd("x", "error");        // end #1
    await insideGrace();                     // …still inside its grace window
    f.say("PROSE-B");
    f.events.onTurnEnd("x", "error");        // end #2
    await pastResume();

    const r1 = await agent.settle(50, 1);
    expect(r1!.report).toBe("PROSE-A");       // not PROSE-B
    const r2 = await agent.settle(50, 2);
    expect(r2!.report).toBe("PROSE-B");
    // The caller was steering the whole time: nothing was auto-resumed.
    expect(f.sent.filter((m) => m.includes("Continue from exactly"))).toHaveLength(0);
  }, 15_000);

  /** A message arriving mid-backoff means the caller is steering; the queued
   *  message is the continuation, and ours would only queue behind it. */
  test("a message during the backoff cancels the resume", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const f = only();
    f.say("PROSE-A");
    f.events.onTurnEnd("x", "error");        // owed 1 -> resume scheduled
    await insideBackoff();
    agent.send("two");                       // caller steers inside the backoff
    await pastResume();

    expect(f.sent).toEqual(["one", "two"]);   // no phantom third prompt
    const r1 = await agent.settle(50, 1);
    expect(r1!.report).toBe("PROSE-A");       // reported, not glued to turn 2
  }, 15_000);

  test("interrupting inside the grace window really stops it", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const f = only();
    f.say("PROSE-A");
    f.events.onTurnEnd("x", "error");
    await insideGrace();                     // inside the window
    expect(agent.interrupt()).toBe(true);
    const r = await agent.settle(50);
    expect(r!.stopReason).toBe("cancelled");
    expect(r!.report).toBe("PROSE-A");
    expect(agent.state).toBe("idle");
    await pastResume();
    expect(f.sent.filter((m) => m.includes("Continue from exactly"))).toHaveLength(0);
  }, 10_000);

  /** Interrupt must also reach the turn that is genuinely running inside omp,
   *  not just the one waiting on our own timer. */
  test("interrupting during a backoff also stops the queued turn", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const f = only();
    f.events.onTurnEnd("x", "error");
    await insideBackoff();                   // in the backoff
    agent.send("two");                       // now running inside omp
    expect(agent.interrupt()).toBe(true);
    expect(f.interrupted).toBe(1);
  }, 10_000);

  /** Chunks still in flight when the prompt rejected land in the buffer during
   *  the window; the resume must carry salvage alongside them, not over them. */
  test("a late chunk is not clobbered by the resume", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const f = only();
    f.say("PROSE-A");
    f.events.onTurnEnd("x", "error");
    f.say("-LATE");                          // arrives after the end
    await pastResume();
    f.say("-RESUMED");
    f.endTurn();
    const r = await agent.settle(500, 1);
    expect(r!.report).toBe("PROSE-A-LATE-RESUMED");
  }, 15_000);
});

describe("death", () => {
  /**
   * The one that actually shipped broken. omp's prompt request rejects before
   * the process exit is reported, so a report built at that instant called a
   * dead agent `idle` — and the caller went on talking to a corpse.
   */
  test("a crash mid-turn reports a dead agent, not an idle one", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().say("partial thought");
    only().crash();

    const r = await agent.settle(2000);
    expect(r).not.toBeNull();
    expect(r!.state).toBe("dead");
    expect(r!.report).toBe("partial thought");
    expect(r!.errors.join(" ")).toContain("ACP connection closed");
    expect(agent.state).toBe("dead");
  });

  test("a crash with a caller waiting answers them rather than hanging", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const pending = agent.settle(5000);
    only().crash();
    const r = await pending;
    expect(r!.state).toBe("dead");
  });

  test("messaging a dead agent fails loudly", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().crash();
    await agent.settle(2000);
    expect(() => agent.send("hello?")).toThrow(/is dead/);
  });

  test("settling on a dead agent returns at once", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().crash();
    await agent.settle(2000);
    const started = Date.now();
    expect(await agent.settle(5000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  /**
   * A prompt request can fail without the process dying. That is a bad turn,
   * not a bad agent — and it is now resumed rather than reported, so what the
   * caller must NOT see is the turn ending here.
   */
  test("a failed turn on a live process is resumed, not reported", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().events.onError("x", "provider 502");
    only().endTurn("error");
    await insideBackoff();
    expect(await agent.settle(50)).toBeNull();
    expect(agent.state).toBe("running");
    expect(agent.alive).toBe(true);
  });

  /** …but a caller who is already steering owns the conversation: their
   *  queued message is the continuation, so nothing is auto-sent. */
  test("a queued follow-up suppresses the automatic resume", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.say("partial");
    agent.send("actually, do this instead");   // queued behind the failing turn
    f.events.onError("x", "provider 502");
    f.events.onTurnEnd("x", "error");

    const r = await agent.settle(2000, 1);
    expect(r!.stopReason).toBe("error");
    expect(r!.report).toBe("partial");
    await pastResume();
    expect(f.sent.filter((m) => m.includes("Continue from exactly"))).toHaveLength(0);
  }, 10_000);
});

describe("report clipping", () => {
  /** A resumed turn's finished answer sits at the tail, behind the salvaged
   *  fragments. Head-only clipping would keep the scraps and cut the answer. */
  test("an over-long report keeps both ends", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.say("HEAD-MARKER" + "x".repeat(30_000) + "TAIL-MARKER");
    f.endTurn();
    const r = await agent.settle(50);
    expect(r!.report.startsWith("HEAD-MARKER")).toBe(true);
    expect(r!.report.endsWith("TAIL-MARKER")).toBe(true);
    expect(r!.report).toContain("omitted from the middle");
  });
});

describe("partial output", () => {
  /** What a caller wants when a long agent has not answered yet: not the tool
   *  calls, but what it is concluding. */
  test("shows the prose written so far, tail-first when long", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    expect(agent.partial()).toBe("");
    only().say("Checking the router. ");
    only().say("It looks like the bug is in dispatch().");
    expect(agent.partial()).toBe("Checking the router. It looks like the bug is in dispatch().");

    only().say("x".repeat(3000));
    const clipped = agent.partial(100);
    expect(clipped).toContain("earlier chars omitted");
    expect(clipped.endsWith("x".repeat(100))).toBe(true);
  });

  test("is emptied once the turn is reported", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().say("done");
    only().endTurn();
    await agent.settle(50);
    expect(agent.partial()).toBe("");
  });
});

describe("interrupting", () => {
  test("an idle agent reports that there was nothing to interrupt", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().endTurn();
    await agent.settle(50);
    expect(agent.interrupt()).toBe(false);
    expect(only().interrupted).toBe(0);
  });

  test("a running agent is interrupted", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    expect(agent.interrupt()).toBe(true);
    expect(only().interrupted).toBe(1);
  });
});

describe("transcript pruning", () => {
  test("removes directories past the TTL and keeps the rest", () => {
    const root = join(home, "subagents");
    mkdirSync(join(root, "old"), { recursive: true });
    mkdirSync(join(root, "fresh"), { recursive: true });
    const ancient = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(join(root, "old"), ancient, ancient);

    expect(pruneTranscripts()).toBe(1);
    expect(existsSync(join(root, "old"))).toBe(false);
    expect(existsSync(join(root, "fresh"))).toBe(true);
  });

  test("is a no-op when nothing has ever run", () => {
    expect(pruneTranscripts()).toBe(0);
  });
});

describe("the pool", () => {
  test("stopping an agent kills it and frees the name", async () => {
    await pool.spawn({ prompt: "p", name: "gone" });
    const f = only();
    pool.remove("gone");
    expect(f.killed).toBe(1);
    expect(pool.list()).toHaveLength(0);
    await expect(pool.spawn({ prompt: "p", name: "gone" })).resolves.toBeDefined();
  });

  test("stopAll leaves nothing running", async () => {
    await pool.spawn({ prompt: "a" });
    await pool.spawn({ prompt: "b" });
    pool.stopAll();
    expect(fakes.every((f) => f.killed === 1)).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  /** A name held by an agent that never started would fail the obvious retry. */
  test("a failed launch does not take the name with it", async () => {
    const boom: RunnerFactory = (id, events, autoApprove) => {
      const f = new FakeRunner(id, events, autoApprove);
      fakes.push(f);
      f.launch = async () => {
        throw new Error("omp not found");
      };
      return f;
    };
    const p = new SubagentPool(home, boom);
    await expect(p.spawn({ prompt: "x", name: "taken" })).rejects.toThrow(/could not start omp/);
    expect(p.list()).toHaveLength(0);
    await expect(new SubagentPool(home, factory).spawn({ prompt: "x", name: "taken" })).resolves.toBeDefined();
  });
});

describe("turn correlation", () => {
  /** The bug this prevents: fire-and-forget one message, send another, and be
   *  handed the FIRST answer as the reply to the second. */
  test("a pinned wait takes its own answer, not the oldest one", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    only().say("answer one");
    only().endTurn();                    // turn 1 lands in the mailbox, unread

    const turn2 = agent.send("two");
    expect(turn2).toBe(2);
    const waiting = agent.settle(1000, turn2);
    only().say("answer two");
    only().endTurn();

    const r2 = await waiting;
    expect(r2!.turn).toBe(2);
    expect(r2!.report).toBe("answer two");
    // Turn 1 is untouched and still collectable.
    expect(agent.uncollected).toBe(1);
    const r1 = await agent.settle(50);
    expect(r1!.turn).toBe(1);
    expect(r1!.report).toBe("answer one");
  });

  test("a pinned wait finds its answer already waiting in the mailbox", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const turn2 = agent.send("two");
    only().say("a1"); only().endTurn();
    only().say("a2"); only().endTurn();
    const r = await agent.settle(50, turn2);
    expect(r!.report).toBe("a2");
    expect(agent.uncollected).toBe(1);
  });

  /** What `collect` tells a caller about the backlog it cannot see. Pinned
   *  waiters are somebody else's turn and must not be counted. */
  test("queuedCollectors counts only the unpinned waiters", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    expect(agent.queuedCollectors).toBe(0);
    const turn2 = agent.send("two");
    const first = agent.settle(50);
    const second = agent.settle(50);
    agent.settle(1000, turn2);
    expect(agent.queuedCollectors).toBe(2);
    // Both time out and drop themselves; the pinned one stays behind.
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(agent.queuedCollectors).toBe(0);
  });

  /** An unpinned `collect` must not starve a caller pinned to a later turn. */
  test("a pinned waiter is preferred over an unpinned one", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const turn2 = agent.send("two");
    const unpinned = agent.settle(1000);
    const pinned = agent.settle(1000, turn2);
    only().say("a1"); only().endTurn();
    only().say("a2"); only().endTurn();
    expect((await unpinned)!.turn).toBe(1);
    expect((await pinned)!.turn).toBe(2);
  });

  test("waiting for a turn already given to someone else returns null, not a hang", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    only().say("a1"); only().endTurn();
    expect((await agent.settle(50, 1))!.report).toBe("a1");
    const started = Date.now();
    expect(await agent.settle(3000, 1)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  /** Every pipelined message is owed an answer, including on death. */
  test("death answers every owed turn, not just the first", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    agent.send("two");
    agent.send("three");
    only().say("partial");
    only().crash();
    await Bun.sleep(5);

    const reports = [
      await agent.settle(50),
      await agent.settle(50),
      await agent.settle(50),
    ];
    expect(reports.map((r) => r!.turn)).toEqual([1, 2, 3]);
    expect(reports.every((r) => r!.state === "dead")).toBe(true);
    expect(reports[0]!.report).toBe("partial");
    expect(reports[1]!.report).toBe("");
    // A turn aborted by death is still a turn that happened.
    expect(agent.summary().turns).toBe(3);
    expect(await agent.settle(50)).toBeNull();
  });
});

describe("the death-grace window", () => {
  /**
   * The window keeps the agent nominally `running` for 300ms after a failed
   * turn, so a `send_message` can land inside it. Without freezing, that
   * message's opening prose appends to the same buffer — surfacing in the
   * PREVIOUS turn's report and vanishing from its own.
   */
  test("a message arriving inside the window cannot bleed into the last report", async () => {
    const agent = await pool.spawn({ prompt: "one" });
    const f = only();
    f.say("turn one prose");
    f.events.onError("x", "provider 502");
    f.events.onTurnEnd("x", "error");   // alive, so the grace window opens

    const turn2 = agent.send("two");     // …and this arrives inside it
    f.say("turn two prose");

    const r1 = await agent.settle(2000, 1);
    expect(r1!.report).toBe("turn one prose");

    f.endTurn();
    const r2 = await agent.settle(2000, turn2);
    expect(r2!.report).toBe("turn two prose");
  });
});

describe("read-only enforcement", () => {
  test("an ordinary agent approves everything at the source", async () => {
    await pool.spawn({ prompt: "p" });
    expect(only().autoApprove()).toBe(true);
  });

  test("a read-only agent judges by kind: reads pass, writes and shell are denied", async () => {
    await pool.spawn({ prompt: "p", readOnly: true });
    const f = only();
    expect(f.autoApprove()).toBe(false); // every request reaches the handler
    f.askPermission("p1", "read");
    f.askPermission("p2", "search");
    f.askPermission("p3", "edit", "editing greet.ts");
    f.askPermission("p4", "execute", "running rm -rf");
    f.askPermission("p5", "delete");
    expect(f.permReplies).toEqual([
      { id: "p1", approved: true },
      { id: "p2", approved: true },
      { id: "p3", approved: false },
      { id: "p4", approved: false },
      { id: "p5", approved: false },
    ]);
  });

  /** A denial must be visible in the report, or the caller reads an agent
   *  that silently did less than asked and cannot tell why. */
  test("denials surface in the turn's errors", async () => {
    const agent = await pool.spawn({ prompt: "p", readOnly: true });
    only().askPermission("p1", "edit", "editing greet.ts");
    only().endTurn();
    const r = await agent.settle(50);
    expect(r!.errors.join(" ")).toContain("denied (read-only agent): editing greet.ts");
  });

  test("the agent is told it is read-only, and the list shows it", async () => {
    const agent = await pool.spawn({ prompt: "p", readOnly: true });
    expect(readFileSync(only().launched!.promptFile, "utf8")).toContain("READ-ONLY, enforced by the harness");
    expect(agent.summary().readOnly).toBe(true);
    // …and absent, not false, on an ordinary agent, to keep list output lean.
    await pool.spawn({ prompt: "p" });
    expect(pool.list().find((a) => a !== agent)!.summary().readOnly).toBeUndefined();
  });
});

describe("fire-and-forget", () => {
  test("settle(0) hands the handle back at once and the answer waits", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const started = Date.now();
    expect(await agent.settle(0)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
    only().say("done later");
    only().endTurn();
    expect((await agent.settle(50))!.report).toBe("done later");
  });
});

describe("the transcript", () => {
  test("records each tool call once, updated in place", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().tool("t1", "reading a.ts");
    only().tool("t2", "reading b.ts");
    const calls = agent.transcript();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.title)).toEqual(["reading a.ts", "reading b.ts"]);
    expect(calls[0]!.status).toBe("ok");
    expect(calls[0]!.output).toBe("contents");
  });

  /** The stats line is the caller's did-it-really-work signal; it must agree
   *  with the transcript even when a call arrives only as a terminal update. */
  test("a call seen only at its end is still counted", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    const call = {
      id: "late", kind: "execute", title: "late call", input: null,
      status: "ok", locations: [], output: "x", subs: undefined,
      startedAt: 1, endedAt: 2,
    } as const;
    f.events.onToolEnd(f.id, call as unknown as ToolCall, null);
    f.endTurn();
    const r = await agent.settle(50);
    expect(r!.toolCalls).toBe(1);
    expect(agent.transcript()).toHaveLength(1);
  });

  test("a call that starts before it finishes is one row, not two", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    const f = only();
    f.tool("t1", "running tests", false);
    expect(agent.transcript()).toHaveLength(1);
    expect(agent.transcript()[0]!.status).toBe("running");
    f.tool("t1", "running tests", true);
    expect(agent.transcript()).toHaveLength(1);
    expect(agent.transcript()[0]!.status).toBe("ok");
  });
});

/**
 * What a watcher sees while the answer is still minutes away.
 *
 * The two halves have to be read together: an action with no clock cannot
 * distinguish an agent mid-grep from one that grepped four minutes ago and
 * hung, and a clock with no action cannot say what the wait is for.
 */
describe("live activity", () => {
  test("reports the last tool, and prose counts as activity too", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    // Before omp says anything there is still something true to report.
    expect(agent.activity().action).toBe("starting");

    only().tool("t1", "reading a.ts");
    expect(agent.activity().action).toBe("reading a.ts");
    expect(agent.activity().toolCalls).toBe(1);

    // A long report is work, not a stall — a clock driven only by tool calls
    // would say the opposite of the truth here.
    only().say("Here is what I found");
    expect(agent.activity().action).toBe("writing");
  });

  test("a running tool is the current action before it has finished", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().tool("t1", "running tests", false);
    expect(agent.activity().action).toBe("running tests");
    expect(agent.activity().toolCalls).toBe(1);
  });

  test("the clocks are counted from the turn, and reset with it", async () => {
    const agent = await pool.spawn({ prompt: "p" });
    only().tool("t1", "reading a.ts");
    only().endTurn();
    await agent.settle(50);
    expect(agent.activity().turnMs).toBeGreaterThanOrEqual(0);
    // The next turn's tool count starts from zero, so "0 tool calls" after a
    // follow-up means this turn has done nothing, not that the agent never did.
    agent.send("again");
    expect(agent.activity().toolCalls).toBe(0);
    expect(agent.activity().action).toBe("starting");
  });
});

/**
 * The wrong-tree family.
 *
 * Every test here is one of the checks that would have caught a real incident:
 * a brief written about one checkout, handed to an agent running in another,
 * which edited real files for five hours and reported success. Nothing was
 * broken at the time — the code did exactly what it was told — so these are
 * about making the mismatch impossible to hold silently.
 */
describe("staying in the right tree", () => {
  const repos: string[] = [];

  /** A throwaway git work tree. `git init` and nothing else: everything under
   *  test asks only where the toplevel is. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentbox-repo-"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    repos.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  test("a relative cwd is refused rather than resolved against the server's own", async () => {
    await expect(pool.spawn({ prompt: "p", cwd: "../elsewhere" })).rejects.toThrow(
      /must be an absolute path/,
    );
  });

  test("a prompt naming another work tree is refused, and says both places", async () => {
    const here = repo();
    const there = repo();
    const stray = join(there, "types.ts");
    writeFileSync(stray, "export {};\n");
    const p = pool.spawn({ prompt: `Trim the comments in ${stray}`, cwd: here });
    await expect(p).rejects.toThrow(/different git work tree/);
    await expect(p).rejects.toThrow(new RegExp(here.replace(/[/\\]/g, "\\$&")));
    await expect(p).rejects.toThrow(new RegExp(there.replace(/[/\\]/g, "\\$&")));
  });

  test("a read-only agent may name anything — it cannot change it", async () => {
    const here = repo();
    const there = repo();
    const stray = join(there, "types.ts");
    writeFileSync(stray, "export {};\n");
    await expect(
      pool.spawn({ prompt: `Compare with ${stray}`, cwd: here, readOnly: true }),
    ).resolves.toBeDefined();
  });

  test("allowOutsideCwd is the way past it, for a task that really does span repos", async () => {
    const here = repo();
    const there = repo();
    const stray = join(there, "types.ts");
    writeFileSync(stray, "export {};\n");
    await expect(
      pool.spawn({ prompt: `Port ${stray} across`, cwd: here, allowOutsideCwd: true }),
    ).resolves.toBeDefined();
  });

  test("scratch paths and non-repo directories are not a mismatch", async () => {
    const here = repo();
    await expect(
      pool.spawn({ prompt: `Write the census to /tmp/out.json and read ${home}`, cwd: here }),
    ).resolves.toBeDefined();
  });

  test("the report says where it happened", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    only().say("done");
    only().endTurn();
    const r = await agent.settle(1000, 1);
    expect(r!.cwd).toBe(home);
  });

  test("a write outside the working directory is named at the top of the report", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agentbox-elsewhere-"));
    const stray = join(outside, "types.ts");
    writeFileSync(stray, "export {};\n");
    try {
      const agent = await pool.spawn({ prompt: "p", cwd: home });
      only().tool("t1", "Edit types.ts", true, "edit", { file_path: stray });
      only().say("cleaned it up");
      only().endTurn();
      const r = await agent.settle(1000, 1);
      expect(r!.wroteOutside).toEqual([stray]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a read outside the working directory is not worth a warning", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agentbox-elsewhere-"));
    const stray = join(outside, "types.ts");
    writeFileSync(stray, "export {};\n");
    try {
      const agent = await pool.spawn({ prompt: "p", cwd: home });
      only().tool("t1", "Read types.ts", true, "read", { file_path: stray });
      only().endTurn();
      const r = await agent.settle(1000, 1);
      expect(r!.wroteOutside).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the turn wall clock", () => {
  test("interrupts a turn that overruns, and says so rather than 'cancelled'", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home, maxTurnMs: 15 });
    await Bun.sleep(60);
    expect(only().interrupted).toBe(1);
    // What omp does when told to cancel; the agent has to turn that back into
    // something the caller can tell apart from its own `interrupt`.
    only().endTurn("cancelled");
    const r = await agent.settle(1000, 1);
    expect(r!.stopReason).toBe("deadline");
    expect(r!.errors.join(" ")).toMatch(/wall clock/);
    // The agent survives it: the whole point is that the caller can steer it
    // rather than pay to start again.
    expect(agent.state).toBe("idle");
  });

  test("does not fire on a turn that finishes", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home, maxTurnMs: 60 });
    only().say("quick");
    only().endTurn();
    const r = await agent.settle(1000, 1);
    expect(r!.stopReason).toBe("end_turn");
    await Bun.sleep(100);
    expect(only().interrupted).toBe(0);
  });
});

describe("the live roster", () => {
  test("a running agent has a line, and keeps it after its caller stops waiting", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    only().tool("t1", "Grep for callers");
    expect(renderAgentLine(agent)).toMatch(/Grep for callers/);
    // Nobody collected: the answer is the thing worth seeing from outside.
    only().say("the answer");
    only().endTurn();
    await Bun.sleep(5);
    expect(renderAgentLine(agent)).toMatch(/UNCOLLECTED/);
    await agent.settle(1000, 1);
    expect(renderAgentLine(agent)).toBeNull();
  });

  test("an idle agent owing nothing is not worth a row", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    only().endTurn();
    await agent.settle(1000, 1);
    expect(renderAgentLine(agent)).toBeNull();
  });

  test("workflow agents are quiet — the roster speaks for the whole fan-out", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home, quiet: true });
    expect(agent.quiet).toBe(true);
    expect(live.read().filter((l) => l.text.includes(agent.name))).toHaveLength(0);
  });

  test("elapsed time is said roughly, because roughly is what it is for", () => {
    expect(ago(4_000)).toBe("4s ago");
    expect(ago(90_000)).toBe("2m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
  });
});

describe("a failure wearing the costume of an answer", () => {
  test("a report that is only a provider error is called out, not passed on", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    // Exactly what `omp acp --model sonnet` hands back: a clean `end_turn`, no
    // errors, and a billing message where the answer should be.
    only().say("402 Insufficient credits. Add more using https://openrouter.ai/settings/credits");
    only().endTurn();
    const r = await agent.settle(1000, 1);
    expect(r!.stopReason).toBe("end_turn");
    expect(r!.errors.join(" ")).toMatch(/reads as a provider error/);
  });

  test("an ordinary answer is left alone", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    only().say("The 404 handler in src/server/index.ts does not set a content type.");
    only().endTurn();
    const r = await agent.settle(1000, 1);
    expect(r!.errors).toEqual([]);
  });
});

/**
 * The only channel into a calling model's context is the answer to a question
 * it asked. A blocked call is that channel held open, and spending all of it
 * on waiting means an agent can repeat one failing command for four hours
 * while the caller learns nothing until the end.
 */
describe("a wait that gives up on a stuck agent", () => {
  test("hands back the turn when there is one", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    only().say("the answer");
    only().endTurn();
    const r = await waitForTurn(agent, 1, 2000, { afterMs: 0, pollMs: 20 });
    expect("stuck" in r).toBe(false);
    expect((r as { report: string }).report).toBe("the answer");
  });

  test("ends early when the agent is going round in circles, and loses nothing", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    for (const id of ["t1", "t2", "t3"]) {
      only().tool(id, "Bash", true, "execute", { command: "bun test" });
    }
    const r = await waitForTurn(agent, 1, 5000, { afterMs: 0, pollMs: 10, confirms: 2 });
    expect("stuck" in r).toBe(true);
    expect((r as { stuck: { concern: string } }).stuck.concern).toBe("looping");
    // The agent is untouched and its answer still arrives, into the mailbox
    // this time. Breaking the wait must never be the same as losing the turn.
    expect(agent.state).toBe("running");
    only().say("done eventually");
    only().endTurn();
    await Bun.sleep(5);
    expect(agent.uncollected).toBe(1);
    expect((await agent.settle(500, 1))!.report).toBe("done eventually");
  });

  test("an agent merely being slow is waited for, not abandoned", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    only().tool("t1", "Bash", false, "execute", { command: "bun test" });
    const r = await waitForTurn(agent, 1, 300, { afterMs: 0, pollMs: 10, confirms: 2 });
    // Ran out of the (short) total wait rather than escalating: a long tool
    // call is working, not stuck.
    expect("stuck" in r).toBe(true);
    expect((r as { stuck: { escalate: boolean } }).stuck.escalate).toBe(false);
  });

  /** A cancelled call has nobody left to hand a report to. Taking the turn
   *  anyway would lose it; leaving it in the mailbox keeps it for `collect`. */
  test("a caller that hangs up leaves the turn in the mailbox", async () => {
    const agent = await pool.spawn({ prompt: "p", cwd: home });
    const hangUp = new AbortController();
    const waiting = waitForTurn(agent, 1, 5000, { pollMs: 1000, signal: hangUp.signal });
    await Bun.sleep(5);
    hangUp.abort();
    expect("stuck" in (await waiting)).toBe(true);
    only().say("nobody was listening");
    only().endTurn();
    expect(agent.uncollected).toBe(1);
  });
});

describe("did my message land", () => {
  /** An answer handed to a call can still go missing on the caller's side.
   *  Re-reading must work after delivery, and must not count as collecting. */
  test("an answer already handed back can be read again", async () => {
    const agent = await pool.spawn({ prompt: "one", cwd: home });
    only().say("first answer");
    only().endTurn();
    expect((await agent.settle(50, 1))!.report).toBe("first answer");
    expect(agent.handedBackAt(1)).not.toBeNull();
    expect(agent.reread(1)!.report).toBe("first answer");
    expect(agent.reread()!.turn).toBe(1);

    agent.send("two");
    only().say("second answer");
    only().endTurn();
    expect(agent.reread(2)!.report).toBe("second answer");
    expect(agent.handedBackAt(2)).toBeNull();
    expect(agent.uncollected).toBe(1);
  });

  test("each message says whether it is queued, running or answered", async () => {
    const agent = await pool.spawn({ prompt: "one", cwd: home });
    agent.send("two");
    agent.send("three");
    expect(agent.conversation().map((t) => t.status)).toEqual(["running", "queued", "queued"]);

    only().tool("t1", "reading");
    only().say("done one");
    only().endTurn();
    await agent.settle(50, 1);
    const turns = agent.conversation();
    expect(turns.map((t) => t.status)).toEqual(["answered", "running", "queued"]);
    expect(turns[0]!.handedBackAt).not.toBeNull();
    expect(turns[0]!.toolCalls).toBe(1);
    expect(turns[1]!.message).toBe("two");

    only().endTurn();
    only().endTurn();
    const last = agent.conversation();
    expect(last.map((t) => t.status)).toEqual(["answered", "answered", "answered"]);
    // Answered but never picked up.
    expect(last[2]!.handedBackAt).toBeNull();
  });
});

describe("parking an idle agent", () => {
  /** Far enough past the last answer that any idle agent qualifies. */
  const later = () => Date.now() + IDLE_PARK_MS + 1;

  async function answered(name = "scout") {
    const agent = await pool.spawn({ prompt: "look around", name });
    const first = only();
    first.say("found it");
    first.endTurn();
    expect((await agent.settle(50, 1))?.report).toBe("found it");
    return { agent, first };
  }

  /** Let a wake's launch resolve. */
  const launchSettles = () => Bun.sleep(5);

  test("stops omp once the idle window has passed, and not before", async () => {
    const { agent, first } = await answered();
    expect(agent.maybePark(Date.now() + IDLE_PARK_MS - 1_000)).toBe(false);
    expect(first.killed).toBe(0);

    expect(agent.maybePark(later())).toBe(true);
    expect(first.killed).toBe(1);
    expect(agent.state).toBe("idle");
    expect(agent.alive).toBe(true);
  });

  test("the stopped process's exit does not kill the agent", async () => {
    const { agent, first } = await answered();
    agent.maybePark(later());
    first.events.onError(first.id, "ACP connection closed");
    first.events.onExit(first.id, 143);
    await Bun.sleep(1);
    expect(agent.state).toBe("idle");
    expect(agent.snapshot().endedReason).toBeNull();
  });

  test("a message resumes the same conversation in a new process", async () => {
    const { agent, first } = await answered();
    agent.maybePark(later());

    const turn = agent.send("and then?");
    expect(turn).toBe(2);
    expect(agent.state).toBe("running");
    await launchSettles();

    const second = only();
    expect(second).not.toBe(first);
    expect(second.launched?.resumeSessionId).toBe("omp-session-1");
    expect(second.sent).toEqual(["and then?"]);
    expect(first.sent).toEqual(["look around"]);

    second.say("more");
    second.endTurn();
    const r = await agent.settle(50, 2);
    expect(r?.report).toBe("more");
    expect(r?.state).toBe("idle");
    // What came before the park is still there to re-read.
    expect(agent.reread(1)?.report).toBe("found it");
  });

  test("messages sent while omp comes back arrive in order", async () => {
    const { agent } = await answered();
    agent.maybePark(later());
    expect(agent.send("one")).toBe(2);
    expect(agent.send("two")).toBe(3);
    await launchSettles();
    expect(only().sent).toEqual(["one", "two"]);
  });

  test("parks an agent holding an uncollected answer, and the answer survives", async () => {
    const agent = await pool.spawn({ prompt: "look around", name: "unread" });
    only().say("unread answer");
    only().endTurn();
    expect(agent.uncollected).toBe(1);
    expect(agent.maybePark(later())).toBe(true);
    expect((await agent.settle(50, 1))?.report).toBe("unread answer");
  });

  test("never parks with a turn in flight", async () => {
    const agent = await pool.spawn({ prompt: "work", name: "busy" });
    expect(agent.state).toBe("running");
    expect(agent.maybePark(later())).toBe(false);
    expect(only().killed).toBe(0);
  });

  test("a resume that fails is reported as a death, with the reason", async () => {
    let launches = 0;
    pool = new SubagentPool(home, (id, events, autoApprove) => {
      const f = new FakeRunner(id, events, autoApprove);
      if (++launches > 1) {
        f.launch = async () => {
          throw new Error("no session omp-session-1");
        };
      }
      fakes.push(f);
      return f;
    });
    const { agent } = await answered("fragile");
    agent.maybePark(later());
    agent.send("still there?");
    const r = await agent.settle(1_000, 2);
    expect(r?.state).toBe("dead");
    expect(r?.stopReason).toBe("died");
    expect(r?.errors.join("\n")).toContain("no session omp-session-1");
    expect(agent.state).toBe("dead");
  });

  test("interrupting while omp comes back cancels the message instead of sending it", async () => {
    const { agent } = await answered();
    agent.maybePark(later());
    agent.send("never mind this");
    expect(agent.interrupt()).toBe(true);
    const r = await agent.settle(50, 2);
    expect(r?.stopReason).toBe("cancelled");
    expect(agent.state).toBe("idle");
    await launchSettles();
    expect(only().sent).toEqual([]);
  });
});
