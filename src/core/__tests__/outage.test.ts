import { describe, expect, test } from "bun:test";
import { Outage } from "../prs";

const MIN = 60_000;

describe("Outage", () => {
  test("says nothing for the first five minutes of GitHub not answering", () => {
    const o = new Outage();
    for (let m = 0; m < 5; m++) {
      o.fail(m * MIN);
      expect(o.shown()).toBe(false);
    }
    o.fail(5 * MIN);
    expect(o.shown()).toBe(true);
  });

  test("an answer ends it", () => {
    const o = new Outage();
    for (let m = 0; m <= 6; m++) o.fail(m * MIN);
    expect(o.shown()).toBe(true);
    o.answered();
    expect(o.shown()).toBe(false);
    expect(o.fail(7 * MIN)).toBe(true);
    expect(o.shown()).toBe(false);
  });

  test("time asleep does not count: the grace starts again on waking", () => {
    const o = new Outage();
    expect(o.fail(0)).toBe(true);
    expect(o.fail(MIN)).toBe(false);
    // The lid closed for eight hours; the first try after waking fails too.
    expect(o.fail(8 * 60 * MIN)).toBe(true);
    expect(o.shown()).toBe(false);
    for (let m = 1; m < 5; m++) o.fail(8 * 60 * MIN + m * MIN);
    expect(o.shown()).toBe(false);
    o.fail(8 * 60 * MIN + 5 * MIN);
    expect(o.shown()).toBe(true);
  });
});
