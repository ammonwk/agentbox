import { describe, expect, test } from "bun:test";
import type { Turn } from "../types";
import { isScrolled, keysOf, place, seekBottom, seekTurn, whereOnScreen, type SeekIO } from "../termseek";

const turn = (i: number, text: string, kind: Turn["kind"] = "prompt"): Turn => ({ id: `t${i}`, at: i, kind, text, seq: i * 10 });

/**
 * A TUI that scrolls its own history the way Claude Code does: the message
 * whose reply is on screen pinned to row 0, a hint above the prompt box
 * while scrolled, PageUp/PageDown a screen at a time, Ctrl+Home/End the ends.
 */
class FakeTui implements SeekIO {
  /** Lines scrolled up from the bottom. */
  offset = 0;
  presses = 0;
  /** Round trips: each is a key batch, then waiting for the redraw. */
  batches = 0;
  constructor(
    private readonly history: string[],
    private readonly height = 20,
    private readonly marker = "❯",
  ) {}
  private get max(): number {
    return Math.max(0, this.history.length - this.height);
  }
  capture(): string {
    const top = this.max - this.offset;
    const view = this.history.slice(top, top + this.height);
    if (this.offset > 0) {
      const pinned = this.history.slice(0, top + 1).reverse().find((l) => l.startsWith(`${this.marker} `));
      if (pinned && view[0] !== pinned) view[0] = pinned;
    }
    const hint = this.offset > 0 ? "                                  Jump to bottom (ctrl+End) ↓" : "";
    return [...view, hint, "────", `${this.marker} `, "────", "  status"].join("\n");
  }
  keys(keys: string[]): void {
    this.batches++;
    for (const k of keys) {
      this.presses++;
      const page = this.height - 2;
      if (k === "PageUp") this.offset = Math.min(this.max, this.offset + page);
      else if (k === "PageDown") this.offset = Math.max(0, this.offset - page);
      else if (k === "C-Home") this.offset = this.max;
      else if (k === "C-End") this.offset = 0;
    }
  }
  async sleep(): Promise<void> {}
  row(r: number): string {
    return this.capture().split("\n")[r]!;
  }
}

/** A conversation: each message, then `replyLines` of reply. */
function conversation(texts: string[], replyLines = 60, marker = "❯"): string[] {
  const out: string[] = [];
  texts.forEach((t, i) => {
    out.push(`${marker} ${t}`);
    for (let j = 0; j < replyLines; j++) out.push(`  reply ${i}.${j}`);
  });
  return out;
}

const TEXTS = Array.from({ length: 12 }, (_, i) => `Message number ${i}: please look at the thing in part ${i}`);
const TURNS = TEXTS.map((t, i) => turn(i, t));

describe("seekTurn", () => {
  for (const target of [0, 3, 7, 10, 11]) {
    test(`pages to message ${target} and says which row`, async () => {
      const tui = new FakeTui(conversation(TEXTS));
      const r = await seekTurn(tui, TURNS, target, { claude: false, cancelled: () => false });
      expect(r.found).toBe(true);
      if (r.found) expect(tui.row(r.row)).toBe(`❯ ${TEXTS[target]}`);
    });
  }

  test("strides through a long reply rather than crawling a page at a time", async () => {
    const tui = new FakeTui(conversation(TEXTS, 400));
    const r = await seekTurn(tui, TURNS, 9, { claude: false, cancelled: () => false });
    expect(r).toMatchObject({ found: true });
    // ~45 pages from the bottom; one at a time would be 45 round trips.
    expect(tui.batches).toBeLessThan(15);
  });

  test("Claude starts from the top for an early message", async () => {
    const tui = new FakeTui(conversation(TEXTS));
    const r = await seekTurn(tui, TURNS, 1, { claude: true, cancelled: () => false });
    expect(r.found).toBe(true);
    expect(tui.presses).toBeLessThan(6);
  });

  test("Codex's › marker", async () => {
    const tui = new FakeTui(conversation(TEXTS, 60, "›"), 20, "›");
    const r = await seekTurn(tui, TURNS, 4, { claude: false, cancelled: () => false });
    expect(r.found).toBe(true);
    if (r.found) expect(tui.row(r.row)).toBe(`› ${TEXTS[4]}`);
  });

  test("the same short message twice: the right one", async () => {
    const texts = ["First, set up the project please", "yes", "Now add the tests for the parser", "yes", "Ship it and open the pull request"];
    const turns = texts.map((t, i) => turn(i, t));
    const history = conversation(texts, 50);
    const tui = new FakeTui(history);
    const r = await seekTurn(tui, turns, 1, { claude: false, cancelled: () => false });
    expect(r.found).toBe(true);
    if (r.found) {
      const top = history.length - 20 - tui.offset;
      expect(top + r.row).toBe(history.indexOf("❯ yes"));
    }
  });

  test("a message the terminal shows differently is not found, and the search stops", async () => {
    const texts = ["Start with the setup of everything", "a very long pasted log\nline two", "Then fix what the log shows is broken"];
    const history = conversation(["Start with the setup of everything", "[Pasted text #1 +40 lines]", "Then fix what the log shows is broken"], 50);
    const tui = new FakeTui(history);
    const r = await seekTurn(tui, texts.map((t, i) => turn(i, t)), 1, { claude: false, cancelled: () => false });
    expect(r.found).toBe(false);
  });

  test("stops when cancelled", async () => {
    const tui = new FakeTui(conversation(TEXTS));
    const r = await seekTurn(tui, TURNS, 0, { claude: false, cancelled: () => true });
    expect(r).toEqual({ found: false, reason: "cancelled" });
  });
});

describe("the screen", () => {
  test("the prompt box is not a message", () => {
    const lines = ["❯ Message number 2: please look at the thing in part 2", "  reply", "────", "❯ Message number 5: please look at the thing in part 5", "────"];
    expect(place(lines, keysOf(TURNS))).toEqual([{ row: 0, turn: 2 }]);
  });

  test("scrolled only when the footer says so", () => {
    const history = ["  I pressed Jump to bottom (ctrl+End) and nothing happened", ...Array(30).fill("  reply")];
    expect(isScrolled(history.join("\n"))).toBe(false);
    expect(isScrolled([...history.slice(0, 20), "  Jump to bottom (ctrl+End) ↓", "────", "❯ ", "────"].join("\n"))).toBe(true);
    expect(isScrolled([...history.slice(0, 20), "  2 new messages (ctrl+End) ↓", "────", "❯ ", "────"].join("\n"))).toBe(true);
    expect(isScrolled([...history.slice(0, 20), "     ↓ Back to bottom · esc", "› Ask Codex to do anything"].join("\n"))).toBe(true);
  });

  test("where: the message being read, or the bottom", async () => {
    const tui = new FakeTui(conversation(TEXTS));
    expect(whereOnScreen(tui.capture(), TURNS)).toEqual({ turnId: null, bottom: true });
    tui.keys(Array(20).fill("PageUp"));
    const w = whereOnScreen(tui.capture(), TURNS);
    expect(w.bottom).toBe(false);
    expect(w.turnId).not.toBeNull();
    await seekBottom(tui, { claude: false });
    expect(tui.offset).toBe(0);
  });
});
