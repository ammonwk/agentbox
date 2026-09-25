import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publish, read, retract, prune, decode, owner, STALE_AFTER_S } from "../live";
import { liveRoot } from "../../core/paths";
import { useTempHome } from "../../core/__tests__/tmp-home";

let restoreHome: () => void;

beforeEach(() => {
  ({ restore: restoreHome } = useTempHome());
});

afterEach(() => restoreHome());

/** Write a line as though it had been published `ageS` seconds ago. */
function age(id: string, cwd: string, text: string, ageS: number, by: string = owner()) {
  mkdirSync(liveRoot(), { recursive: true });
  const at = Math.floor(Date.now() / 1000) - ageS;
  writeFileSync(join(liveRoot(), `${id}.live`), `${at}\t${cwd}\t${by}\t${text}\n`);
}

describe("publishing a live line", () => {
  test("round-trips, and the newest comes first", () => {
    age("old", "/repo", "workflow 1/4 done", 3);
    publish("new", "/repo", "workflow 2/4 done");
    const lines = read("/repo");
    expect(lines.map((l) => l.text)).toEqual(["workflow 2/4 done", "workflow 1/4 done"]);
  });

  test("only the working directory that asked for it", () => {
    publish("here", "/repo", "workflow 1/4 done");
    publish("there", "/other", "workflow 3/9 done");
    expect(read("/repo").map((l) => l.text)).toEqual(["workflow 1/4 done"]);
    // Unfiltered is for a reader that genuinely wants everything, like a
    // second terminal watching the whole machine.
    expect(read()).toHaveLength(2);
  });

  /** A reader polls on its own clock, so it will eventually land mid-write.
   *  The write is a rename, so what it lands on is a whole previous line. */
  test("a replacement never leaves a partial line behind", () => {
    for (let i = 0; i < 50; i++) {
      publish("busy", "/repo", `workflow ${i}/50 done`);
      const lines = read("/repo");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.text).toBe(`workflow ${i}/50 done`);
    }
    // And nothing is left in the directory but the one file.
    expect(readdirSync(liveRoot())).toEqual(["busy.live"]);
  });

  test("a line nobody is refreshing stops being shown", () => {
    age("dead", "/repo", "workflow 2/4 done", STALE_AFTER_S + 1);
    expect(read("/repo")).toHaveLength(0);
    // Ignored, not deleted: the reader is a status line and has no business
    // writing to anything.
    expect(readdirSync(liveRoot())).toHaveLength(1);
  });

  test("retract removes it at once rather than waiting out the clock", () => {
    publish("a", "/repo", "workflow 1/4 done");
    retract("a");
    expect(read("/repo")).toHaveLength(0);
    expect(readdirSync(liveRoot())).toHaveLength(0);
  });

  test("prune clears what a killed process left, and keeps what is live", () => {
    age("ghost", "/repo", "workflow 1/4 done", STALE_AFTER_S + 1);
    publish("alive", "/repo", "workflow 3/4 done");
    expect(prune()).toBe(1);
    expect(readdirSync(liveRoot())).toEqual(["alive.live"]);
  });

  test("an id from a tool call cannot climb out of the directory", () => {
    publish("../../escape", "/repo", "workflow 1/1 done");
    for (const name of readdirSync(liveRoot())) expect(name).not.toContain("..");
    expect(read("/repo")).toHaveLength(1);
  });

  test("a line with tabs or newlines in it stays one line", () => {
    publish("a", "/repo", "workflow 1/4\tdone\nand more");
    expect(read("/repo")[0]!.text).toBe("workflow 1/4 done and more");
  });

  test("a file that is not a live line is skipped, not thrown on", () => {
    mkdirSync(liveRoot(), { recursive: true });
    writeFileSync(join(liveRoot(), "junk.live"), "not a line at all\n");
    publish("good", "/repo", "workflow 1/4 done");
    expect(read("/repo").map((l) => l.text)).toEqual(["workflow 1/4 done"]);
  });

  test("decode keeps tabs that were part of the text", () => {
    expect(decode("100\t/repo\ts-1\ta\tb")).toEqual({
      at: 100,
      cwd: "/repo",
      owner: "s-1",
      text: "a\tb",
    });
    expect(decode("nonsense")).toBeNull();
    // Three fields is the old format. A reader that accepted it would take the
    // owner pid for the text and show a bare number where the roster goes.
    expect(decode("100\t/repo\tworkflow 1/4 done")).toBeNull();
  });

  /**
   * Two sessions open on one repository was the case `cwd` could not separate,
   * and it is not exotic — it is what happens the moment somebody opens a
   * second window on the same project. Each was shown the other's agents,
   * which is worse than showing none: a roster on the wrong window is
   * indistinguishable from your own work.
   */
  test("only this client's own agents, even in a shared directory", () => {
    publish("mine", "/repo", "agent scan 12s");
    age("theirs", "/repo", "agent other-window 90s", 1, `${owner()}-other`);
    // The directory cannot tell them apart; the owning client can.
    expect(read("/repo")).toHaveLength(2);
    expect(read("/repo", [owner()]).map((l) => l.text)).toEqual(["agent scan 12s"]);
    expect(read("/repo", [`${owner()}-other`]).map((l) => l.text)).toEqual([
      "agent other-window 90s",
    ]);
    // Unfiltered still means everything: a second terminal watching the whole
    // machine is a real reader and wants both.
    expect(read()).toHaveLength(2);
  });

  test("reading a directory that was never created is empty, not an error", () => {
    expect(read("/repo")).toEqual([]);
    expect(prune()).toBe(0);
  });
});
