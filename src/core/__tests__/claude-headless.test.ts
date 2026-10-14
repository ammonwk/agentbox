import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReader } from "../providers/claude";

const dir = mkdtempSync(join(tmpdir(), "agentbox-claude-headless-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESSION = "11111111-2222-3333-4444-777777777777";
let n = 0;
async function headless(entrypoint: string): Promise<boolean | undefined> {
  const path = join(dir, `${SESSION}-${n++}.jsonl`);
  const at = new Date(Date.UTC(2026, 9, 13, 12, 0, n)).toISOString();
  writeFileSync(
    path,
    `${JSON.stringify({ type: "user", entrypoint, sessionId: SESSION, uuid: "u1", timestamp: at, message: { role: "user", content: "Map these PRs to themes." } })}\n`,
  );
  const r = claudeReader({ provider: "claude", accountId: "acct", agentSessionId: SESSION, path, mtimeMs: 0, size: 0 });
  return (await r.refresh()).facts.headless;
}

test("a `claude -p` run is headless; an interactive one is not", async () => {
  expect(await headless("sdk-cli")).toBe(true);
  expect(await headless("cli")).toBe(false);
});
