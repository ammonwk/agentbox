/** Answering omp's ask dialog from what its screen shows.
 *
 * The dialog, as omp 17 draws it (one tab per question, then Submit):
 *
 *   ╭─ Ask ─────────────────────────────────────────────────────╮
 *   │  color    sizes    Submit                                  │
 *   │ Which color?                                (wraps)        │
 *   ├────────────────────────────────────────────────────────────┤
 *   │ ❯ ○ Red                     ○/◉ one answer, ☐/☑ several    │
 *   │       A description                                        │
 *   │   ◉ Other (type your own)                                  │
 *   │       Teal please           what was typed for Other       │
 *   ├────────────────────────────────────────────────────────────┤
 *   │ Enter select · n note · ↑/↓ move · Tab/←/→ · Esc cancel    │
 *   ╰────────────────────────────────────────────────────────────╯
 *
 * The Submit tab reads "Review answers" and lists `1. color: “Teal please”`,
 * `2. sizes: Small, Large` above `❯ Submit`.
 *
 * What the keys do (probed on a live dialog): ↑/↓ move the pointer; on a
 * one-answer question Enter picks the pointed item and moves to the next
 * tab, on a several-answer one Space toggles it and stays; Tab and ←/→
 * switch tabs; Enter on Submit sends the answers. Other opens an editor in
 * place of the dialog — `Custom answer: <question>`, the text on a `> `
 * line — where Ctrl-U clears, Enter commits (and moves on, for a one-answer
 * question) and Esc goes back.
 *
 * The options scroll inside a few rows (a long list, or descriptions), with
 * a scrollbar in place of the right border, so the pointer is moved by
 * counting along the question's own option list — the list follows it —
 * and a several-answer question is walked top to bottom, each option
 * checked once it shows (`commits`). Otherwise each step is decided afresh
 * from the screen: make the tab showing match, move on, and on Submit go
 * back to the first answer that is not yet right.
 */

import type { AskAnswer, AskQuestion } from "../types";
import type { AskStep } from "./claude-ask";
import { plainScreen } from "./tui-screen";

interface Item {
  label: string;
  /** ◉ / ☑: picked. */
  picked: boolean;
  pointer: boolean;
  other: boolean;
  /** The lines under it: a description, or what was typed for Other. */
  note: string;
}

type OmpAskScreen =
  | { kind: "question"; text: string; items: Item[] }
  | { kind: "review"; answers: Map<number, string> }
  | { kind: "editor"; question: string; input: string };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function lastIndexWhere<T>(xs: readonly T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i;
  return -1;
}
const OTHER = /^Other \(type your own\)$/;

/** The dialog on screen, or null when there is none. */
export function readOmpAsk(raw: string): OmpAskScreen | null {
  const lines = plainScreen(raw).split("\n").map((l) => l.replace(/\s+$/, ""));

  const custom = lastIndexWhere(lines, (l) => l.startsWith("Custom answer: "));
  if (custom >= 0 && lines.slice(custom).some((l) => /enter or ctrl\+q submit/.test(l))) {
    const field = lines.findIndex((l, i) => i > custom && /^>( |$)/.test(l));
    if (field < 0) return null;
    const question = norm(lines.slice(custom, field).join(" ").slice("Custom answer: ".length));
    return { kind: "editor", question, input: lines[field]!.slice(2).trim() };
  }

  const top = lastIndexWhere(lines, (l) => /^\s*╭─ Ask ─/.test(l));
  if (top < 0) return null;
  const end = lines.findIndex((l, i) => i > top && /^\s*╰/.test(l));
  const box = lines.slice(top + 1, end < 0 ? undefined : end);
  const rules = box.flatMap((l, i) => (/^\s*├─/.test(l) ? [i] : []));
  if (rules.length < 2 || !/Esc cancel/.test(box[rules[1]! + 1] ?? "")) return null;
  // The right edge is the border, and a scrollbar inside it while the list scrolls.
  const inner = (l: string) => l.replace(/^\s*│ ?/, "").replace(/(\s*[│┃█▐▌░▒▓])+\s*$/, "");
  const text = norm(box.slice(1, rules[0]).map(inner).join(" "));
  const body = box.slice(rules[0]! + 1, rules[1]).map(inner);

  if (text === "Review answers") {
    const answers = new Map<number, string>();
    for (const l of body) {
      const m = /^\s*(\d+)\.\s+[^:]*:\s*(.*)$/.exec(l);
      if (m) answers.set(Number(m[1]), norm(m[2]!));
    }
    return { kind: "review", answers };
  }

  const items: Item[] = [];
  for (const l of body) {
    const m = /^(❯)?\s*([○◉☐☑])\s+(.*)$/.exec(l.trim());
    if (m) {
      const label = norm(m[3]!);
      items.push({ label, picked: m[2] === "◉" || m[2] === "☑", pointer: !!m[1], other: OTHER.test(label), note: "" });
    } else if (items.length > 0 && l.trim()) {
      const item = items[items.length - 1]!;
      item.note = norm(`${item.note} ${l}`);
    }
  }
  return items.length > 0 && text ? { kind: "question", text, items } : null;
}

