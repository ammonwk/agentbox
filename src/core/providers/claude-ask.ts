/** Answering Claude's AskUserQuestion dialog from what its screen shows.
 *
 * The dialog, as Claude 2.1 draws it (one question per tab; the tab bar is
 * there even for one question, with arrows and a Submit tab when there are
 * several or it is multi-select):
 *
 *   ←  ☐ Color  ☐ Toppings  ✔ Submit  →
 *
 *   Which color do you prefer for the button?
 *
 *   ❯ 1. Red                          ❯ 1. [✔] Cheese        (multi-select)
 *        Warm and loud                      Always
 *     2. Blue ✔                         2. [ ] Olives
 *     3. Type something.                3. [ ] Type something
 *   ─────────────────                      Submit
 *     4. Chat about this              ─────────────────
 *                                       4. Chat about this
 *   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
 *
 * then, with several questions or a multi-select one, a review tab:
 *
 *   Review your answers
 *    ● Which color do you prefer for the button?
 *      → Blue
 *   ❯ 1. Submit answers
 *     2. Cancel
 *
 * What the keys do: Enter on an option picks it and moves to the next tab
 * (single-select) or toggles its box (multi-select); on "Submit" it moves on.
 * "Type something" is a text field while the pointer is on it, so typing
 * anything — a digit included — lands in it. The pointer is moved with ↑/↓,
 * never digits, and the screen is read again after every step: the terminal
 * may be answering the same dialog, and a step that did not land is retried
 * from what is there rather than assumed.
 */

import type { AskAnswer, AskQuestion } from "../types";
import { pickOption, plainScreen } from "./tui-screen";

export type AskStep =
  /** Press these (tmux key names). */
  | { keys: string[]; commits?: number }
  /** Type this literally into the focused field. */
  | { type: string }
  /** The dialog is gone. */
  | { done: true }
  | { error: string };

interface Item {
  n: number | null;
  label: string;
  checked: boolean | null;
  pointer: boolean;
}

interface QuestionScreen {
  kind: "question";
  text: string;
  items: Item[];
}
interface ReviewScreen {
  kind: "review";
  /** Question text → the answer it shows. */
  answers: Map<string, string>;
}

const BORDER = /^[\s│┃|]*/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const PLACEHOLDER = /^Type something\.?$/;

function lastIndex(lines: string[], test: (l: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i]!)) return i;
  return -1;
}

/** The dialog on screen, or null when there is none. */
export function readAskScreen(raw: string): QuestionScreen | ReviewScreen | null {
  const lines = plainScreen(raw).split("\n").map((l) => l.replace(/\s+$/, ""));
  const flat = norm(lines.join(" "));

  if (/Review your answers/.test(flat) && /Submit answers/.test(flat)) {
    const start = lastIndex(lines, (l) => /Review your answers/.test(l));
    const answers = new Map<string, string>();
    let q: string | null = null;
    for (const l of lines.slice(start + 1)) {
      const t = l.replace(BORDER, "");
      if (t.startsWith("● ")) q = norm(t.slice(2));
      else if (t.startsWith("→ ") && q) answers.set(q, norm(t.slice(2)));
      else if (q && t && !answers.has(q)) q = norm(`${q} ${t}`); // a question that wrapped
    }
    return { kind: "review", answers };
  }

  if (!/Enter to select/.test(flat) || !/Esc to/.test(flat)) return null;
  const footer = lastIndex(lines, (l) => /Enter to select/.test(l));
  // The tab bar: header chips with a box each.
  const bar = lastIndex(lines.slice(0, footer), (l) => /(^|\s)[☐☒✔] \S/.test(l) && !/^\s*(❯\s+)?\d+\./.test(l));
  if (bar < 0) return null;

  const items: Item[] = [];
  const text: string[] = [];
  for (const l of lines.slice(bar + 1, footer)) {
    const t = l.replace(BORDER, "");
    if (/^─+$/.test(t.trim())) continue;
    const pointer = /^❯\s/.test(t);
    const body = t.replace(/^❯\s+/, "");
    const m = /^(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.*?)(?:\s+✔)?$/.exec(body);
    if (m) {
      items.push({ n: Number(m[1]), label: m[3]!.trim(), checked: m[2] === undefined ? null : m[2] === "✔", pointer });
    } else if (/^Submit$/.test(body.trim())) {
      items.push({ n: null, label: "Submit", checked: null, pointer });
    } else if (items.length === 0 && t.trim()) {
      text.push(t.trim());
    }
  }
  if (!items.length || !text.length) return null;
  return { kind: "question", text: norm(text.join(" ")), items };
}

