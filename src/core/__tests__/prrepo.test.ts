import { describe, expect, test } from "bun:test";
import { prReposIn, PrRepoFold } from "../prrepo";

describe("prReposIn", () => {
  test("gh's -R and --repo", () => {
    expect(prReposIn("gh pr view 7251 -R acme-corp/web-app --json title")).toEqual(["acme-corp/web-app"]);
    expect(prReposIn(`gh pr checks 7074 --repo "acme-corp/web-app"`)).toEqual(["acme-corp/web-app"]);
    expect(prReposIn("gh api --repo=owner/name.git")).toEqual(["owner/name"]);
    expect(prReposIn(`for n in 6902 7081; do gh pr view $n -R acme/app; done`)).toEqual(["acme/app"]);
  });

  test("PR URLs and the API's repos/ path", () => {
    expect(prReposIn("opened https://github.com/acme/app/pull/12.")).toEqual(["acme/app"]);
    expect(prReposIn("gh api repos/acme/app/pulls/12/comments")).toEqual(["acme/app"]);
  });

  test("in the order named", () => {
    expect(prReposIn("github.com/a/one/pull/1 then gh pr view 2 -R b/two")).toEqual(["a/one", "b/two"]);
    expect(prReposIn("gh pr view 2 -R b/two, then github.com/a/one/pull/1")).toEqual(["b/two", "a/one"]);
  });

  test("not a -R outside gh, a bare owner/name, a repo page or an issue", () => {
    expect(prReposIn("cp -R src/core dist")).toEqual([]);
    expect(prReposIn("gh pr list | xargs cp -R a/b")).toEqual([]);
    expect(prReposIn("acme-corp/web-app is the repo")).toEqual([]);
    expect(prReposIn("https://github.com/acme/app")).toEqual([]);
    expect(prReposIn("upstream bug: https://github.com/anthropics/claude-code/issues/95764")).toEqual([]);
  });
});

describe("PrRepoFold", () => {
  test("the most named wins over the latest", () => {
    const f = new PrRepoFold();
    f.add("gh pr view 1 -R acme/app");
    f.add("gh pr checks 1 -R acme/app");
    f.add("like upstream's github.com/other/lib/pull/9");
    f.add("merged #1");
    expect(f.repo).toBe("acme/app");
  });

  test("a tie goes to the latest named", () => {
    const f = new PrRepoFold();
    f.add("github.com/a/one/pull/1");
    f.add("gh pr view 2 -R b/two");
    expect(f.repo).toBe("b/two");
    f.add("github.com/a/one/pull/3");
    expect(f.repo).toBe("a/one");
  });

  test("none named, none", () => {
    const f = new PrRepoFold();
    f.add(undefined);
    f.add("fixed #12");
    expect(f.repo).toBeNull();
  });
});
