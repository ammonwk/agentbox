/** Reading a TUI's menu off a captured screen, for `autoAnswer`.
 *
 * Claude and codex both draw a select list with a pointer (`❯` / `›`) on the
 * focused option, and both have moved the default between versions — Claude
 * 2.1's folder-trust dialog focuses "No, exit" first, where earlier versions
 * focused "Yes". Pressing Enter on the assumed default is how a session gets
 * quit on its first screen, so the keys are computed from where the pointer
 * actually is.
 */

/** Terminal capture without colour, cursor or hyperlink escapes. */
export function plainScreen(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

const POINTER = /^[\s│┃|]*[❯›▶]\s+\S/;
const NUMBERED = /^(\d+)[.)]\s+/;
/** Option text without the box border, pointer or trailing padding. */
const optionText = (line: string) => line.replace(/^[\s│┃|]*(?:[❯›▶]\s+)?/, "").replace(/[\s│┃|]*$/, "");

/** How far apart the pointer and the wanted option may be: a menu, not a page. */
const SPAN = 8;

/**
 * Keys that move the pointer onto the option matching `target` and confirm
 * it, or null when the screen does not show that option with a pointer near
 * it. The pointer is looked for next to the option rather than anywhere on
 * screen, because the input box's prompt glyph is the same `❯`.
 */
export function pickOption(screen: string, target: RegExp): string[] | null {
  const lines = plainScreen(screen).split("\n");
  let best: { found: number; cursor: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!target.test(optionText(lines[i]!).replace(NUMBERED, ""))) continue;
    for (let j = Math.max(0, i - SPAN); j <= Math.min(lines.length - 1, i + SPAN); j++) {
      if (!POINTER.test(lines[j]!)) continue;
      if (!best || Math.abs(i - j) < Math.abs(best.found - best.cursor)) best = { found: i, cursor: j };
    }
  }
  if (!best) return null;
  const { found, cursor } = best;
  const from = NUMBERED.exec(optionText(lines[cursor]!));
  const to = NUMBERED.exec(optionText(lines[found]!));
  let delta: number;
  if (from && to) delta = Number(to[1]) - Number(from[1]);
  else {
    // Unnumbered options are counted by line, which only holds when every
    // line between them is itself an option.
    for (let i = Math.min(cursor, found) + 1; i < Math.max(cursor, found); i++) {
      if (!optionText(lines[i]!).trim()) return null;
    }
    delta = found - cursor;
  }
  const move = delta > 0 ? "Down" : "Up";
  return [...Array<string>(Math.abs(delta)).fill(move), "Enter"];
}

/** Every pattern appears on screen. */
export function shows(screen: string, ...patterns: RegExp[]): boolean {
  return patterns.every((p) => p.test(screen));
}
