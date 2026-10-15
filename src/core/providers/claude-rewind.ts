/** Going back to one of your messages in Claude's TUI: its rewind, read off the screen.
 *
 * Esc Esc on an empty input box (a draft is cleared by the first pair) opens
 * the list, pointer on "(current)" at the bottom; each Up moves one message
 * back, and only three show at a time:
 *
 *   Rewind
 *   Restore the code and/or conversation to the point before…
 *     ↑ 1 more
 *     Reply with just: two
 *     No code changes
 *   ❯ !  echo three
 *     No code changes
 *     ↓ 1 more
 *   Enter to continue · Esc to cancel
 *
 * Enter asks what to restore, numbered, and the numbers move with what the
 * message's turn changed ("Restore code" options only when it edited files):
 *
 *   Confirm you want to restore to the point before you sent this message:
 *   │ Write the word one into note.txt
 *   │ (44s ago)
 *   The conversation will be forked.
 *   The code will be unchanged.
 *   ❯ 1. Restore conversation          (or 1. Restore code and conversation,
 *     2. Summarize from here               2. Restore conversation, 3. Restore code, …)
 *     3. Summarize up to here
 *     4. Never mind
 *
 * Restoring puts the message back in the input box, to be replaced. Nothing
 * is written to the transcript until the next message, which continues from
 * the record before the one gone back to (`branches.ts`).
 *
 * The message is found by its first line, as the list shows it, and which of
 * the messages with that line it is, counting from the newest; a pasted one
 * the list cannot be matched against is found by its place instead. One
 * step at a time, reading the screen after each, as `claude-ask.ts` does.
 */

import { norm } from "../termseek";
import type { Turn } from "../types";
import { plainScreen } from "./tui-screen";

export interface RewindGoal {
  /** The message's first line, normalised (`norm`); empty when the list cannot show it recognisably. */
  key: string;
  /** Which of the messages with that first line, from the newest: 1 is the newest. */
  nth: number;
  /** Its place among your messages, from the newest: 1 is the last one. */
  pos: number;
  /** Put the files back as they were before it, too. */
  code: boolean;
}

export interface RewindState {
  /** Esc Esc pairs pressed to open the list. */
  opens: number;
  /** Ups pressed in the list. */
  ups: number;
  /** Messages passed that match `key`. */
  seen: number;
  /** The list as last seen, to tell the top (Up changes nothing) from a step. */
  last: string | null;
  /** The restore option was pressed. */
  picked: boolean;
  /** It was "Restore code and conversation". */
  code: boolean;
}

export const rewindStart = (): RewindState => ({ opens: 0, ups: 0, seen: 0, last: null, picked: false, code: false });

export type RewindStep = { keys: string[] } | { done: true; code: boolean } | { error: string };

const LIST = /Restore the code and\/or conversation to the point before/;
const CONFIRM = /Confirm you want to restore to the point before you sent this message/;
/** The list's rows with the pointer. */
const POINTED = /^\s*❯\s+(.*?)\s*$/;
const OPTION = /^\s*(?:❯\s+)?(\d+)\.\s+(.+?)\s*$/;
const QUOTED = /^\s*│\s?(.*?)\s*$/;
/** Rows past one message back: Up with the list at its top changes nothing. */
const SLACK = 40;

/** The list's own rows: from its heading to its footer. */
function listRows(lines: readonly string[], heading: RegExp): string[] | null {
  const top = lines.findIndex((l) => heading.test(l));
  if (top < 0) return null;
  const rows: string[] = [];
  for (let i = top + 1; i < lines.length; i++) {
    if (/Enter to continue|Esc to cancel/.test(lines[i]!)) break;
    rows.push(lines[i]!);
  }
  return rows;
}

/** A row of the list is the message: its first line, or as much as fits, ending in `…`. */
export function shownAs(row: string, key: string): boolean {
  const r = norm(row);
  if (!r || !key) return false;
  if (r === key) return true;
  return r.length >= 8 && (key.startsWith(r) || (key.length >= 8 && r.startsWith(key)));
}