/** The question on screen is this one: same words, allowing for a cut-off tail. */
function same(onScreen: string, q: string): boolean {
  const a = norm(onScreen).replace(/…$/, "");
  const b = norm(q);
  return a === b || (a.length >= 20 && b.startsWith(a));
}

/** ↑/↓ from the pointer to `to`, in item order. */
function moves(items: Item[], to: Item): string[] {
  const from = items.findIndex((i) => i.pointer);
  const at = items.indexOf(to);
  if (from < 0 || at < 0) return [];
  const d = at - from;
  return Array<string>(Math.abs(d)).fill(d > 0 ? "Down" : "Up");
}

/** What a question's answer looks like on the review tab. */
function reviewText(q: AskQuestion, a: AskAnswer): string[] {
  const parts = q.options.filter((o) => a.labels.includes(o.label)).map((o) => o.label);
  if (a.other) parts.push(a.other);
  return parts.map(norm);
}

/**
 * The next thing to do to get the dialog to `answers`. `visited` holds the
 * questions this run has already answered on screen (the caller keeps it
 * across steps); a step that commits one says which in `commits`.
 */
export function askStep(raw: string, questions: AskQuestion[], answers: AskAnswer[], visited: ReadonlySet<number>): AskStep {
  const s = readAskScreen(raw);
  if (!s) return { done: true };

  if (s.kind === "review") {
    // Every question answered here, or back to the first that was not: the
    // terminal may have answered some differently before we got to it.
    const missing = questions.findIndex((_, i) => !visited.has(i));
    if (missing >= 0) return { keys: Array<string>(questions.length - missing).fill("Left") };
    for (let i = 0; i < questions.length; i++) {
      const shown = [...s.answers].find(([q]) => same(q, questions[i]!.question))?.[1];
      if (shown === undefined) continue; // scrolled off; the per-question steps already checked it
      const want = reviewText(questions[i]!, answers[i]!);
      if (!want.every((w) => shown.includes(w))) {
        return { error: `the review shows “${shown}” for “${questions[i]!.question}”, not what was picked` };
      }
    }
    const keys = pickOption(raw, /^Submit answers$/);
    return keys ? { keys } : { error: "cannot find Submit answers on the review screen" };
  }

  const k = questions.findIndex((q) => same(s.text, q.question));
  if (k < 0) return { error: `the terminal is showing a different question: “${s.text}”` };
  const q = questions[k]!;
  const a = answers[k]!;
  const { items } = s;
  const pointed = items.find((i) => i.pointer);
  const otherItem = items.find((i) => i.n === q.options.length + 1) ?? null;
  const inField = !!pointed && pointed === otherItem;

  // An earlier question this run has not answered: go back to it. Out of the
  // text field first, where ← moves the cursor.
  const back = questions.findIndex((_, i) => i < k && !visited.has(i));
  if (back >= 0) return { keys: [...(inField ? ["Up"] : []), ...Array<string>(k - back).fill("Left")] };

  const option = (label: string) => items.find((i) => i.n !== null && i.n <= q.options.length && i.label === label);

  /** Get the text field to show `text`: onto it, clear it, type. */
  const fill = (text: string): AskStep | null => {
    if (!otherItem) return { error: "cannot find the Type something field" };
    if (!inField) return { keys: moves(items, otherItem) };
    const shown = otherItem.label;
    if (shown === text) return null;
    if (!PLACEHOLDER.test(shown) && shown) return { keys: Array<string>(Math.min(shown.length + 2, 400)).fill("BSpace") };
    return { type: text };
  };

  if (!q.multiSelect) {
    if (a.other) {
      const step = fill(a.other);
      return step ?? { keys: ["Enter"], commits: k };
    }
    const target = option(a.labels[0] ?? "");
    if (!target) return { error: `cannot find the option “${a.labels[0]}”` };
    return { keys: [...moves(items, target), "Enter"], commits: k };
  }

  for (const o of q.options) {
    const item = option(o.label);
    if (!item) return { error: `cannot find the option “${o.label}”` };
    if (item.checked !== a.labels.includes(o.label)) return { keys: [...moves(items, item), "Enter"] };
  }
  if (a.other) {
    const step = fill(a.other);
    if (step) return step;
    if (!otherItem!.checked) return { keys: ["Enter"] };
  } else if (otherItem?.checked) {
    return { keys: [...moves(items, otherItem), "Enter"] };
  }
  const submit = items.find((i) => i.n === null && i.label === "Submit");
  if (!submit) return { error: "cannot find Submit under the options" };
  return { keys: [...moves(items, submit), "Enter"], commits: k };
}

