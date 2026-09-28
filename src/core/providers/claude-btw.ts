/** Claude's /btw panel, read off its screen.
 *
 * A side question is never written anywhere: Claude asks it as a one-off
 * request on the main thread's cached prefix and keeps the answer in memory
 * (the last 20, gone when the process exits). The panel, as 2.1 draws it
 * under the conversation:
 *
 *     /btw an earlier question                 (dim; the history)
 *     /btw the question being answered
 *
 *       Answering…                             (then the answer, all at once)
 *
 *     ⇧←/→ to browse · x to clear history · Esc to close            (asking)
 *     ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close
 *     ↑/↓ to scroll · Copied to clipboard · f to fork · Esc to close
 *
 * `c` copies the answer's markdown, and inside tmux Claude copies with
 * `tmux load-buffer`, so the answer lands whole in a paste buffer: that is
 * how agentbox reads it, never off the screen.
 */

import { plainScreen } from "./tui-screen";

export interface BtwPanel {
  /** The newest question, as shown: one line, cut to the width with "…". */
  question: string | null;
  state: "asking" | "answered" | "failed";
  /** What the panel says went wrong, when it failed. */
  error?: string;
}

const QUESTION = /^\s*\/btw\s+(.*)$/;
const FAILED = /(Failed to get response|No response received)/;

export function readBtwPanel(raw: string): BtwPanel | null {
  const lines = plainScreen(raw).split("\n").map((l) => l.replace(/\s+$/, ""));
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/Esc to (close|cancel)/.test(lines[i]!)) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  let asked = -1;
  for (let i = footer - 1; i >= 0; i--) {
    if (QUESTION.test(lines[i]!)) {
      asked = i;
      break;
    }
  }
  if (asked < 0) return null;
  const question = QUESTION.exec(lines[asked]!)![1]!.trim() || null;
  const foot = lines[footer]!;
  if (/c to copy|Copied to clipboard/.test(foot)) return { question, state: "answered" };
  const failed = lines.slice(asked + 1, footer).find((l) => FAILED.test(l));
  if (failed) return { question, state: "failed", error: failed.trim() };
  return { question, state: "asking" };
}

/** The panel is showing `question`: the same words, allowing for the cut-off tail. */
export function showsQuestion(panel: BtwPanel, question: string): boolean {
  if (!panel.question) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const shown = norm(panel.question).replace(/…$/, "");
  const q = norm(question);
  return shown === q || (shown.length >= 12 && q.startsWith(shown));
}
