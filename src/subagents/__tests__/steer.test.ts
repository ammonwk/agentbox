import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentboxSteer, { SteerRelay, type SteerReply } from "../../omp/steer";
import { SteerLink, type SteerOutcome } from "../steer-link";
import { nextPrompt, type Outgoing } from "../acp";

/** A relay whose omp queue and runner socket are arrays. */
function relay(enqueue?: (text: string) => void) {
  const enqueued: string[] = [];
  const replies: SteerReply[] = [];
  const r = new SteerRelay(
    enqueue ?? ((t) => void enqueued.push(t)),
    (x) => void replies.push(x),
  );
  return { r, enqueued, replies };
}

/**
 * The relay decides the one thing that can go quietly wrong: a steer queued
 * after omp's last read of its queue strands there, outside any run agentbox
 * knows about. Every path either queues during a tool call or hands the
 * message back.
 */
describe("when the extension may queue a steer", () => {
  test("with no run in progress, it hands the message back to go as a prompt", () => {
    const { r, enqueued, replies } = relay();
    r.request(1, "hi");
    expect(enqueued).toEqual([]);
    expect(replies).toEqual([{ t: "idle", id: 1 }]);
  });

  test("during a tool call it queues, and reports the message once the agent has read it", () => {
    const { r, enqueued, replies } = relay();
    r.agentStart();
    r.toolStart("wait-1");
    r.request(1, "stop editing router.ts");
    expect(enqueued).toEqual(["stop editing router.ts"]);
    expect(replies).toEqual([{ t: "queued", id: 1 }]);

    r.toolEnd("wait-1");
    r.injected("stop editing router.ts");
    expect(replies).toEqual([
      { t: "queued", id: 1 },
      { t: "delivered", id: 1 },
    ]);
  });

  test("while the model is writing, it holds the message for the next tool call", () => {
    const { r, enqueued, replies } = relay();
    r.agentStart();
    r.request(1, "also check the tests");
    expect(enqueued).toEqual([]);
    expect(replies).toEqual([]);

    r.toolStart("c1");
    expect(enqueued).toEqual(["also check the tests"]);
    expect(replies).toEqual([{ t: "queued", id: 1 }]);
  });

  test("a message still held when the run ends is handed back, not stranded on omp's queue", () => {
    const { r, enqueued, replies } = relay();
    r.agentStart();
    r.toolStart("c1");
    r.toolEnd("c1");
    // The final answer is being written: no tool call left to carry it.
    r.request(1, "one more thing");
    r.agentEnd();
    expect(enqueued).toEqual([]);
    expect(replies).toEqual([{ t: "idle", id: 1 }]);
  });

  test("an ended run forgets a tool call whose end never arrived", () => {
    const { r, enqueued, replies } = relay();
    r.agentStart();
    r.toolStart("c1");
    r.agentEnd(); // aborted mid-call
    r.request(1, "hello?");
    expect(enqueued).toEqual([]);
    expect(replies).toEqual([{ t: "idle", id: 1 }]);
  });

  test("identical messages are matched oldest first; text it did not queue is ignored", () => {
    const { r, replies } = relay();
    r.agentStart();
    r.toolStart("c1");
    r.request(1, "again");
    r.request(2, "again");
    r.injected("an async job result omp injected");
    expect(replies).toHaveLength(2);
    r.injected("again");
    expect(replies.at(-1)).toEqual({ t: "delivered", id: 1 });
    r.injected("again");
    expect(replies.at(-1)).toEqual({ t: "delivered", id: 2 });
  });

  test("a queue that refuses the message hands it back", () => {
    const { r, replies } = relay(() => {
      throw new Error("agent busy");
    });
    r.agentStart();
    r.toolStart("c1");
    r.request(1, "x");
    expect(replies).toEqual([{ t: "idle", id: 1 }]);
  });
});

