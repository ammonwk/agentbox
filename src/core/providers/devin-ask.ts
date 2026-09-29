/** Answering devin's ask_user_question dialog from what its screen shows.
 *
 * The dialog, as devin 3000.11 draws it (one question per tab; the tab bar
 * carries every question's header, ✓ on the answered ones):
 *
 *   ── Color ✓ · Size ──────────────────────────────
 *     Which color?
 *     ❭ 1 Red
 *         The color red
 *       2 Blue
 *         The color blue
 *         Other (type your own)
 *   ────────────────────────────────────────────────
 *   ↑↓ navigate · ↵ select · ←→ switch question · ? help me out · esc cancel
 *   ? Not ready to answer, help me out!
 *
 * A multi-select question numbers every item including Other and draws boxes
 * (`□ 1 A` / `■ 2 B`), and its footer gains `␣ toggle`. While the Other field
 * is open the item numbers are hidden and the typed text shows on a `└` line.
 *
 * What the keys do (probed on a live dialog): ↑/↓ move the pointer, wrapping;
 * a digit toggles (multi-select) or picks (single-select) that item; Space
 * toggles the pointed item; Enter on an option commits the answer and moves
 * to the next question — on the last question it submits the whole dialog.
 * Enter never toggles in a multi-select. Activating "Other" opens the text
 * field; typing lands in it; Enter there commits the text (and submits if it
 * was the last question). Esc cancels the whole dialog.
 *
 * The screen is read again after every step: the terminal may be answering
 * the same dialog, and a step that did not land is retried from what is
 * there rather than assumed.
 */

import type { AskAnswer, AskQuestion } from "../types";
import { plainScreen } from "./tui-screen";

export type AskStep =
  /** Press these (tmux key names). */
  | { keys: string[] }
  /** Type this literally into the focused field. */
  | { type: string }
  /** The dialog is gone. */
  | { done: true }
  | { error: string };

interface Item {
  /** The digit that picks this item, when it has one. */
  n: number | null;
  label: string;
  description?: string;
  checked: boolean | null;
  pointer: boolean;
  other: boolean;
}

interface AskScreen {
  /** The active tab's question text (multi-select suffix stripped). */
  text: string;
  /** The tab bar's chips, in question order, ✓ kept on the answered ones. */
  chips: string[];
  items: Item[];
  /** The Other field's text, while it is open. */
  input: string | null;
}

const BORDER = /^[\s│┃|]*/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const OTHER = /^Other \(type your own\)$/;

/**
 * The bar line: a rule of ─ with the question headers embedded in it, at the
 * top of the dialog. From the footer there is the all-─ rule, then the body
 * (question text, items, descriptions — none starts with ─), then the bar.
 */
function barOf(lines: string[], footer: number): number {
  let i = footer - 1;
  while (i >= 0 && /^[─═\s-]+$/.test(lines[i]!)) i--;
  while (i >= 0 && !/^[─═]{2,}/.test(lines[i]!.replace(BORDER, "").trim())) i--;
  if (i < 0) return -1;
  const t = lines[i]!.replace(BORDER, "").trim();
  return t.replace(/[─═]/g, "").trim() ? i : -1;
}

/** The dialog on screen, or null when there is none. */
export function readAskScreen(raw: string): AskScreen | null {
  const lines = plainScreen(raw).split("\n").map((l) => l.replace(/\s+$/, ""));
  const footer = lines.findIndex((l) => /↵ select/.test(l) && /esc cancel/.test(l));
  if (footer < 0) return null;
  const bar = barOf(lines, footer);
  if (bar < 0) return null;
  const chips = norm(lines[bar]!.replace(/[─═]/g, "")).split("·").map(norm).filter(Boolean);

  const items: Item[] = [];
  const text: string[] = [];
  const bodyLines = lines.slice(bar + 1, footer);
  // With Other open, unnumbered options cannot be separated from question
  // continuations. Keep the first-line prefix for matching that input state.
  const typing = bodyLines.some((l) => /^└/.test(l.replace(BORDER, "")));
  let input: string | null = null;
  for (const l of bodyLines) {
    const t = l.replace(BORDER, "").trim();
    if (/^[─═-]+$/.test(t)) continue;
    if (/^└/.test(t)) {
      input = norm(t.slice(1));
      continue;
    }
    const pointer = /^❭/.test(t);
    const body = t.replace(/^❭\s*/, "");
    const m = /^([□■])?\s*(?:(\d+)\s+)?(.*)$/.exec(body);
    const rest = (m?.[3] ?? body).trim();
    // An item carries a box, the next number in sequence, or is the Other
    // field; anything else is the question's text or a description.
    if (m && (m[1] || (m[2] !== undefined && Number(m[2]) === items.length + 1) || OTHER.test(rest))) {
      items.push({
        n: m[2] ? Number(m[2]) : null,
        label: rest,
        checked: m[1] ? m[1] === "■" : null,
        pointer,
        other: OTHER.test(rest),
      });
    } else if (items.length === 0 && t && (!typing || text.length === 0)) {
      // Devin wraps in its renderer, so tmux's -J cannot join these lines.
      text.push(t);
    } else if (items.length > 0 && t && !typing) {
      const item = items[items.length - 1]!;
      if (!item.other) item.description = norm(`${item.description ?? ""} ${t}`);
    }
  }
  if (!items.length || !text.length) return null;
  const question = norm(text.join(" ")).replace(/\s*\(multi-select\)$/, "");
  if (!question) return null;
  return { text: question, chips, items, input };
}

