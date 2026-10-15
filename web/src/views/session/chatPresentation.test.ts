/** An agent's question is answered from its Chat: the one it asks now is only
 *  the live card, never also an answered row (#40). */
import { expect, test } from "bun:test";
import { chatShown, personsOpening } from "./chatPresentation";
import type { TimelineEvent } from "../../../../src/core/types";
import { OPENING_SEPARATOR } from "../../../../src/core/superagent/marks";

test("an agent's Chat shows its questions, and the one asked now only as the card (#40)", () => {
  const questions = [{ question: "Which branch?", header: "Branch", multiSelect: false, options: [{ label: "main" }] }];
  const events: TimelineEvent[] = [
    { id: "u", at: 1, kind: "user", text: "Fix it" },
    { id: "note", at: 1, kind: "user", text: "[agentbox: memory checkpoint 6b6b4061-a26f-4b8e-b4ff-97796b617d5d] The user has been away for 15 minutes." },
    { id: "bash", at: 2, kind: "tool", name: "Bash", summary: "ls", status: "ok" },
    { id: "asked", at: 3, kind: "tool", name: "AskUserQuestion", summary: "", status: "ok", ask: { id: "q1", questions, answers: { "Which branch?": "main" } } },
    { id: "a", at: 4, kind: "assistant", text: "On main." },
    { id: "asking", at: 5, kind: "tool", name: "AskUserQuestion", summary: "", status: "running", ask: { id: "q2", questions } },
  ];
  expect(chatShown(events, "q2").map((e) => e.id)).toEqual(["u", "asked", "a"]);
  expect(chatShown(events, null).map((e) => e.id)).toEqual(["u", "asked", "a", "asking"]);
});

test("a main's first message shows what the person wrote, not the instructions before it", () => {
  const events: TimelineEvent[] = [
    { id: "u", at: 1, kind: "user", text: `You keep notes.\n\n---\n\nSOUL${OPENING_SEPARATOR}What is due today?\n\n---\n\nThe rest${OPENING_SEPARATOR}stays.` },
    { id: "a", at: 2, kind: "assistant", text: "Nothing." },
  ];
  // A markdown rule, or the separator itself, in the person's message stays in it.
  expect(personsOpening(events, true)[0]).toMatchObject({ text: `What is due today?\n\n---\n\nThe rest${OPENING_SEPARATOR}stays.` });
  // A main started before the unique separator: its last rule ends the prompt.
  const old: TimelineEvent[] = [{ id: "u", at: 1, kind: "user", text: "You keep notes.\n\n---\n\nWhat is due today?" }];
  expect(personsOpening(old, true)[0]).toMatchObject({ text: "What is due today?" });
  expect(personsOpening(events, false)[0]).toMatchObject({ text: events[0]!.kind === "user" ? events[0]!.text : "" });
});
