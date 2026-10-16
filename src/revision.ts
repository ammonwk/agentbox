/** Capture the checkout at process/build start, not when feedback is submitted. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
export function sourceRevision(): { commit: string; dirty: boolean } | null {
  try {
    const options = { cwd: root, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], encoding: "utf8" as const };
    const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    return { commit, dirty: !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], options).trim() };
  } catch { return null; }
}
export const RUNNING_REVISION = sourceRevision();