/** The first line a list shows of a message: what `shownAs` matches. */
const firstLine = (t: Turn): string => norm(t.text.split("\n").find((l) => l.trim() !== "") ?? "");

/**
 * What to go back to, for the message `turnId` among the conversation's
 * messages (`turns.ts`, the conversation as it stands): its first line, which
 * of the messages with that first line it is, and its place, all counted
 * from the newest. Answers to a question are not messages a rewind lists.
 * A string says why it cannot be gone back to.
 */
export function rewindGoalOf(turns: readonly Turn[], turnId: string, code: boolean): RewindGoal | string {
  const at = turns.findIndex((t) => t.id === turnId);
  if (at === -1) return "no such message in the conversation as it stands";
  const target = turns[at]!;
  if (target.kind === "answer") return "an answer to the agent's question is not a message it can go back to";
  const after = turns.slice(at).filter((t) => t.kind !== "answer");
  // Only images: the list shows them as tags, which only the place can match.
  const key = /^\(\d+ images?\)$/.test(target.text) ? "" : firstLine(target);
  const nth = key ? after.filter((t) => shownAs(firstLine(t), key)).length : 0;
  return { key, nth, pos: after.length, code };
}

export function claudeRewindStep(raw: string, goal: RewindGoal, st: RewindState): RewindStep {
  const lines = plainScreen(raw).split("\n");
  const screen = lines.join("\n");

  if (CONFIRM.test(screen)) {
    const rows = listRows(lines, CONFIRM) ?? [];
    const quoted = rows.map((l) => QUOTED.exec(l)?.[1]).find((t) => t !== undefined && t !== "");
    if (goal.key && quoted && !shownAs(quoted, goal.key)) return { error: `Claude offered to go back to another message ("${quoted}")` };
    const options = new Map<string, string>();
    for (const l of rows) {
      const m = OPTION.exec(l);
      if (m) options.set(m[2]!, m[1]!);
    }
    const both = options.get("Restore code and conversation");
    const conversation = options.get("Restore conversation");
    const digit = goal.code && both ? both : conversation;
    if (!digit) return { error: "Claude did not offer to restore the conversation" };
    st.picked = true;
    st.code = digit === both;
    return { keys: [digit] };
  }

  if (LIST.test(screen)) {
    const rows = listRows(lines, LIST) ?? [];
    const region = rows.join("\n");
    const pointed = rows.map((l) => POINTED.exec(l)?.[1]).find((t) => t !== undefined);
    if (pointed === undefined) return { error: "cannot see which message Claude's rewind list points at" };
    if (st.last !== null && region === st.last) return { error: "the message is not in Claude's rewind list" };
    st.last = region;
    if (pointed !== "(current)") {
      // A long paste is listed as its placeholder, which only its place can match.
      const placeholder = /^\[Pasted text\b/.test(pointed);
      if (goal.key && !placeholder ? shownAs(pointed, goal.key) && ++st.seen === goal.nth : st.ups === goal.pos) return { keys: ["Enter"] };
    }
    if (st.ups > goal.pos + SLACK) return { error: "the message is not in Claude's rewind list" };
    st.ups++;
    return { keys: ["Up"] };
  }

  // Neither: the input box. Back to it after picking means it is restored.
  if (st.picked) return { done: true, code: st.code };
  if (st.opens >= 3) return { error: "Claude's rewind list did not open" };
  st.opens++;
  return { keys: ["Escape", "Escape"] };
}

/** Claude's input box holds nothing: a `❯` line under a rule, with no text after it, and the rule under it. */
export function claudeInputEmpty(raw: string): boolean {
  const lines = plainScreen(raw).split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^❯/.test(lines[i]!) || !/^─{20,}\s*$/.test(lines[i - 1]!)) continue;
    return lines[i]!.slice(1).trim() === "" && /^─{20,}\s*$/.test(lines[i + 1] ?? "");
  }
  return false;
}

/** Is the rewind list or its confirmation showing? */
export const claudeRewindOpen = (raw: string): boolean => {
  const s = plainScreen(raw);
  return LIST.test(s) || CONFIRM.test(s);
};
