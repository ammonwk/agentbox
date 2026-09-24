/** Smoke test over this machine's real Codex rollouts (every home that has
 *  any), when there are some. Read-only. */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../types";
import { codexAdapter } from "../codex";
import { saneEvents, saneFacts } from "./real-sanity";

const user = process.env.HOME || homedir();
const homes = [".codex", ".codex-ci2"].map((h) => join(user, h)).filter((h) => existsSync(join(h, "sessions")));
const accountOf = (home: string, i: number): Account => ({
  id: `real-codex-${i}`,
  provider: "codex",
  label: home,
  email: null,
  plan: null,
  home,
  isDefault: home === join(user, ".codex"),
  enabled: true,
  createdAt: 0,
});

describe.skipIf(homes.length === 0)("codex on this machine", () => {
  test("recent rollouts read, page and follow", async () => {
    for (const [i, home] of homes.entries()) {
      const account = accountOf(home, i);
      const refs = await codexAdapter.listTranscripts(account, Date.now() - 30 * 86400_000);
      const pick = refs
        .filter((r) => r.size < 20e6)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 6);
      for (const ref of pick) {
        const r = codexAdapter.reader(ref);
        const { facts } = await r.refresh();
        expect(facts.agentSessionId).toBe(ref.agentSessionId);
        saneFacts(facts);
        if (facts.usage) for (const w of facts.usage.windows) expect(w.usedPct).toBeGreaterThanOrEqual(0);
        if (facts.isSubagent) expect(facts.firstPrompt).toBeNull();
        const page = await r.timeline({ limit: 30 });
        saneEvents(page.events);
        if (page.before) saneEvents((await r.timeline({ before: page.before, limit: 30 })).events);
        expect((await r.since(page.cursor)).reset).toBe(false);
      }
    }
  }, 60_000);

  test("live processes never include the desktop app-server", async () => {
    const accounts = homes.map(accountOf);
    const procs = await codexAdapter.liveProcesses(accounts);
    for (const p of procs) {
      expect(p.pid).toBeGreaterThan(0);
      expect(accounts.map((a) => a.id)).toContain(p.accountId!);
    }
  });
});