describe("the steer socket, both ends", () => {
  let dir: string;
  let link: SteerLink;
  let outcomes: SteerOutcome[];
  let dropped: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentbox-steer-"));
    outcomes = [];
    dropped = [];
    const path = join(dir, "steer.sock");
    link = new SteerLink(path, (r) => void outcomes.push(r), (s) => void dropped.push(s));
    process.env.AGENTBOX_STEER_SOCKET = path;
  });

  afterEach(() => {
    link.close();
    delete process.env.AGENTBOX_STEER_SOCKET;
    rmSync(dir, { recursive: true, force: true });
  });

  type Ctx = { sessionManager: { getSessionId(): string } };
  type Handler = (event: Record<string, unknown>, ctx: Ctx) => void;

  /** The real extension, loaded the way omp loads it, with omp's side faked:
   *  events are fired at it by hand and its steers land in an array. */
  function fakeOmp(session: string) {
    const handlers = new Map<string, Handler>();
    const steered: string[] = [];
    const ctx: Ctx = { sessionManager: { getSessionId: () => session } };
    agentboxSteer({
      on: (event, h) => void handlers.set(event, h),
      sendUserMessage: (text, options) => {
        expect(options).toEqual({ deliverAs: "steer" });
        steered.push(text);
      },
    });
    const fire = (event: string, e: Record<string, unknown> = {}) => handlers.get(event)?.(e, ctx);
    return { fire, steered, handlers };
  }

  async function until(cond: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(5);
    }
  }

  test("a steer reaches the agent mid-tool-call, and both outcomes come back", async () => {
    const omp = fakeOmp("omp-1");
    omp.fire("session_start");
    omp.fire("agent_start");
    omp.fire("tool_execution_start", { toolCallId: "wait-1" });
    // Retried until the hello has crossed; the first `true` is the one send.
    await until(() => link.send("omp-1", { t: "steer", id: 7, text: "why 39 subagents?" }));
    await until(() => outcomes.length === 1);
    expect(omp.steered).toEqual(["why 39 subagents?"]);
    expect(outcomes).toEqual([{ t: "queued", id: 7 }]);

    omp.fire("message_end", {
      message: { role: "user", steering: true, content: [{ type: "text", text: "why 39 subagents?" }] },
    });
    await until(() => outcomes.length === 2);
    expect(outcomes[1]).toEqual({ t: "delivered", id: 7 });
  });

  test("only the runner's own session is written to", async () => {
    // A subagent omp runs in-process loads its own copy and says hello too.
    const sub = fakeOmp("sub-1");
    sub.fire("session_start");
    sub.fire("agent_start");
    sub.fire("tool_execution_start", { toolCallId: "c" });
    const omp = fakeOmp("omp-1");
    omp.fire("session_start");
    omp.fire("agent_start");
    omp.fire("tool_execution_start", { toolCallId: "c" });

    await until(() => link.send("omp-1", { t: "steer", id: 1, text: "hello" }));
    await until(() => outcomes.length === 1);
    expect(omp.steered).toEqual(["hello"]);
    expect(sub.steered).toEqual([]);
    expect(link.send("nobody", { t: "steer", id: 2, text: "x" })).toBe(false);
  });

  test("a closed connection is reported for the session it served", async () => {
    const omp = fakeOmp("omp-1");
    omp.fire("session_start");
    await until(() => link.send("omp-1", { t: "steer", id: 1, text: "ping" }));
    omp.fire("session_shutdown");
    await until(() => dropped.length === 1);
    expect(dropped).toEqual(["omp-1"]);
  });

  test("with no socket named, the extension does nothing at all", () => {
    delete process.env.AGENTBOX_STEER_SOCKET;
    expect(fakeOmp("omp-1").handlers.size).toBe(0);
  });
});

describe("the prompt queue", () => {
  test("steers waiting together go as one prompt, in order, reporting every ref", () => {
    const q: Outgoing[] = [
      { text: "a", refs: [1], steer: true },
      { text: "b", refs: [2], steer: true },
      { text: "resume", refs: [], steer: false },
      { text: "c", refs: [3], steer: true },
    ];
    expect(nextPrompt(q)).toEqual({ text: "a\n\nb", refs: [1, 2] });
    expect(nextPrompt(q)).toEqual({ text: "resume", refs: [] });
    expect(nextPrompt(q)).toEqual({ text: "c", refs: [3] });
    expect(nextPrompt(q)).toBeNull();
  });

  test("a send is always a turn of its own — the subagent pool counts on it", () => {
    const q: Outgoing[] = [
      { text: "a", refs: [], steer: false },
      { text: "b", refs: [], steer: false },
    ];
    expect(nextPrompt(q)?.text).toBe("a");
    expect(nextPrompt(q)?.text).toBe("b");
  });
});
