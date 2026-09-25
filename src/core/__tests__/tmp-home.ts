import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point `AGENTBOX_HOME` at a throwaway directory for the life of one suite.
 *
 * Any suite that reaches `worktreeRoot()`, `dbPath()`, `accountsRoot()` or
 * `ensureDirs()` — directly or three calls down — must use this. Without it the
 * test writes into the developer's live agentbox data: real worktrees, real
 * account homes, the real database. That is a bug even when the test is green,
 * because nothing about a passing run tells you it happened.
 *
 * Call it from `beforeAll` and `restore()` from `afterAll`. Since paths.ts
 * resolves the env on every call, setting it here genuinely takes effect no
 * matter which file bun loaded first — which was not true when the paths were
 * module-scope constants.
 *
 * Not named `*.test.ts`, so bun does not collect it as a suite.
 */
export function useTempHome(): { home: string; restore: () => void } {
  const previous = process.env.AGENTBOX_HOME;
  const home = mkdtempSync(join(tmpdir(), "agentbox-home-"));
  process.env.AGENTBOX_HOME = home;
  return {
    home,
    restore() {
      // Restoring "unset" would re-arm the landmine: the next suite to reach a
      // path — including one that forgot this helper, which is the case that
      // fails green — would fall back to the developer's real data directory.
      // Once any suite has asked for isolation, the process keeps a safe
      // default for the rest of the run.
      process.env.AGENTBOX_HOME = previous ?? sharedFallbackHome();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * A process-wide throwaway home, created on first need. This is a backstop, not
 * isolation — suites that want their own directory call `useTempHome()`. Its
 * only job is to make sure `AGENTBOX_HOME` is never unset again once the suite
 * has started caring.
 */
let fallback: string | null = null;
function sharedFallbackHome(): string {
  if (fallback) return fallback;
  fallback = mkdtempSync(join(tmpdir(), "agentbox-test-fallback-"));
  const dir = fallback;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return fallback;
}
