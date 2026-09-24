/** Smoke test against this machine's real omp data. Read-only; skipped when
 *  omp has never run here. `omp usage` hits the network, so that part runs
 *  only with AGENTBOX_REAL_OMP_USAGE=1. */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Account } from "../../types";
import { ompAdapter, ompUsage, sessionsRootOf } from "../omp";

const home = ompAdapter.defaultHome();
const account: Account = { id: "omp-default", provider: "omp", label: "omp", email: null, plan: null, home, isDefault: true, enabled: true, createdAt: 0 };
const present = existsSync(sessionsRootOf(account));

describe.skipIf(!present)("omp (real data)", () => {
  test("lists sessions and reads a few, incrementally", async () => {
    const refs = await ompAdapter.listTranscripts(account, 0);
    expect(refs.length).toBeGreaterThan(0);
    const t = performance.now();
    await ompAdapter.listTranscripts(account, Date.now() - 86_400_000);
    // Stat-level: a cached readdir per slug dir and a stat per session.
    expect(performance.now() - t).toBeLessThan(500);

    refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const ref of refs.slice(0, 5)) {
      const r = ompAdapter.reader(ref);
      const { facts } = await r.refresh();
      expect(facts.agentSessionId).toBe(ref.agentSessionId);
      expect(facts.isSubagent).toBe(false);
      expect(facts.tokens.costEquiv).toBeGreaterThanOrEqual(0);
      const page = await r.timeline({ limit: 30 });
      const ids = page.events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      if (page.before) {
        const older = await r.timeline({ before: page.before, limit: 30 });
        expect(older.events.every((e) => !ids.includes(e.id))).toBe(true);
      }
      const inc = await r.since(page.cursor);
      expect(inc.reset).toBe(false);
      expect(await ompAdapter.findTranscript(account, ref.agentSessionId)).not.toBeNull();
    }
  });

  test("liveProcesses answers without throwing", async () => {
    const live = await ompAdapter.liveProcesses([account]);
    const ids = live.map((p) => p.agentSessionId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.skipIf(!process.env.AGENTBOX_REAL_OMP_USAGE)(
    "omp usage --json maps to windows",
    async () => {
      const u = await ompUsage(account.id);
      expect(u.stale).toBeNull();
      for (const w of u.windows) {
        expect(w.usedPct).toBeGreaterThanOrEqual(0);
        expect(w.usedPct).toBeLessThanOrEqual(100);
      }
    },
    30_000,
  );
});
