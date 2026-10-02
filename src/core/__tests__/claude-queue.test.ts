import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReader } from "../providers/claude";

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

async function queued(records: string): Promise<string[]> {
  const path = join(dir, `${SESSION}-${n}.jsonl`);
  writeFileSync(path, records);
  const r = claudeReader({ provider: "claude", accountId: "acct", agentSessionId: SESSION, path, mtimeMs: 0, size: 0 });
  const { facts } = await r.refresh();
  return (facts.queued ?? []).map((q) => q.text);
}

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
});
