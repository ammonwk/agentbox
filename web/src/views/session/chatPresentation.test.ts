/** A creation or recommendation card is part of the conversation: it must sit
 *  at its time and scroll with the chat, not stay under the newest message. */
import { expect, test } from "bun:test";
import { chatShown, placeCards } from "./chatPresentation";
import type { TimelineEvent } from "../../../../src/core/types";

const messages = [{ id: "ask", at: 100 }, { id: "reply", at: 200 }, { id: "later", at: 300 }];

test("a card sits before the first message newer than it, and a newer one comes last", () => {
  const { before, after } = placeCards(messages, [{ id: "draft", at: 150 }, { id: "fresh", at: 400 }, { id: "first", at: 50 }], false);
  expect(before.get("reply")?.map((c) => c.id)).toEqual(["draft"]);
  expect(before.get("ask")?.map((c) => c.id)).toEqual(["first"]);
  expect(before.has("later")).toBe(false);
  expect(after.map((c) => c.id)).toEqual(["fresh"]);
});

test("a card older than the loaded page waits for that page", () => {
  const { before, after } = placeCards(messages, [{ id: "old", at: 50 }], true);
  expect([...before.keys(), ...after]).toEqual([]);
});

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