/** The question on screen is this one: same words, allowing for a cut-off tail. */
function same(onScreen: string, q: string): boolean {
  const a = norm(onScreen).replace(/…$/, "");
  const b = norm(q);
  return a === b || (a.length >= 20 && b.startsWith(a));
}

/** Does the Submit tab's line for a question say `a`? Typed text is quoted,
 *  and beside picked options reads `Other: “…”`: `Y, Other: “Z”`. */
function says(line: string | undefined, a: AskAnswer): boolean {
  if (line === undefined) return false;
  const got = line
    .split(", ")
    .map((x) => x.replace(/^Other: (?=[“"])/, "").replace(/^[“"]|[”"]$/g, "").trim())
    .sort();
  const want = [...a.labels, ...(a.other ? [a.other] : [])].map((x) => x.trim()).sort();
  return got.length === want.length && got.every((x, i) => x === want[i]);
}

/** The next thing to do to get the dialog to `answers`. `visited` holds what
 *  earlier steps committed (see the top of this file). */
export function ompAskStep(raw: string, questions: AskQuestion[], answers: AskAnswer[], visited: ReadonlySet<number>): AskStep {
  const s = readOmpAsk(raw);
  if (!s) return { done: true };

  if (s.kind === "editor") {
    const k = questions.findIndex((q) => same(s.question, q.question));
    if (k < 0) return { error: `the terminal is asking for text for a different question: “${s.question}”` };
    const want = answers[k]!.other;
    if (!want) return { keys: ["Escape"] };
    if (s.input === want.trim()) return { keys: ["Enter"] };
    if (s.input) return { keys: ["C-u"] };
    return { type: want };
  }

  if (s.kind === "review") {
    const wrong = questions.findIndex((_, k) => !says(s.answers.get(k + 1), answers[k]!));
    if (wrong < 0) return { keys: ["Enter"] };
    return { keys: Array<string>(questions.length - wrong).fill("Left") };
  }

  const k = questions.findIndex((q) => same(s.text, q.question));
  if (k < 0) return { error: `the terminal is showing a different question: “${s.text}”` };
  const q = questions[k]!;
  const a = answers[k]!;
  // Where each item sits in the whole list: the options, then Other.
  const place = (i: Item) => (i.other ? q.options.length : q.options.findIndex((o) => same(i.label, o.label)));
  const pointer = s.items.find((i) => i.pointer);
  if (!pointer || place(pointer) < 0) return { error: "cannot find the pointer on the dialog" };
  const to = (n: number): string[] => {
    const d = n - place(pointer);
    return Array<string>(Math.abs(d)).fill(d > 0 ? "Down" : "Up");
  };
  const shown = (n: number) => s.items.find((i) => place(i) === n);
  const wantOther = a.other?.trim() ?? "";

  if (!q.multiSelect) {
    const n = wantOther ? q.options.length : q.options.findIndex((o) => same(o.label, a.labels[0] ?? ""));
    if (n < 0) return { error: `cannot find the option “${a.labels[0] ?? ""}”` };
    const item = shown(n);
    if (item?.picked && (!wantOther || item.note === wantOther)) return { keys: ["Tab"] };
    return { keys: [...to(n), "Enter"] };
  }

  // Checked through which item, from earlier steps: k*1000 + n.
  let done = -1;
  for (const v of visited) if (Math.floor(v / 1000) === k) done = Math.max(done, v % 1000);
  const last = q.options.length;
  for (let n = done + 1; n <= last; n++) {
    const item = shown(n);
    if (!item) return { keys: to(n) };
    const right =
      n === last ? item.picked === !!wantOther && (!wantOther || item.note === wantOther) : item.picked === a.labels.some((l) => same(q.options[n]!.label, l));
    if (!right) return { keys: [...to(n), "Space"] };
    return { keys: n === last ? ["Tab"] : to(n + 1), commits: k * 1000 + n };
  }
  return { keys: ["Tab"] };
}