/**
 * The question itself, read off the dialog, for when the transcript does not
 * have it: Claude can show an AskUserQuestion it has not written out yet (a
 * turn a background task's notification started, in a team lead). Only a
 * single question shown whole: every option numbered from 1 down to "Type
 * something", nothing scrolled off. Several questions are one tab each, and
 * only the open tab is on screen, so those wait for the transcript.
 */
export function askFromScreen(raw: string): { id: string; questions: AskQuestion[] } | null {
  const lines = plainScreen(raw).split("\n").map((l) => l.replace(/\s+$/, ""));
  const footer = lastIndex(lines, (l) => /Enter to select/.test(l));
  if (footer < 0) return null;
  const bar = lastIndex(lines.slice(0, footer), (l) => /(^|\s)[☐☒✔] \S/.test(l) && !/^\s*(❯\s+)?\d+\./.test(l));
  if (bar < 0) return null;
  const chips = [...lines[bar]!.matchAll(/[☐☒✔]\s+(.+?)(?=\s{2,}|\s*[☐☒✔→]|$)/g)].map((m) => m[1]!.trim()).filter((c) => c !== "Submit");
  if (chips.length !== 1) return null;

  const text: string[] = [];
  const options: { label: string; description?: string }[] = [];
  let multi = false;
  let other = false;
  let into: { label: string; description?: string } | null = null;
  for (const l of lines.slice(bar + 1, footer)) {
    const t = l.replace(BORDER, "");
    if (/^[↑↓]/.test(t.trim())) return null; // the list scrolls: some of it is not on screen
    if (/^─+$/.test(t.trim())) break; // "Chat about this" and the footer's side
    const m = /^(?:❯\s+)?(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.*?)(?:\s+✔)?$/.exec(t);
    if (m) {
      if (Number(m[1]) !== options.length + 1) return null;
      if (m[2] !== undefined) multi = true;
      if (PLACEHOLDER.test(m[3]!.trim())) {
        other = true;
        into = null;
        continue;
      }
      if (other) return null;
      into = { label: m[3]!.trim() };
      options.push(into);
    } else if (/^\s*Submit$/.test(t)) {
      into = null;
    } else if (into && t.trim()) {
      into.description = norm(`${into.description ?? ""} ${t}`);
    } else if (!options.length && t.trim()) {
      text.push(t.trim());
    }
  }
  if (!other || !options.length || !text.length) return null;
  const question = norm(text.join(" "));
  let h = 2166136261;
  for (let i = 0; i < question.length; i++) h = Math.imul(h ^ question.charCodeAt(i), 16777619);
  return { id: `screen-${(h >>> 0).toString(36)}`, questions: [{ question, header: chips[0]!, multiSelect: multi, options }] };
}
