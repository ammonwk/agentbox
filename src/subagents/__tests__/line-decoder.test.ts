import { describe, expect, test } from "bun:test";
import { LineDecoder } from "../line-decoder";

/**
 * The decoder is the one piece here that fails intermittently rather than
 * loudly: a transcript-sized payload straddling a chunk boundary is the
 * difference between "works on my machine" and "drops a reply once an hour",
 * so the boundaries are asserted rather than sampled.
 */
describe("LineDecoder", () => {
  test("returns whole lines and holds the partial tail", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(d.push(Buffer.from('2}\n'))).toEqual(['{"b":2}']);
  });

  test("reassembles a value split across many chunks", () => {
    const d = new LineDecoder();
    const line = JSON.stringify({ text: "x".repeat(5000) });
    const chunks = (line + "\n").match(/[\s\S]{1,97}/g)!;
    const out = chunks.flatMap((c) => d.push(Buffer.from(c)));
    expect(out).toEqual([line]);
  });

  test("splits several values arriving in one chunk", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'))).toHaveLength(3);
  });

  test("ignores keepalive blank lines", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from("\n\n"))).toEqual([]);
  });
});
