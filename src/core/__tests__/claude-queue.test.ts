import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReader } from "../providers/claude";
import { strandedNudge, strandedNudgeAfter } from "../park";

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

  test("comes at 55 minutes, or five before parking when that is sooner", () => {
    expect(strandedNudgeAfter(60)).toBe(55 * 60_000);
    expect(strandedNudgeAfter(0)).toBe(55 * 60_000);
    expect(strandedNudgeAfter(30)).toBe(25 * 60_000);
    expect(strandedNudgeAfter(3)).toBe(60_000);
  });
});
