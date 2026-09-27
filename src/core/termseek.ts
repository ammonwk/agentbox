/** Finding one of your messages in a session's live terminal.
 *
 *  Claude Code and Codex draw in the alternate screen and scroll their own
 *  history, so tmux holds none of it and its copy-mode search has nothing to
 *  search. What does work is what a person does: page the TUI up or down
 *  (both take PageUp/PageDown in any state, and they only scroll) and read
 *  the screen until the message is on it. Your messages are the rows that
 *  start with the prompt marker, `❯` in Claude and `›` in Codex, followed by
 *  the message's first line, cut at the pane's width. Knowing every message
 *  in order (./turns.ts), the messages on screen say which way to go.
 *
 *  A message can be ambiguous ("yes", twice) and one can be unrecognisable
 *  (Claude shows a long paste as `[Pasted text #1]`). Rows are placed in
 *  order, anchored on the ones that match a single message, and a message
 *  that should be on screen and is not ends the search: the rail then shows
 *  it in the timeline instead. */

import type { Turn } from "./types";

/** A row with the TUI's prompt marker. */
const PROMPT_ROW = /^\s{0,2}[❯›]\s(.*)$/;
/** Both TUIs say this above the prompt box while scrolled up, and only then:
 *  Claude "Jump to bottom (ctrl+End) ↓", or "3 new messages (ctrl+End) ↓"
 *  once more has arrived; Codex "↓ Back to bottom". */
const SCROLLED = /\(ctrl\+End\) ↓|↓ Back to bottom/;
/** The prompt box and status lines; a spinner there is not the history moving. */
const FOOTER_ROWS = 8;
/** A row shorter than this matches only a message that is exactly it. */
const MIN_PREFIX = 12;
const MAX_STEPS = 160;
const MAX_MS = 15_000;

