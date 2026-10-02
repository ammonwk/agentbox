import { describe, expect, test } from "bun:test";
import { prRefs, prUrl } from "../../../web/src/lib/prlinks";

const linked = (text: string, code = false) => prRefs(text, code).map((r) => text.slice(r.start, r.end));

describe("prRefs", () => {
  test("a # or a PR before a number links it, whatever punctuation follows", () => {
    expect(linked("like #7654: #7653. #7543) etc")).toEqual(["#7654", "#7653", "#7543"]);
    expect(linked("see #7653/#7654, #7655;#7656 (#7657), [#7658], **#7659**, #7660's")).toEqual([
      "#7653", "#7654", "#7655", "#7656", "#7657", "#7658", "#7659", "#7660",
    ]);
    expect(linked("#7654-ish and #7654— and 1.#7654 and #12")).toEqual(["#7654", "#7654", "#7654", "#12"]);
    expect(linked("PR 7654, PR #7655, PR-7656, PR: 7657, PR#7658, pr7659, pull request 7660")).toEqual([
      "PR 7654", "PR #7655", "PR-7656", "PR: 7657", "PR#7658", "pr7659", "pull request 7660",
    ]);
  });

  test("gh pr commands link the number", () => {
    expect(linked("ran gh pr view 7654 and gh pr merge 7655 --squash")).toEqual(["7654", "7655"]);
  });

  test("owner/repo#N names its repo", () => {
    const [r] = prRefs("see plaibook-dev/plaibook-platform#7654.");
    expect(r).toMatchObject({ number: 7654, repo: "plaibook-dev/plaibook-platform" });
    expect(prUrl("https://github.com/a/b", r!.number, r!.repo)).toBe("https://github.com/plaibook-dev/plaibook-platform/pull/7654");
    expect(prUrl("https://github.com/a/b", 12)).toBe("https://github.com/a/b/pull/12");
  });

  test("bare four-digit numbers, loosely", () => {
    expect(linked("PRs 7653, 7654 and 7655")).toEqual(["PRs 7653", "7654", "7655"]);
    expect(linked("7653/7654 then 7655: done")).toEqual(["7653", "7654", "7655"]);
  });

  test("leaves what is plainly not a PR", () => {
    expect(linked("in 2024, at 12:30, v1.2345, /tmp/7654/x, gac-6644, 6644-fix, port :4479, 55%, 1234ms")).toEqual([]);
    expect(linked("#7654abc abc#7654 &#1234; 123456 #7654.5")).toEqual([]);
  });

  test("in inline code only a prefixed number counts", () => {
    expect(linked("#7654", true)).toEqual(["#7654"]);
    expect(linked("PR 7654", true)).toEqual(["PR 7654"]);
    expect(linked("sleep 3000", true)).toEqual([]);
  });
});
