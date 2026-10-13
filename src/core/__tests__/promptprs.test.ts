import { expect, test } from "bun:test";
import type { PrInfo } from "../types";
import { promptPrs } from "../../../web/src/lib/newsession";

const prs = [1, 12, 6759, 6760].map((number) => ({ number }) as PrInfo);
const named = (text: string) => promptPrs(text, prs, "acme/app");

test("a pasted image's token is never a PR, sent or not", () => {
  expect(named("[Image #1] make the bar adapt")).toEqual([]);
  expect(named("[Image #1: /home/me/uploads/20261010-30a1.png] make the bar adapt [Image #12]")).toEqual([]);
  // Even in a prompt that is about PRs.
  expect(named("[Image #1] this is what PR 6759 does")).toEqual([6759]);
});

test("a short number is a PR only when the prompt says PR", () => {
  expect(named("do step #1, then 12 more")).toEqual([]);
  expect(named("fix #12 and rebase the PR")).toEqual([12]);
  expect(named("look at pull request 12")).toEqual([12]);
  expect(named("express the #1 priority")).toEqual([]);
});

test("a number of four digits that is an open PR is one without the word", () => {
  expect(named("finish #6759 and 6760")).toEqual([6759, 6760]);
  expect(named("finish #6761")).toEqual([]);
  expect(named("read issue #6759")).toEqual([]);
});
