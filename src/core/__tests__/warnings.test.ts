import { afterEach, describe, expect, test } from "bun:test";
import { ghErrorMessage, run } from "../git";
import { listPrs } from "../prs";
import type { Repo, Session } from "../types";

/**
 * `ColdState.warnings` is the mechanism behind "if `gh` is missing, the UI says
 * `gh` is missing". It had never been non-empty in a running
 * agentbox, which means its whole path was unverified — and it did not work:
 * `Bun.spawnSync` *throws* on a missing binary rather than returning a non-zero
 * exit, so an absent `gh` propagated an exception out of the cold refresh
 * instead of producing the warning.
 *
 * These construct the rejected artifact rather than trusting the classifier:
 * a genuinely unreachable binary, and a genuinely unauthenticated `gh`. Both
 * are offline-safe — `gh` fails its auth check before it opens a socket.
 */

const NO_PATH = { PATH: "/nonexistent" };
/** Point gh at a config dir and home that cannot hold credentials. */
const NO_AUTH = {
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_CONFIG_DIR: "/nonexistent-gh-config",
  HOME: "/nonexistent-home",
};

function repo(fullName: string): Repo {
  return {
    id: fullName, ref: fullName, kind: "github", displayName: fullName,
    fullName, defaultBranch: "main", addedAt: 0,
  };
}

const noSessions: Session[] = [];

describe("run() survives a missing binary", () => {
  test("returns a failed result instead of throwing", () => {
    // The bug: this used to throw ENOENT straight through listPrs.
    let result;
    expect(() => {
      result = run(["gh", "pr", "list"], undefined, NO_PATH);
    }).not.toThrow();
    expect(result!.code).not.toBe(0);
  });

  test("and the failure is classified as 'not installed'", () => {
    const r = run(["gh", "pr", "list"], undefined, NO_PATH);
    expect(ghErrorMessage(r)).toContain("not installed");
  });
});

describe("ghErrorMessage against real gh failures", () => {
  test("an unauthenticated gh is told apart from a missing one", () => {
    const r = run(["gh", "pr", "list", "--repo", "cli/cli"], undefined, NO_AUTH);
    // Guard the premise: if this ever exits 0 the machine is authenticated
    // through a path we did not neutralise, and the assertion below is vacuous.
    expect(r.code).not.toBe(0);
    expect(ghErrorMessage(r)).toContain("gh auth login");
    expect(ghErrorMessage(r)).not.toContain("not installed");
  });

  test("an unclassified failure still yields a real message, never an empty string", () => {
    const message = ghErrorMessage({ code: 1, stdout: "", stderr: "some novel gh failure\n" });
    expect(message).toBe("some novel gh failure");
    expect(ghErrorMessage({ code: 3, stdout: "", stderr: "" })).toContain("3");
  });
});

describe("listPrs surfaces the gap instead of an empty list", () => {
  const realPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = realPath;
  });

  test("a missing gh yields a warning, not a silent zero PRs", () => {
    // Empty `prs` with no warning means "no open pull requests". Empty with a
    // warning means "we could not look". Collapsing those is the bug.
    process.env.PATH = "/nonexistent";
    const scan = listPrs([repo("o/one")], noSessions);
    expect(scan.prs).toEqual([]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain("not installed");
  });

  test("a broken gh says so once, not once per repo", () => {
    // Three repos, one cause. A warning list that repeats itself is noise the
    // user learns to skip.
    process.env.PATH = "/nonexistent";
    const scan = listPrs([repo("o/one"), repo("o/two"), repo("o/three")], noSessions);
    expect(scan.warnings).toHaveLength(1);
  });

  test("no repos means no warnings — there was nothing to fail at", () => {
    process.env.PATH = "/nonexistent";
    expect(listPrs([], noSessions)).toEqual({ prs: [], warnings: [] });
  });
});
