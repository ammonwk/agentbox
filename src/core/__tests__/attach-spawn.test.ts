import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDiscoveredSpawn, closeDb, getSessionRecord, insertAccount, insertSessionRecord, type SessionRecord } from "../db";

// omp reads one store for every account, so discovery files a transcript under
// the first one; a spawn on another account must still take its row.
test("a spawn takes the discovered row of a shared store filed under another account", () => {
  const old = process.env.AGENTBOX_HOME,
    dir = mkdtempSync(join(tmpdir(), "agentbox-attach-"));
  process.env.AGENTBOX_HOME = dir;
  try {
    for (const id of ["first", "second"]) {
      insertAccount({ id, provider: "omp", label: id, email: null, plan: null, home: join(dir, id), isDefault: false, enabled: true, createdAt: 0 } as never);
    }
    const base: SessionRecord = {
      id: "",
      provider: "omp",
      agentSessionId: null,
      accountId: null,
      cwd: "/w",
      worktree: null,
      label: null,
      claim: 0,
      origin: "agentbox",
      tmux: null,
      transcriptPath: null,
      startedAt: 1_000,
      lastActivityAt: 1_000,
      archivedAt: null,
      facts: null,
      createdAt: 1_000,
      scope: "personal",
    };
    insertSessionRecord({ ...base, id: "spawned", accountId: "second", tmux: "ab-spawned" });
    insertSessionRecord({ ...base, id: "found", accountId: "first", origin: "external", agentSessionId: "omp-uuid", transcriptPath: "/t.jsonl", startedAt: 2_000, createdAt: 2_000 });

    expect(attachDiscoveredSpawn("spawned", "found", 3_000)).toBe(true);
    const spawned = getSessionRecord("spawned")!, found = getSessionRecord("found")!;
    expect(spawned.agentSessionId).toBe("omp-uuid");
    expect(spawned.accountId).toBe("second");
    expect(found.successor).toBe("spawned");
    expect(found.agentSessionId).toBeNull();
  } finally {
    closeDb();
    if (old === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
