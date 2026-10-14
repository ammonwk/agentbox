/** A creation or recommendation card is part of the conversation: it must sit
 *  at its time and scroll with the chat, not stay under the newest message. */
import { expect, test } from "bun:test";
import { placeCards } from "./chatPresentation";

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
