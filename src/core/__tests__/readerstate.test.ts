import { afterAll, describe, expect, test } from "bun:test";
import { deserialize, serialize } from "bun:jsc";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReader } from "../providers/claude";
import { loadFields, saveFields } from "../providers/foldstate";
import { PrRepoFold } from "../prrepo";
import type { TranscriptRef } from "../providers/types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-readerstate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESSION = "11111111-2222-3333-4444-555555555555";
let n = 0;
const at = () => new Date(Date.UTC(2026, 8, 30, 12, 0, n++)).toISOString();
const line = (r: object) => `${JSON.stringify(r)}\n`;
const user = (text: string) => line({ type: "user", sessionId: SESSION, cwd: "/w", uuid: `u${n}`, timestamp: at(), message: { role: "user", content: text } });
const assistant = (id: string, text: string, tool?: string) =>
  line({
    type: "assistant",
    sessionId: SESSION,
    cwd: "/w",
    uuid: `a${n}`,
    timestamp: at(),
    message: {
      id,
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text }, ...(tool ? [{ type: "tool_use", id: tool, name: "Bash", input: { command: "ls" } }] : [])],
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    },
  });
const result = (tool: string) =>
  line({ type: "user", sessionId: SESSION, cwd: "/w", uuid: `r${n}`, timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "a b c" }] } });

function refFor(path: string): TranscriptRef {
  return { provider: "claude", accountId: "acct", agentSessionId: SESSION, path, mtimeMs: 0, size: 0 };
}

/** Facts and the newest page as plain data, to compare two readers. */
async function snapshot(path: string, saved?: unknown) {
  const r = claudeReader(refFor(path));
  const restored = saved === undefined ? null : r.loadState!(saved);
  const { facts } = await r.refresh();
  const page = await r.timeline({ limit: 100 });
  return { restored, facts: JSON.parse(JSON.stringify(facts)), events: JSON.parse(JSON.stringify(page.events)) };
}

/** Read `path` as it is now and return its reader's state, as a restart would see it. */
async function saveNow(path: string): Promise<unknown> {
  const r = claudeReader(refFor(path));
  await r.refresh();
  return deserialize(serialize(r.saveState!()));
}

describe("reader state across a restart", () => {
  test("a restored reader reads only what was appended and ends where a full read does", async () => {
    const path = join(dir, "project", `${SESSION}.jsonl`);
    const subs = join(dir, "project", SESSION, "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(path, user("fix the bug") + assistant("m1", "looking", "t1") + result("t1"));
    writeFileSync(join(subs, "agent-a.jsonl"), assistant("s1", "sub work"));
    const saved = await saveNow(path);

    // While it was down: the call's turn went on, a subagent wrote more.
    appendFileSync(path, assistant("m2", "found it", "t2") + result("t2") + user("thanks") + assistant("m3", "done"));
    appendFileSync(join(subs, "agent-a.jsonl"), assistant("s2", "more sub work"));
    writeFileSync(join(subs, "agent-b.jsonl"), assistant("s3", "another agent"));

    const fresh = await snapshot(path);
    const resumed = await snapshot(path, saved);
    expect(resumed.restored).toBe(true);
    expect(resumed.facts).toEqual(fresh.facts);
    expect(resumed.events).toEqual(fresh.events);
    expect(fresh.facts.lastPrompt).toBe("thanks");
    // Main file's three messages plus three subagent messages.
    expect(fresh.facts.tokens.output).toBe(60);
  });

  test("a file rewritten in place, cut short or replaced is read from the start", async () => {
    const path = join(dir, "rewrite.jsonl");
    writeFileSync(path, user("one") + assistant("m1", "reply one"));
    const saved = await saveNow(path);

    const same = readFileSync(path, "utf8").replace("reply one", "reply 1!!");
    writeFileSync(path, same);
    expect((await snapshot(path, saved)).restored).toBe(false);

    const cutFrom = await saveNow(path);
    writeFileSync(path, user("one"));
    expect((await snapshot(path, cutFrom)).restored).toBe(false);

    const replacedFrom = await saveNow(path);
    const other = join(dir, "other.jsonl");
    writeFileSync(other, readFileSync(path));
    renameSync(other, path);
    expect((await snapshot(path, replacedFrom)).restored).toBe(false);
  });

  test("a refused state leaves the reader to read the whole file", async () => {
    const path = join(dir, "refused.jsonl");
    writeFileSync(path, user("hello") + assistant("m1", "hi"));
    const saved = await saveNow(path);
    writeFileSync(path, user("HELLO") + assistant("m1", "hi"));
    const r = await snapshot(path, saved);
    expect(r.restored).toBe(false);
    expect(r.facts.firstPrompt).toBe("HELLO");
  });
});

describe("fold state", () => {
  test("a nested fold comes back as its own class, with its data", () => {
    class Outer {
      count = 0;
      seen = new Map<string, number>();
      repos = new PrRepoFold();
      constructor(readonly ref: { path: string }) {}
    }
    const a = new Outer({ path: "/a" });
    a.count = 3;
    a.seen.set("x", 1);
    a.repos.add("see https://github.com/acme/widgets/pull/12");
    const saved = deserialize(serialize(saveFields(a, ["ref"])));

    const b = new Outer({ path: "/b" });
    loadFields(b, saved);
    expect(b.count).toBe(3);
    expect(b.seen.get("x")).toBe(1);
    expect(b.repos).toBeInstanceOf(PrRepoFold);
    expect(b.repos.repo).toBe("acme/widgets");
    expect(b.ref.path).toBe("/b");
  });
});
