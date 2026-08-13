import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../sessions";

const dirs: string[] = [];

function logPath(name = "events.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-log-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("EventLog seq", () => {
  test("numbers from 1, monotonically, and stamps a timestamp", () => {
    const log = new EventLog(logPath());
    const a = log.append({ type: "user", text: "go", from: "human" });
    const b = log.append({ type: "assistant", text: "on it" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts).toBeGreaterThan(0);
    expect(log.lastSeq).toBe(2);
  });

  test("an empty log has nothing and no sequence", () => {
    const log = new EventLog(logPath());
    expect(log.since(0)).toEqual([]);
    expect(log.lastSeq).toBe(0);
  });
});

describe("EventLog since", () => {
  test("returns strictly what the caller has not seen", () => {
    const log = new EventLog(logPath());
    for (let i = 0; i < 5; i++) log.append({ type: "assistant", text: `m${i}` });

    expect(log.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.since(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(log.since(5)).toEqual([]);
    // A client ahead of the server (log rebuilt under it) gets nothing, not junk.
    expect(log.since(99)).toEqual([]);
  });

  test("serves reads from beyond the in-memory ring out of the JSONL", () => {
    const path = logPath();
    const log = new EventLog(path);
    const total = 2_500; // deliberately past RING_SIZE
    for (let i = 1; i <= total; i++) log.append({ type: "assistant", text: `m${i}` });

    const all = log.since(0);
    expect(all.length).toBe(total);
    expect(all[0]!.seq).toBe(1);
    expect(all[total - 1]!.seq).toBe(total);

    // A recent read is the common case and must still be exact.
    expect(log.since(total - 3).map((e) => e.seq)).toEqual([total - 2, total - 1, total]);
  });
});

describe("EventLog persistence", () => {
  test("a reopened log keeps counting where the file left off", () => {
    const path = logPath();
    const first = new EventLog(path);
    first.append({ type: "user", text: "go", from: "human" });
    first.append({ type: "turn", stopReason: "end_turn" });

    const second = new EventLog(path);
    expect(second.lastSeq).toBe(2);
    const next = second.append({ type: "assistant", text: "back" });
    expect(next.seq).toBe(3);
    expect(second.since(0).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("round-trips every event shape, including a whole tool call", () => {
    const path = logPath();
    const written = new EventLog(path).append({
      type: "tool",
      call: {
        id: "call-1",
        kind: "execute",
        title: "Run the tests",
        input: { command: "bun test" },
        status: "ok",
        locations: ["/w/a.ts"],
        output: "12 pass",
        startedAt: 1,
        endedAt: 2,
      },
    });
    expect(new EventLog(path).since(0)).toEqual([written]);
  });

  test("the bulky raw payload goes to the file but not into the event", () => {
    const path = logPath();
    const log = new EventLog(path);
    const event = log.append({ type: "error", message: "boom" }, { details: "x".repeat(20_000) });
    expect(event).not.toHaveProperty("raw");

    const line = JSON.parse(readFileSync(path, "utf8").trim());
    expect(line.event).toEqual(event);
    expect(line.raw.details.length).toBe(20_000);
  });

  test("a log the old build wrote reports itself instead of reading as empty", () => {
    const path = logPath();
    // Two lines in the pre-rework format: `event` is a bare string, not an object.
    appendFileSync(path, '{"ts":1,"event":"user","text":"go"}\n');
    appendFileSync(path, '{"ts":2,"event":"chunk","role":"assistant","text":"working"}\n');

    const log = new EventLog(path);
    const events = log.since(0);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("error");
    expect(events[0]!).toMatchObject({ seq: 1 });
    expect((events[0] as { message: string }).message).toContain("2 unreadable lines");

    // Written once: reopening parses the notice, so the branch cannot re-fire
    // and stack a second copy on every visit.
    const reopened = new EventLog(path);
    expect(reopened.since(0).length).toBe(1);
    expect(reopened.append({ type: "assistant", text: "new" }).seq).toBe(2);
  });

  test("an empty log stays empty — the notice is for lost history, not no history", () => {
    const path = logPath();
    appendFileSync(path, "");
    expect(new EventLog(path).since(0)).toEqual([]);
  });

  test("a torn or foreign line is skipped, not fatal", () => {
    const path = logPath();
    const log = new EventLog(path);
    log.append({ type: "assistant", text: "one" });
    appendFileSync(path, '{"event":{"seq":2,"ts":1,"type":"assis');           // crash mid-write
    appendFileSync(path, '\n{"ts":1,"event":"chunk","text":"old format"}\n'); // pre-rework log

    const reopened = new EventLog(path);
    expect(reopened.since(0).map((e) => e.type)).toEqual(["assistant"]);
    expect(reopened.append({ type: "assistant", text: "two" }).seq).toBe(2);
  });
});
