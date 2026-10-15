/** An agent's question is answered from its Chat: the one it asks now is only
 *  the live card, never also an answered row (#40). */
import { expect, test } from "bun:test";
import { chatShown } from "./chatPresentation";
import type { TimelineEvent } from "../../../../src/core/types";

test("an agent's Chat shows its questions, and the one asked now only as the card (#40)", () => {
  const questions = [{ question: "Which branch?", header: "Branch", multiSelect: false, options: [{ label: "main" }] }];
  const events: TimelineEvent[] = [
    { id: "u", at: 1, kind: "user", text: "Fix it" },
    { id: "bash", at: 2, kind: "tool", name: "Bash", summary: "ls", status: "ok" },
    { id: "asked", at: 3, kind: "tool", name: "AskUserQuestion", summary: "", status: "ok", ask: { id: "q1", questions, answers: { "Which branch?": "main" } } },
    { id: "a", at: 4, kind: "assistant", text: "On main." },
    { id: "asking", at: 5, kind: "tool", name: "AskUserQuestion", summary: "", status: "running", ask: { id: "q2", questions } },
  ];
  expect(chatShown(events, "q2").map((e) => e.id)).toEqual(["u", "asked", "a"]);
  expect(chatShown(events, null).map((e) => e.id)).toEqual(["u", "asked", "a", "asking"]);
});
