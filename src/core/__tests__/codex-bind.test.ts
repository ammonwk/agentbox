import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getSessionRecord, insertAccount, insertSessionRecord, listSessionRecords, findSessionRecord, type SessionRecord } from "../db";
import { Fleet } from "../fleet";
import { codexAdapter } from "../providers/codex";
import type { TranscriptFacts, TranscriptRef } from "../providers/types";

// A wrong binding sends work into another conversation. Exercise the startup
// pass with no process evidence, the gap that cwd/time matching guessed across.
const dir = mkdtempSync(join(tmpdir(), "agentbox-codex-bind-"));
const oldHome = process.env.AGENTBOX_HOME;
beforeAll(() => {
  process.env.AGENTBOX_HOME = dir;
  closeDb();
  insertAccount(account);
});
afterAll(() => {
  closeDb();
  if (oldHome === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});
const account = { id: "bind-account", provider: "codex" as const, label: "Fixture", email: null, plan: null, home: dir, isDefault: false, enabled: true, createdAt: 0 };
const now = Date.now();
const fleet = new Fleet({ adapters: [codexAdapter], runtime: { listPanes: () => [] } as any, usage: { usageOf: () => null } }) as unknown as {
  tracked: Map<string, { ref: TranscriptRef; facts: TranscriptFacts }>;
  byAgentId: Map<string, string>;
  matchPendingSpawns(at: number): void;
  recordFor(t: { ref: TranscriptRef; facts: TranscriptFacts }, at: number): string;
};

async function launch(id: string, i: number, marked = true) {
  const at = now + i * 1000;
  const cmd = codexAdapter.spawnCommand({ session: id, account, cwd: dir, autoApprove: true });
  const marker = cmd.env!.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  const thread = `11111111-2222-7333-8444-${String(i).padStart(12, "0")}`;
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", timestamp: new Date(at).toISOString(), payload: { id: thread, cwd: dir, source: "cli", originator: marked ? marker : "codex-tui" } }) + "\n");
  const ref: TranscriptRef = { provider: "codex", accountId: account.id, agentSessionId: thread, path, mtimeMs: at, size: 1 };
  const { facts } = await codexAdapter.reader(ref).refresh();
  const row: SessionRecord = { id, provider: "codex", agentSessionId: null, accountId: account.id, cwd: dir, worktree: null, label: null, claim: 1, origin: "agentbox", scope: "personal", tmux: `ab-${id}`, transcriptPath: null, startedAt: at, lastActivityAt: at, archivedAt: null, facts: null, createdAt: at };
  insertSessionRecord(row);
  const t = { ref, facts };
  fleet.tracked.set(path, t);
  return { id, thread, t, cmd };
}

test("three launches a second apart bind exactly before panes/processes are visible; discovery reuses each id", async () => {
  const starts: Awaited<ReturnType<typeof launch>>[] = [];
  for (let i = 0; i < 3; i++) starts.push(await launch(`bind000${i}`, i));
  expect(new Set(starts.map(s => s.cmd.env!.CODEX_INTERNAL_ORIGINATOR_OVERRIDE)).size).toBe(3);
  for (const s of starts) expect(s.cmd.argv).toContain('shell_environment_policy.set.CODEX_INTERNAL_ORIGINATOR_OVERRIDE="codex_exec"');
  fleet.matchPendingSpawns(now + 5000);
  for (const s of starts) {
    expect(getSessionRecord(s.id)!.agentSessionId).toBe(s.thread);
    fleet.byAgentId.clear(); // Discovery after a restart must reuse the database identity too.
    expect(fleet.recordFor(s.t, now + 5000)).toBe(s.id);
  }
  expect(listSessionRecords().filter(s => starts.some(t => t.thread === s.agentSessionId))).toHaveLength(3);
});

test("an unmarked neighbouring rollout remains unbound instead of taking a pending id", async () => {
  const s = await launch("bindold0", 4, false);
  fleet.matchPendingSpawns(now + 6000);
  expect(getSessionRecord(s.id)!.agentSessionId).toBeNull();
});

test("late external discovery reconciles to the marked launch and remains an alias", async () => {
  const s = await launch("bindlate", 6);
  const pending = getSessionRecord(s.id)!;
  insertSessionRecord({ ...pending, id: "external", agentSessionId: s.thread, origin: "external", tmux: null, transcriptPath: s.t.ref.path, startedAt: now + 6000, createdAt: now + 7000 });
  fleet.matchPendingSpawns(now + 8000);
  expect(fleet.recordFor(s.t, now + 8000)).toBe(s.id);
  expect(findSessionRecord("codex", s.thread)!.id).toBe(s.id);
  expect(getSessionRecord("external")).toMatchObject({ agentSessionId: null, successor: s.id, archivedAt: now + 8000 });
});
