import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReader } from "../providers/claude";
import { limitStop, strandedNudge, strandedNudgeAfter } from "../park";

const dir = mkdtempSync(join(tmpdir(), "agentbox-claude-queue-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESSION = "11111111-2222-3333-4444-666666666666";
let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 2, 12, 0, n++)).toISOString();
const line = (r: object) => `${JSON.stringify(r)}\n`;
const queue = (operation: string, content?: string) => line({ type: "queue-operation", operation, timestamp: at(), sessionId: SESSION, ...(content === undefined ? {} : { content }) });
const meta = (content: string) => line({ type: "user", isMeta: true, sessionId: SESSION, uuid: `u${n}`, timestamp: at(), message: { role: "user", content } });
const assistant = (id: string) =>
  line({ type: "assistant", sessionId: SESSION, uuid: `a${n}`, timestamp: at(), message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } });

async function factsOf(records: string) {
  const path = join(dir, `${SESSION}-${n}.jsonl`);
  writeFileSync(path, records);
  const r = claudeReader({ provider: "claude", accountId: "acct", agentSessionId: SESSION, path, mtimeMs: 0, size: 0 });
  return (await r.refresh()).facts;
}
const queued = async (records: string): Promise<string[]> => ((await factsOf(records)).queued ?? []).map((q) => q.text);
const stranded = async (records: string): Promise<string[]> => ((await factsOf(records)).stranded ?? []).map((q) => q.text);
/** A model call that ends the turn. */
const answer = (id: string) =>
  line({
    type: "assistant",
    sessionId: SESSION,
    uuid: `a${n}`,
    timestamp: at(),
    message: { id, role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Waiting on CI." }] },
  });

const LOOP = "Check progress of the release audit.";
const NOTE = "<task-notification>\n<task-id>b1</task-id>\n</task-notification>";
const PEER = '<agent-message from="fr-pass">\nfr-pass: done\n</agent-message>';

describe("Claude's queue", () => {
  test("a message taken ahead of an older one is gone once delivered", async () => {
    // A notification waits; a peer's message jumps it, and the notification
    // is delivered mid-turn by name. Then a /loop wakeup comes and goes.
    const records =
      queue("enqueue", NOTE) +
      queue("enqueue", PEER) +
      queue("dequeue") +
      meta(`Another Claude session sent a message:\n${PEER}\nReply with SendMessage.`) +
      assistant("m1") +
      queue("remove", NOTE) +
      assistant("m2") +
      queue("enqueue", LOOP) +
      queue("dequeue") +
      meta(LOOP);
    expect(await queued(records)).toEqual([]);
  });

  test("a dequeue no record names takes the oldest", async () => {
    const records = queue("enqueue", "first") + queue("enqueue", "second") + queue("dequeue") + assistant("m1");
    expect(await queued(records)).toEqual(["second"]);
  });

  test("a notification queued after the turn ended and never taken is stranded", async () => {
    expect(await stranded(answer("m1") + queue("enqueue", NOTE))).toEqual([NOTE]);
  });

  test("a teammate's notification the lead's later turns never took is stranded until the nudge", async () => {
    // A teammate's build finishes; another teammate then wakes the lead, which
    // answers and ends its turn with the notification still queued.
    const waiting = queue("enqueue", NOTE) + queue("enqueue", PEER) + queue("dequeue") + meta(`Another Claude session sent a message:\n${PEER}`) + answer("m1") + line({ type: "system", subtype: "turn_duration", sessionId: SESSION, uuid: "s", timestamp: at() });
    expect(await stranded(waiting)).toEqual([NOTE]);
    const nudge = line({ type: "user", sessionId: SESSION, uuid: "n", timestamp: at(), message: { role: "user", content: strandedNudge([{ text: NOTE }]) } });
    expect(await stranded(waiting + nudge + answer("m2"))).toEqual([]);
  });

  test("a notification that was taken is not", async () => {
    // Taken: the turn it starts is open.
    expect(await stranded(answer("m1") + queue("enqueue", NOTE) + queue("dequeue") + line({ type: "user", sessionId: SESSION, uuid: "u", timestamp: at(), message: { role: "user", content: NOTE } }))).toEqual([]);
    // Delivered by name with no dequeue.
    expect(await stranded(answer("m1") + queue("enqueue", NOTE) + line({ type: "user", sessionId: SESSION, uuid: "u", timestamp: at(), message: { role: "user", content: NOTE } }) + answer("m2"))).toEqual([]);
    // Removed mid-turn.
    expect(await stranded(queue("enqueue", NOTE) + queue("remove", NOTE) + answer("m1"))).toEqual([]);
    // A message is not a notification.
    expect(await stranded(answer("m1") + queue("enqueue", "hello"))).toEqual([]);
  });
});

describe("the nudge for stranded notifications", () => {
  test("names what finished and where its output is", () => {
    const note = "<task-notification>\n<task-id>b1</task-id>\n<output-file>/tmp/tasks/b1.output</output-file>\n<status>completed</status>\n<summary>Background command \"Wait for PR checks\" completed (exit code 0)</summary>\n</task-notification>";
    const text = strandedNudge([{ text: note }]);
    expect(text).toContain('- Background command "Wait for PR checks" completed (exit code 0) (output: /tmp/tasks/b1.output)');
    expect(text.startsWith("[agentbox: a background task finished")).toBe(true);
  });

  test("is not sent to a session whose last try hit a usage limit", () => {
    // Stopped at the limit, with a notification queued after it.
    expect(limitStop({ rateLimitHits: [{ at: 2_000 }], lastTurnAt: 1_000 })).not.toBeNull();
    expect(limitStop({ rateLimitHits: [{ at: 2_000 }], lastTurnAt: null })).not.toBeNull();
    // Continued since: a model call answered after the hit.
    expect(limitStop({ rateLimitHits: [{ at: 2_000 }], lastTurnAt: 3_000 })).toBeNull();
    expect(limitStop({ rateLimitHits: [], lastTurnAt: 3_000 })).toBeNull();
  });

  // 2026-10-11: d8sujmmi met its weekly limit on a monitor event while it
  // waited on CI, and more events were queued behind it for seven minutes.
  // The board took the hit for answered a minute after the first, so the
  // session was never offered its move to an account with room.
  test("a limit hit is still where the session stopped, whatever was queued behind it", () => {
    const hit = { at: 2_000, detail: "You've hit your weekly limit" };
    expect(limitStop({ rateLimitHits: [hit], lastTurnAt: 1_000, lastActivityAt: 2_000 + 7 * 60_000 })).toBe(hit);
    expect(limitStop({ rateLimitHits: [hit], lastTurnAt: 3_000, lastActivityAt: 3_000 })).toBeNull();
    // A transcript that does not say when the model last answered: the hit must be its last word.
    expect(limitStop({ rateLimitHits: [hit], lastActivityAt: 2_500 })).toBe(hit);
    expect(limitStop({ rateLimitHits: [hit], lastActivityAt: 2_000 + 7 * 60_000 })).toBeNull();
  });

  test("comes at 55 minutes, or five before parking when that is sooner", () => {
    expect(strandedNudgeAfter(60)).toBe(55 * 60_000);
    expect(strandedNudgeAfter(0)).toBe(55 * 60_000);
    expect(strandedNudgeAfter(30)).toBe(25 * 60_000);
    expect(strandedNudgeAfter(3)).toBe(60_000);
  });
});

// Adopting or parking stops the process, and a workflow runs inside it: one
// missed here is lost work, as a babysitting workflow was to an adopt.
describe("background work still running", () => {
  const launch = (toolUseId: string, taskId: string, workflowName: string) =>
    line({
      type: "assistant",
      sessionId: SESSION,
      uuid: `a${n}`,
      timestamp: at(),
      message: { id: `m${n}`, role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolUseId, name: "Workflow", input: {} }] },
    }) +
    line({
      type: "user",
      sessionId: SESSION,
      uuid: `u${n}`,
      timestamp: at(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Workflow launched in background." }] },
      toolUseResult: { status: "async_launched", taskId, taskType: "local_workflow", workflowName },
    });
  const note = (taskId: string, status: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`;
  const names = async (records: string) => ((await factsOf(records)).backgroundTasks ?? []).map((t) => t.name);

  test("a launched workflow runs on after the turn ends", async () => {
    expect(await names(launch("t1", "w1", "babysit-fleet") + answer("m1"))).toEqual(["babysit-fleet"]);
  });

  test("its notification ends it, queued or delivered", async () => {
    expect(await names(launch("t1", "w1", "babysit-fleet") + answer("m1") + queue("enqueue", note("w1", "completed")))).toEqual([]);
    expect(await names(launch("t1", "w1", "babysit-fleet") + answer("m1") + line({ type: "user", sessionId: SESSION, uuid: `u${n}`, timestamp: at(), message: { role: "user", content: note("w1", "failed") } }))).toEqual([]);
  });

  test("another task's notification does not", async () => {
    expect(await names(launch("t1", "w1", "babysit-fleet") + answer("m1") + queue("enqueue", note("b9", "completed")))).toEqual(["babysit-fleet"]);
  });
});
