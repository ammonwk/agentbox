/** → from the rail waits for the page it opens before it moves focus (#36). */
import { expect, test } from "bun:test";
import { pageSettled } from "./keyboard";

/** The address bar after a navigation; hrefOf reads its scope from there. */
function at(hash: string): string {
  (globalThis as { location?: unknown }).location = { hash };
  return hash;
}

test("a link that redirects settles on the page it lands on", () => {
  // → clicked #/agents; the page then replaced it with an agent's chat.
  const now = at("#/agents/vulcan/chat/abc?project=p1");
  expect(pageSettled("#/agents/vulcan/chat/abc?project=p1", now)).toBe(true);
});

test("the page before the click is not settled", () => {
  const now = at("#/agents?project=p1");
  expect(pageSettled("#/sessions?project=p1", now)).toBe(false);
  expect(pageSettled(undefined, now)).toBe(false);
});
