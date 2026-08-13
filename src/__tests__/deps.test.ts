/** The three `gh` states, including the one that has never happened on this
 * machine. An installed-but-logged-out `gh` is the case that actually bites:
 * PR data goes silently absent app-wide and the old check reported `true`. */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencies, probeGh } from "../deps";

const realPath = process.env.PATH ?? "";
const stubDir = mkdtempSync(join(tmpdir(), "agentbox-deps-"));

/** Put a fake `gh` on PATH that answers however the test needs. */
function stubGh(script: string): void {
  const file = join(stubDir, "gh");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = stubDir;
}

beforeEach(() => {
  process.env.PATH = realPath;
});

afterAll(() => {
  process.env.PATH = realPath;
  rmSync(stubDir, { recursive: true, force: true });
});

describe("probeGh", () => {
  test("missing when gh is not on PATH at all", () => {
    process.env.PATH = stubDir; // empty: no gh, no anything
    expect(probeGh()).toEqual({
      state: "missing",
      detail: expect.stringContaining("not installed") as unknown as string,
    });
  });

  // The whole reason this function exists: present-but-unusable must not
  // report as either neighbour.
  test("unusable — not missing, not ok — when gh is installed but logged out", () => {
    stubGh('echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2\nexit 1');
    const got = probeGh();
    expect(got.state).toBe("unusable");
    expect(got.detail).toContain("gh auth login");
    expect(got.detail).toContain("Pull requests are invisible");
  });

  test("unusable carries the real reason when it is not an auth failure", () => {
    stubGh('echo "error connecting to api.github.com" >&2\nexit 1');
    const got = probeGh();
    expect(got.state).toBe("unusable");
    expect(got.detail).toContain("api.github.com");
  });

  test("ok, and names the account when gh reports one", () => {
    stubGh('echo "github.com\n  ✓ Logged in to github.com account octocat (keyring)"\nexit 0');
    expect(probeGh()).toEqual({ state: "ok", detail: "authenticated as octocat" });
  });

  test("ok without an account line still reports ok", () => {
    stubGh("exit 0");
    expect(probeGh()).toEqual({ state: "ok", detail: "authenticated" });
  });
});

describe("dependencies", () => {
  test("caches, and `force` re-probes", () => {
    stubGh("exit 0");
    const first = dependencies(true);
    expect(first.gh.state).toBe("ok");

    // Change the world; the cache must not notice on its own.
    stubGh("exit 1");
    expect(dependencies().gh.state).toBe("ok");
    expect(dependencies().at).toBe(first.at);

    const forced = dependencies(true);
    expect(forced.gh.state).toBe("unusable");
    expect(forced.at).toBeGreaterThanOrEqual(first.at);
  });
});
