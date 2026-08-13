import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentboxHome } from "../paths";
import { useTempHome } from "./tmp-home";

/**
 * The guard for the guard. Everything this helper protects fails *silently* —
 * a suite that writes into the developer's real agentbox data still passes —
 * so the helper's own contract has to be pinned by something that can fail.
 */

const REAL_HOME = join(homedir(), ".local", "share", "agentbox");

let outer: ReturnType<typeof useTempHome> | null = null;
afterEach(() => {
  outer?.restore();
  outer = null;
});

describe("useTempHome", () => {
  test("takes effect immediately, without any import-order ceremony", () => {
    // paths.ts resolves the env per call, so the override binds here and now.
    // When these were module-scope constants this assertion was unwritable.
    outer = useTempHome();
    expect(agentboxHome()).toBe(outer.home);
  });

  test("restore() never leaves AGENTBOX_HOME pointing at the real home", () => {
    // The bug supervisor found: `delete process.env.AGENTBOX_HOME` handed the
    // next suite the developer's live data directory. A suite that forgot the
    // helper would then write there and still pass.
    const before = process.env.AGENTBOX_HOME;
    const h = useTempHome();
    h.restore();
    expect(agentboxHome()).not.toBe(REAL_HOME);
    if (before === undefined) {
      // Nothing to restore to, so the backstop must have supplied something.
      expect(process.env.AGENTBOX_HOME).toBeDefined();
      expect(existsSync(process.env.AGENTBOX_HOME!)).toBe(true);
    } else {
      expect(process.env.AGENTBOX_HOME).toBe(before);
    }
  });

  test("restore() hands back an enclosing suite's home rather than a fallback", () => {
    // Nesting must be transparent: an inner suite's cleanup cannot disturb the
    // pin an outer one is relying on.
    outer = useTempHome();
    const inner = useTempHome();
    expect(agentboxHome()).toBe(inner.home);
    inner.restore();
    expect(agentboxHome()).toBe(outer.home);
  });

  test("the temp directory is really gone after restore()", () => {
    const h = useTempHome();
    expect(existsSync(h.home)).toBe(true);
    h.restore();
    expect(existsSync(h.home)).toBe(false);
  });
});
