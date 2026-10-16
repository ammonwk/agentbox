/** The footer's plans (#33): the bar shows a few, the sheet it opens all of them. */
import { expect, test } from "bun:test";
import type { AccountView } from "../../../src/core/types";
import { recentAccounts } from "./plans";

const account = (id: string, at: number, enabled = true) => ({ id, enabled, createdAt: 0, usage: { at } }) as unknown as AccountView;
const accounts = [account("a", 1), account("b", 2), account("c", 3), account("d", 4), account("e", 5), account("f", 6), account("g", 7), account("h", 8), account("off", 9, false)];
const sessions = [{ accountId: "a", lastActivityAt: 100, startedAt: 0 }];

test("the sheet lists every enabled account, most recently used first", () => {
  expect(recentAccounts(accounts, sessions, null).map((a) => a.id)).toEqual(["a", "h", "g", "f", "e", "d", "c", "b"]);
});

test("the bar keeps a few, and always the open session's account", () => {
  expect(recentAccounts(accounts, sessions, null, 6).map((a) => a.id)).toEqual(["a", "h", "g", "f", "e", "d"]);
  expect(recentAccounts(accounts, sessions, "b", 6).map((a) => a.id)).toEqual(["a", "h", "g", "f", "e", "b"]);
});
