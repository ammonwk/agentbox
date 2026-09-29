/** A `.env`-shaped file: `KEY=value` lines, blank lines and `#` comments
 *  ignored, an optional layer of quotes stripped. Shared by the files in the
 *  agentbox home (`voice.env`, `user.env`) so there is one reader and one
 *  dialect, and read on every call rather than cached, so an edit takes
 *  effect without a restart — the same call-time discipline as paths.ts.
 */

import { existsSync, readFileSync } from "node:fs";

export function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return env;
}
