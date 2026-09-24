import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTranscriptReader, type Piece, type TranscriptFormat } from "../jsonl-reader";
import { pickOption, plainScreen } from "../tui-screen";
import type { TranscriptFacts } from "../types";

const dir = mkdtempSync(join(tmpdir(), "reader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A toy format: `{say}` is a message, `{call, id}` a tool call, `{result, id}` its result,
 *  `{quiet}` contributes nothing to the timeline. */
function toyFormat(): TranscriptFormat & { added: number } {
  const f = {
    added: 0,
    add() {
      f.added++;
    },
    reset() {
      f.added = 0;
    },
    facts: () => ({ agentSessionId: "x", tokens: { input: f.added } }) as unknown as TranscriptFacts,
    links(v: any) {
      if (v.call) return { calls: [v.id] };
      if (v.result) return { results: [v.id] };
      return null;
    },
    pieces(v: any, i: number): Piece[] {
      if (v.say) return [{ kind: "event", event: { id: `r${i}`, at: i, kind: "assistant", text: v.say } }];
      if (v.call) return [{ kind: "call", callId: v.id, event: { id: `r${i}`, at: i, kind: "tool", name: v.call, summary: "", status: "running" } }];
      if (v.result) return [{ kind: "result", callId: v.id, output: v.result, error: v.error === true }];
      if (v.boom) throw new Error("bad record");
      return [];
    },
  };
  return f;
}

let k = 0;
function setup(lines: unknown[]) {
  const path = join(dir, `t${k++}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const fmt = toyFormat();
  const r = new JsonlTranscriptReader({ provider: "claude", accountId: "a", agentSessionId: "x", path, mtimeMs: 0, size: 0 }, fmt);
  return { path, r, fmt, append: (more: unknown[]) => appendFileSync(path, more.map((l) => JSON.stringify(l)).join("\n") + "\n") };
}

describe("JsonlTranscriptReader", () => {
  test("pages walk back across chunk boundaries without gaps or repeats", async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 500; i++) lines.push(i % 3 === 0 ? { quiet: true } : { say: `m${i}` });
    const { r } = setup(lines);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const page = await r.timeline({ before, limit: 25 });
      seen.unshift(...page.events.map((e) => (e as { text: string }).text));
      before = page.before;
      pages++;
    } while (before && pages < 100);
    const want = lines.flatMap((l: any, i) => (l.say ? [`m${i}`] : []));
    expect(seen).toEqual(want);
  });

  test("a call's result is folded in wherever it lands; since re-sends the call once finished", async () => {
    const { r, append } = setup([{ say: "a" }, { call: "Bash", id: "c1" }, { call: "Read", id: "c2" }, { result: "r2", id: "c2" }]);
    const page = await r.timeline({ limit: 10 });
    expect(page.events.map((e) => [e.id, (e as { status?: string }).status ?? null])).toEqual([
      ["r0", null],
      ["r1", "running"],
      ["r2", "ok"],
    ]);
    append([{ say: "b" }, { result: "boom", id: "c1", error: true }, { result: "late duplicate", id: "c1" }]);
    const s = await r.since(page.cursor);
    expect(s.events.map((e) => [e.id, (e as { status?: string }).status ?? null, (e as { output?: string }).output ?? null])).toEqual([
      ["r4", null, null],
      ["r1", "error", "boom"],
    ]);
    // Paging back later shows the call finished.
    const again = await r.timeline({ limit: 10 });
    expect(again.events.find((e) => e.id === "r1")).toMatchObject({ status: "error", output: "boom" });
  });

  test("a cursor from another file, or garbage, is a reset with the newest page", async () => {
    const { r } = setup([{ say: "a" }, { say: "b" }]);
    for (const c of ["nonsense", "1.0:1", "", "999.0:99999"]) {
      const s = await r.since(c);
      expect(s.reset).toBe(true);
      expect(s.events.map((e) => (e as { text: string }).text)).toEqual(["a", "b"]);
    }
    const page = await r.timeline({ before: "not-a-cursor", limit: 10 });
    expect(page.events).toHaveLength(2);
  });

  test("a record the format cannot project is skipped, not fatal", async () => {
    const { r, fmt } = setup([{ say: "a" }, { boom: true }, { say: "b" }]);
    const res = await r.refresh();
    expect(fmt.added).toBe(3);
    expect(res.changed).toBe(true);
    expect((await r.timeline({ limit: 10 })).events).toHaveLength(2);
  });
});

describe("pickOption", () => {
  test("moves from the pointer to the option, by number or by line", () => {
    expect(pickOption(" ❯ 1. Yes\n   2. No", /^No/)).toEqual(["Down", "Enter"]);
    expect(pickOption("   1. Yes\n   2. No\n ❯ 3. Maybe", /^Yes/)).toEqual(["Up", "Up", "Enter"]);
    expect(pickOption("│ ❯ No, exit          │\n│   Yes, I accept     │", /^Yes, I accept/)).toEqual(["Down", "Enter"]);
    expect(pickOption("› Trust and continue\n  Open restricted", /^Trust and continue/)).toEqual(["Enter"]);
  });

  test("no pointer near the option, or a gap between them, is no answer", () => {
    expect(pickOption("   1. Yes\n   2. No", /^Yes/)).toBeNull();
    expect(pickOption(" ❯ No\n\n   Yes", /^Yes/)).toBeNull();
    expect(pickOption(" ❯ No", /^Yes/)).toBeNull();
  });

  test("plainScreen strips colour and hyperlinks", () => {
    expect(plainScreen("\x1b[1mbold\x1b[22m \x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("bold link");
  });
});
