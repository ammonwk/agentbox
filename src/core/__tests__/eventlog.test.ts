import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../sessions";

/**
 * A live session's log is written by its host process and read by the server.
 * These are the cases where a reader that trusted its own in-memory copy would
 * quietly serve a transcript frozen at the moment the server started.
 */
describe("EventLog across processes", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentbox-log-"));
    path = join(dir, "s.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Stands in for the host: appends without going through the reader. */
  const write = (seq: number, text: string) =>
    appendFileSync(path, JSON.stringify({ event: { seq, ts: 1, type: "assistant", text } }) + "\n");

  test("a reader picks up lines another writer appended", () => {
    write(1, "first");
    const reader = new EventLog(path);
    expect(reader.since(0)).toHaveLength(1);

    write(2, "second");
    write(3, "third");

    const fresh = reader.since(1);
    expect(fresh.map((e) => e.seq)).toEqual([2, 3]);
  });

  test("lastSeq tracks another writer, so cursors do not stall", () => {
    write(1, "a");
    const reader = new EventLog(path);
    expect(reader.lastSeq).toBe(1);
    write(2, "b");
    expect(reader.lastSeq).toBe(2);
  });

  test("a half-written trailing line is not consumed until it is complete", () => {
    write(1, "done");
    const reader = new EventLog(path);
    expect(reader.since(0)).toHaveLength(1);

    // The writer is mid-append: valid prefix, no newline yet.
    appendFileSync(path, '{"event":{"seq":2,"ts":1,"type":"assistant","text":"par');
    expect(reader.since(1)).toEqual([]);

    // It finishes the line.
    appendFileSync(path, 'tial"}}\n');
    const got = reader.since(1);
    expect(got).toHaveLength(1);
    expect((got[0] as { text: string }).text).toBe("partial");
  });

  test("multi-byte characters across a read boundary survive intact", () => {
    const reader = new EventLog(path);
    reader.since(0);
    write(1, "héllo — ünicode ✓");
    write(2, "日本語のテキスト");
    expect(reader.since(0).map((e) => (e as { text: string }).text)).toEqual([
      "héllo — ünicode ✓",
      "日本語のテキスト",
    ]);
  });

  test("a truncated log resets rather than serving stale events", () => {
    write(1, "old");
    write(2, "older");
    const reader = new EventLog(path);
    expect(reader.since(0)).toHaveLength(2);

    // A fresh, shorter log at the same path.
    writeFileSync(path, JSON.stringify({ event: { seq: 1, ts: 1, type: "assistant", text: "new" } }) + "\n");
    const got = reader.since(0);
    expect(got).toHaveLength(1);
    expect((got[0] as { text: string }).text).toBe("new");
  });

  test("a writer's own appends still number correctly after reading", () => {
    write(1, "from the host");
    const log = new EventLog(path);
    log.since(0);
    const appended = log.append({ type: "assistant", text: "mine" });
    // Continues the file's numbering rather than restarting at 1.
    expect(appended.seq).toBe(2);
    expect(new EventLog(path).since(0).map((e) => e.seq)).toEqual([1, 2]);
  });
});
