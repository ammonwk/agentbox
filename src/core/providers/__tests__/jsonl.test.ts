import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTail } from "../jsonl";

const tmp = () => join(mkdtempSync(join(tmpdir(), "jsonl-")), "t.jsonl");

describe("JsonlTail", () => {
  test("reads only complete lines, then picks up the rest", () => {
    const p = tmp();
    writeFileSync(p, '{"a":1}\n{"a":2}\n{"a":');
    const t = new JsonlTail(p);
    expect(t.read().records.map((r) => r.value.a)).toEqual([1, 2]);
    appendFileSync(p, '3}\n{"a":"é"}\n');
    const next = t.read();
    expect(next.records.map((r) => r.value.a)).toEqual([3, "é"]);
    expect(next.reset).toBe(false);
    expect(t.read().records).toEqual([]);
  });

  test("skips junk lines but keeps indices dense and ranges exact", () => {
    const p = tmp();
    writeFileSync(p, 'garbage\n{"i":0}\n\n{"i":1}\n{bad json\n{"i":2}\n');
    const t = new JsonlTail(p);
    const all = t.read().records;
    expect(all.map((r) => [r.index, r.value.i])).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(t.range(1, 3).map((r) => r.value.i)).toEqual([1, 2]);
    expect(t.range(0, 1).map((r) => r.value.i)).toEqual([0]);
  });

  test("a replaced file is re-read from the start", () => {
    const p = tmp();
    writeFileSync(p, '{"v":1}\n{"v":2}\n');
    const t = new JsonlTail(p);
    t.read();
    writeFileSync(p + ".new", '{"v":9}\n');
    renameSync(p + ".new", p);
    const r = t.read();
    expect(r.reset).toBe(true);
    expect(r.records.map((x) => x.value.v)).toEqual([9]);
  });

  test("lines larger than one chunk", () => {
    const p = tmp();
    const big = "x".repeat(5 * 1024 * 1024);
    writeFileSync(p, `{"s":"${big}"}\n{"n":1}\n`);
    const t = new JsonlTail(p);
    const r = t.read().records;
    expect(r.length).toBe(2);
    expect(r[0]!.value.s.length).toBe(big.length);
    expect(t.range(1, 2)[0]!.value.n).toBe(1);
  });
});
