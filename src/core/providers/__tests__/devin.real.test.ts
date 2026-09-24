/** Smoke test against this machine's real devin data. Read-only; skipped when
 *  devin has never run here. Checks shape and consistency, not content. */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "../../types";
import { devinAdapter } from "../devin";
import { closeDevinDbs } from "../devin-db";

const home = devinAdapter.defaultHome();
const present = existsSync(join(home, "devin", "cli", "sessions.db"));
const account: Account = { id: "devin-default", provider: "devin", label: "devin", email: null, plan: null, home, isDefault: true, enabled: true, createdAt: 0 };

afterAll(closeDevinDbs);

describe.skipIf(!present)("devin (real data)", () => {
  test("lists sessions cheaply and reads the newest ones", async () => {
    const t0 = performance.now();
    const refs = await devinAdapter.listTranscripts(account, 0);
    expect(refs.length).toBeGreaterThan(0);
    const t1 = performance.now();
    await devinAdapter.listTranscripts(account, Date.now() - 86_400_000);
    // The every-2s poll: a couple of indexed queries and a few stats.
    expect(performance.now() - t1).toBeLessThan(250);
    expect(t1 - t0).toBeLessThan(5000);

    refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const ref of refs.slice(0, 5)) {
      expect(ref.provider).toBe("devin");
      const r = devinAdapter.reader(ref);
      const { changed, facts } = await r.refresh();
      expect(changed).toBe(true);
      expect(facts.agentSessionId).toBe(ref.agentSessionId);
      expect(facts.cwd).toBeTruthy();
      expect(facts.isSubagent).toBe(false);
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "costEquiv"] as const) {
        expect(facts.tokens[k]).toBeGreaterThanOrEqual(0);
      }
      const page = await r.timeline({ limit: 20 });
      expect(page.events.length).toBeLessThanOrEqual(20);
      if (ref.path.endsWith(".json")) expect(page.events.length).toBeGreaterThan(0);
      const ids = page.events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect((await r.since(page.cursor)).events).toEqual([]);
      expect((await r.refresh()).changed).toBe(false);
      expect(await devinAdapter.findTranscript(account, ref.agentSessionId)).not.toBeNull();
    }
  });

  test("liveProcesses answers without throwing", async () => {
    const live = await devinAdapter.liveProcesses([account]);
    for (const p of live) {
      expect(p.pid).toBeGreaterThan(0);
      expect(typeof p.cwd).toBe("string");
    }
  });
});