/** Row text as the rail's text would read: no sender mark, no image tags, one space. */
export function norm(s: string): string {
  return s
    .replace(/^\s*\[(via agentbox send|Project session)\]\s*/, "")
    .replace(/^(\[Image #\d+\]\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/…$/, "")
    .trim();
}

interface Key {
  /** An answer is found by its question anywhere on a row; the rest by a prompt row. */
  anywhere: boolean;
  text: string;
}

export function keysOf(turns: readonly Turn[]): Key[] {
  return turns.map((t) => {
    const first = norm(t.text.split("\n").find((l) => l.trim() !== "") ?? "");
    return { anywhere: t.kind === "answer", text: first };
  });
}

function matches(row: string, isPrompt: boolean, k: Key): boolean {
  if (!k.text) return false;
  if (k.anywhere) return k.text.length >= MIN_PREFIX && norm(row).includes(k.text.slice(0, 40));
  if (!isPrompt || !row) return false;
  if (row === k.text) return true;
  return (row.length >= MIN_PREFIX && k.text.startsWith(row)) || (k.text.length >= MIN_PREFIX && row.startsWith(k.text));
}

export interface Placed {
  row: number;
  /** Index into the turns. */
  turn: number;
}

/**
 * Which of your messages are on screen, and on which rows, top to bottom.
 * Only turns within `[lo, hi]` are considered: what is known of where the
 * screen can be from the screens before it.
 */
export function place(lines: readonly string[], keys: readonly Key[], lo = 0, hi = keys.length - 1): Placed[] {
  // The last prompt row near the bottom is the box you type in, not history.
  let input = -1;
  for (let r = lines.length - 1; r >= Math.max(0, lines.length - FOOTER_ROWS - 4); r--) {
    if (PROMPT_ROW.test(lines[r]!)) {
      input = r;
      break;
    }
  }
  const rows: { row: number; cands: number[] }[] = [];
  lines.forEach((line, row) => {
    if (row === input) return;
    const m = PROMPT_ROW.exec(line);
    // Row 0 of a scrolled TUI is the message whose reply is on screen, pinned
    // there — marked in Claude, bare text in Codex.
    const text = m ? norm(m[1]!) : row === 0 ? norm(line) : line;
    const cands: number[] = [];
    for (let i = Math.max(0, lo); i <= Math.min(hi, keys.length - 1); i++) if (matches(text, !!m || row === 0, keys[i]!)) cands.push(i);
    if (cands.length) rows.push({ row, cands });
  });

  // Top to bottom the turns only go forward. A row matching one message is an
  // anchor; one matching several is whichever fits between its anchors, if
  // exactly one does.
  const out: Placed[] = [];
  let prev = lo;
  rows.forEach((r, i) => {
    const next = rows.slice(i + 1).find((x) => x.cands.length === 1)?.cands[0] ?? hi;
    const fit = r.cands.filter((c) => c >= prev && c <= next);
    if (fit.length !== 1) return;
    out.push({ row: r.row, turn: fit[0]! });
    prev = fit[0]!;
  });
  return out;
}

/** Read in the footer only: the same words in the history are just words. */
export function isScrolled(screen: string): boolean {
  return SCROLLED.test(screen.split("\n").slice(-FOOTER_ROWS - 4).join("\n"));
}

/** Where the reader is: the message whose part of the conversation is on screen; null at the bottom. */
export function whereOnScreen(screen: string, turns: readonly Turn[]): { turnId: string | null; bottom: boolean } {
  if (!isScrolled(screen)) return { turnId: null, bottom: true };
  const lines = screen.split("\n");
  const placed = place(lines, keysOf(turns));
  const first = placed[0];
  if (!first) return { turnId: null, bottom: false };
  // Above the first message on screen is the end of the one before it.
  const k = first.row < lines.length / 3 ? first.turn : Math.max(0, first.turn - 1);
  return { turnId: turns[k]?.id ?? null, bottom: false };
}

export interface SeekIO {
  capture(): string;
  keys(keys: string[]): void;
  sleep(ms: number): Promise<void>;
}

/** `reason` is a sentence for you: the rail shows it when it opens the message in the timeline instead. */
export type SeekResult = { found: true; row: number } | { found: false; reason: string };

/** The history part of the screen, to tell whether a keypress moved it. */
function body(screen: string): string {
  const lines = screen.split("\n");
  return lines.slice(0, Math.max(1, lines.length - FOOTER_ROWS)).join("\n");
}

/** Wait for the TUI to redraw after a key: the history changes, then holds. */
async function settle(io: SeekIO, before: string): Promise<string> {
  const was = body(before);
  for (let waited = 0; waited < 600; waited += 30) {
    await io.sleep(30);
    const now = io.capture();
    if (body(now) !== was) {
      await io.sleep(30);
      return io.capture();
    }
  }
  return io.capture();
}

/**
 * Page the TUI until `turns[target]` is on screen, and say on which row.
 * `claude` allows Ctrl+Home, which Claude Code takes as "to the top": a
 * message near the start is found from there rather than paged up to.
 */
export async function seekTurn(
  io: SeekIO,
  turns: readonly Turn[],
  target: number,
  opts: { claude: boolean; cancelled: () => boolean },
): Promise<SeekResult> {
  const keys = keysOf(turns);
  if (!keys[target]?.text) return { found: false, reason: "It has no text to look for in the terminal." };
  const started = Date.now();
  let screen = io.capture();
  let lines = screen.split("\n");

  if (opts.claude && target < turns.length * 0.4 && place(lines, keys).every((p) => p.turn > target)) {
    io.keys(["C-Home"]);
    screen = await settle(io, screen);
    lines = screen.split("\n");
  }

  let lo = 0;
  let hi = turns.length - 1;
  let dir: "up" | "down" | null = null;
  let flips = 0;
  let atTop = false;
  let pages = 1;
  let nearest = -1;
  for (let step = 0; step < MAX_STEPS && Date.now() - started < MAX_MS; step++) {
    if (opts.cancelled()) return { found: false, reason: "cancelled" };
    const placed = place(lines, keys, lo, hi);
    // Row 0 is pinned (see place), so the message itself is further up —
    // unless this is the top.
    const hit = placed.find((p) => p.turn === target && (p.row > 0 || atTop));
    if (hit) return { found: true, row: hit.row };

    let want: "up" | "down" = dir ?? "up";
    let near = nearest;
    if (placed.length) {
      const seen = placed.map((p) => p.turn);
      const min = Math.min(...seen);
      const max = Math.max(...seen);
      if (target <= min) {
        want = "up";
        near = min;
      } else if (target > max) {
        want = "down";
        near = max;
      } else {
        return { found: false, reason: "The terminal shows this message differently (a long paste, say), so it cannot be found there." };
      }
      if (want === "up") hi = Math.min(hi, max);
      else lo = Math.max(lo, min);
    }
    // One reply can run for pages. Stride out while nothing new comes into
    // view; once past it, halve the stride on every turn back — a search,
    // not a crawl.
    if (dir === null) pages = placed.length ? Math.max(1, Math.min(4, Math.abs(target - near))) : 2;
    else if (want !== dir) {
      flips++;
      pages = Math.max(1, Math.floor(pages / 2));
    } else if (near === nearest && flips === 0) pages = Math.min(pages * 2, 16);
    if (flips > 8) return { found: false, reason: "The terminal kept moving under the search." };
    dir = want;
    nearest = near;

    io.keys(Array.from({ length: pages }, () => (want === "up" ? "PageUp" : "PageDown")));
    const next = await settle(io, screen);
    if (body(next) === body(screen)) {
      if (want === "down") return { found: false, reason: "It is not in the terminal's history; a /clear or a compaction may have dropped it." };
      if (atTop) return { found: false, reason: "It is not in the terminal's history; a /clear or a compaction may have dropped it." };
      atTop = true;
    }
    screen = next;
    lines = screen.split("\n");
  }
  return { found: false, reason: "Finding it in the terminal took too long." };
}

/** Back to the latest: Claude has a key for it; Codex is paged down until it stops saying it is scrolled. */
export async function seekBottom(io: SeekIO, opts: { claude: boolean }): Promise<void> {
  if (opts.claude) {
    io.keys(["C-End"]);
    return;
  }
  let screen = io.capture();
  for (let i = 0; i < 100 && isScrolled(screen); i++) {
    io.keys(["PageDown", "PageDown", "PageDown", "PageDown"]);
    const next = await settle(io, screen);
    if (body(next) === body(screen)) return;
    screen = next;
  }
}
