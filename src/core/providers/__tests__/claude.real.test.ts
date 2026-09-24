/** Smoke test over this machine's real Claude transcripts, when there are any.
 *  Read-only: it lists, reads and pages; it never writes to ~/.claude. */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../types";
import { claudeAdapter } from "../claude";
import { saneEvents, saneFacts } from "./real-sanity";

const home = join(process.env.HOME || homedir(), ".claude");
const present = existsSync(join(home, "projects"));
const account: Account = {
  id: "real-claude",
  provider: "claude",
  label: "real",
  email: null,
  plan: null,
  home,
  isDefault: true,
  enabled: true,
  createdAt: 0,
};

describe.skipIf(!present)("claude on this machine", () => {
  test("recent transcripts read, page and follow", async () => {
    const t0 = performance.now();
    const refs = await claudeAdapter.listTranscripts(account, Date.now() - 3 * 86400_000);
    expect(performance.now() - t0).toBeLessThan(2000);
    const pick = refs
      .filter((r) => r.size < 20e6)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);
    for (const ref of pick) {
      const r = claudeAdapter.reader(ref);
      const { facts } = await r.refresh();
      expect(facts.agentSessionId).toBe(ref.agentSessionId);
      expect(facts.isSubagent).toBe(false);
      saneFacts(facts);
      const page = await r.timeline({ limit: 30 });
      saneEvents(page.events);
      if (page.before) saneEvents((await r.timeline({ before: page.before, limit: 30 })).events);
      const s = await r.since(page.cursor);
      expect(s.reset).toBe(false);
    }
  }, 60_000);

  test("live processes are attributed and verified", async () => {
    const procs = await claudeAdapter.liveProcesses([account]);
    for (const p of procs) {
      expect(p.pid).toBeGreaterThan(0);
      expect(p.accountId).toBe("real-claude");
      if (p.agentSessionId) expect(p.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