/** The question on screen is this one: same words, allowing for a cut-off tail. */
function same(onScreen: string, q: string): boolean {
  const a = norm(onScreen).replace(/…$/, "");
  const b = norm(q);
  return a === b || (a.length >= 20 && b.startsWith(a));
}

/**
 * ↑/↓ from the pointed item to `to`, counted by item number (a phantom
 * line cannot skew it); Other sits after the last number. Null when no
 * pointer shows.
 */
function moves(items: Item[], to: Item): string[] | null {
  const from = items.find((i) => i.pointer);
  if (!from) return null;
  const last = Math.max(...items.filter((i) => i.n !== null).map((i) => i.n!), 0);
  const nOf = (i: Item) => i.n ?? last + 1;
  const d = nOf(to) - nOf(from);
  return Array<string>(Math.abs(d)).fill(d > 0 ? "Down" : "Up");
}

/**
 * The next thing to do to get the dialog to `answers`. Questions are answered
 * in order — committing one advances to the next tab, and committing the last
 * submits — so the driver works on the first question the tab bar shows
 * unanswered, switching tabs back to it when the terminal is elsewhere. An
 * open text field outranks all of that: it belongs to the tab showing, and
 * its ✓ chip is already up (it marks a question with text in the field, not
 * a committed answer), while ←→ would only move the cursor.
 * `visited` is accepted for the adapter's shape.
 */
export function askStep(raw: string, questions: AskQuestion[], answers: AskAnswer[], _visited: ReadonlySet<number>): AskStep {
  const s = readAskScreen(raw);
  if (!s) return { done: true };

  const active = questions.findIndex((q) => same(s.text, q.question));
  if (active < 0) return { error: `the terminal is showing a different question: “${s.text}”` };

  // The text field open on the active tab is this question's to finish — the
  // tab bar's ✓ is no guide here, because it marks a question with text in
  // the field before that text is committed, and ←→ while typing move the
  // cursor, not the tabs.
  if (s.input !== null) {
    const a = answers[active]!;
    if (!a.other) return { keys: ["Escape"] }; // cancel typing; the next pass fixes the box
    if (s.input === a.other) return { keys: ["Enter"] };
    if (s.input) return { keys: Array<string>(Math.min(s.input.length + 2, 400)).fill("BSpace") };
    return { type: a.other };
  }

  let k = questions.findIndex((_, i) => s.chips[i] !== undefined && !s.chips[i]!.endsWith("✓"));
  if (k < 0) k = active;
  if (k !== active) {
    // An unanswered question sits on another tab. ←→ switches; the bar's
    // order is the questions' order.
    const d = k - active;
    return { keys: Array<string>(Math.abs(d)).fill(d > 0 ? "Right" : "Left") };
  }

  const q = questions[k]!;
  const a = answers[k]!;
  const { items } = s;
  const other = items.find((i) => i.other) ?? null;

  if (q.multiSelect) {
    for (let i = 0; i < q.options.length; i++) {
      const item = items.find((it) => it.n !== null && it.label && same(it.label, q.options[i]!.label));
      if (!item) return { error: `cannot find the option “${q.options[i]!.label}”` };
      if (item.checked !== a.labels.includes(q.options[i]!.label)) {
        // Only digits 1–9 pick an item; a wider list is not drivable blind.
        if (item.n === null || item.n > 9) return { error: `“${q.options[i]!.label}” has no pickable number` };
        return { keys: [String(item.n)] };
      }
    }
    if (a.other) {
      if (!other) return { error: "cannot find the Other field" };
      if (other.n !== null) {
        // A numbered Other: its digit checks the box and opens the field.
        if (other.n > 9) return { error: "the Other field has no pickable number" };
        return { keys: [String(other.n)] };
      }
      const m = moves(items, other);
      if (!m) return { error: "cannot find the pointer on the dialog" };
      return { keys: m.length ? m : ["Enter"] };
    }
    return { keys: ["Enter"] };
  }

  if (a.other) {
    if (!other) return { error: "cannot find the Other field" };
    const m = moves(items, other);
    if (!m) return { error: "cannot find the pointer on the dialog" };
    return { keys: m.length ? m : ["Enter"] };
  }
  const want = a.labels[0] ?? "";
  const target = items.find((i) => !i.other && i.label && same(i.label, want));
  if (!target) return { error: `cannot find the option “${want}”` };
  const m = moves(items, target);
  if (!m) return { error: "cannot find the pointer on the dialog" };
  return { keys: [...m, "Enter"] };
}

/**
 * The question itself, read off the dialog, for when the transcript does not
 * have it yet. Only a single question shown whole: every option numbered,
 * nothing scrolled off. Several questions are one tab each, and only the open
 * tab is on screen, so those wait for the transcript.
 */
export function askFromScreen(raw: string): { id: string; questions: AskQuestion[] } | null {
  const s = readAskScreen(raw);
  if (!s || s.chips.length !== 1) return null;
  const multi = s.items.some((it) => it.checked !== null);
  const options = s.items.filter((it) => !it.other && it.label)
    .map((it) => ({ label: it.label, ...(it.description ? { description: it.description } : {}) }));
  if (!options.length) return null;
  let h = 2166136261;
  for (let i = 0; i < s.text.length; i++) h = Math.imul(h ^ s.text.charCodeAt(i), 16777619);
  return {
    id: `screen-${(h >>> 0).toString(36)}`,
    questions: [{ question: s.text, header: s.chips[0]!.replace(/✓$/, "").trim(), multiSelect: multi, options }],
  };
}
