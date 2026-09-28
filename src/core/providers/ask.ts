/** The question wire shape shared by the CLIs that ask you things.
 *
 * Claude's AskUserQuestion and devin's ask_user_question carry the same
 * `questions` payload: `{question, header?, multiSelect?, options:
 * [{label, description?}]}`.
 */

import type { AskQuestion } from "../types";

/** The questions of such a call, or null for input that is not that shape. */
export function askQuestionsOf(input: any): AskQuestion[] | null {
  const qs = input?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    if (typeof q?.question !== "string" || !Array.isArray(q.options)) return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options: q.options
        .filter((o: any) => typeof o?.label === "string")
        .map((o: any) => (typeof o.description === "string" && o.description ? { label: o.label, description: o.description } : { label: o.label })),
    });
  }
  return out;
}
