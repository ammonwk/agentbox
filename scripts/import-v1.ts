/**
 * One-shot: bring v1's board into v2.
 *
 * v1 ran omp over ACP and kept its own event log per session, but omp wrote
 * its own transcript all along, and that is what v2 reads. So a v1 chat comes
 * over as a v2 session row pointing at omp's transcript — pinned to the omp
 * account, marked as started by agentbox, with v1's worktree and archive
 * state — and nothing of the conversation is copied. v1 chats whose omp
 * transcript is gone (or that never started one) are reported and skipped.
 *
 * v1's registered repos come over too. Settings do not: v1's were for a
 * single omp model and a supervisor that v2 does not have.
 *
 *   bun scripts/import-v1.ts [--dry-run] [path/to/agentbox.db]
 *
 * Idempotent: a chat already imported is left alone, and one the fleet had
 * already discovered as an external omp session is claimed rather than
 * duplicated.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addRepo, findSessionRecord, getRepo, getSettings, insertSessionRecord, listAccounts, updateSessionRecord } from "../src/core/db";
import { headline, newSessionId } from "../src/core/fleet";
import { agentboxHome } from "../src/core/paths";
import { ompAdapter } from "../src/core/providers/omp";

interface V1Session {
  id: string;
  title: string;
  prompt: string;
  status: string;
  repo: string;
  worktree: string | null;
  model: string;
  last_message: string | null;
  omp_session_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  archived_at: number | null;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const v1Path = args.find((a) => !a.startsWith("--")) ?? join(agentboxHome(), "agentbox.db");
if (!existsSync(v1Path)) {
  console.error(`no v1 database at ${v1Path}`);
  process.exit(1);
}
const v1 = new Database(v1Path, { readonly: true });

const account = listAccounts("omp").find((a) => a.isDefault) ?? listAccounts("omp")[0];
if (!account) {
  console.error("no omp account in v2 yet; start the server once so it registers the default one");
  process.exit(1);
}

// ------------------------------------------------------------------ repos

for (const { ref } of v1.query("SELECT ref FROM repos").all() as { ref: string }[]) {
  if (getRepo(ref)) continue;
  if (ref.startsWith("/tmp/") || (ref.startsWith("/") && !existsSync(ref))) {
    console.log(`repo   skip  ${ref} (${ref.startsWith("/tmp/") ? "scratch" : "gone"})`);
    continue;
  }
  if (!dryRun) await addRepo(ref);
  console.log(`repo   add   ${ref}`);
}

// --------------------------------------------------------------- sessions

const claim = getSettings().balancer.claimNormal;
const counts = { imported: 0, claimed: 0, already: 0, skipped: 0 };
const rows = v1.query("SELECT * FROM sessions ORDER BY created_at").all() as V1Session[];

for (const s of rows) {
  const what = `${s.id.slice(0, 8)} ${s.title.slice(0, 60)}`;
  if (!s.omp_session_id) {
    counts.skipped++;
    console.log(`chat   skip  ${what} (never started a conversation)`);
    continue;
  }
  const ref = await ompAdapter.findTranscript(account, s.omp_session_id);
  if (!ref) {
    counts.skipped++;
    console.log(`chat   skip  ${what} (omp's transcript is gone)`);
    continue;
  }

  const existing = findSessionRecord("omp", s.omp_session_id);
  if (existing?.origin === "agentbox") {
    counts.already++;
    continue;
  }
  const lastActivityAt = Math.max(s.updated_at, ref.mtimeMs);
  const fromV1 = {
    accountId: account.id,
    worktree: s.worktree,
    origin: "agentbox" as const,
    transcriptPath: ref.path,
    archivedAt: s.archived_at,
  };
  if (existing) {
    counts.claimed++;
    console.log(`chat   claim ${what} → ${existing.id}`);
    if (!dryRun) updateSessionRecord(existing.id, fromV1);
    continue;
  }

  counts.imported++;
  const id = newSessionId();
  console.log(`chat   add   ${what} → ${id}${s.archived_at ? " (archived)" : ""}`);
  if (dryRun) continue;
  insertSessionRecord({
    id,
    provider: "omp",
    agentSessionId: s.omp_session_id,
    cwd: s.worktree ?? s.repo,
    // v2 titles a session from its first prompt, but not from a slash command
    // (`/green-and-clean 4493`), and would fall back to the worktree's uuid;
    // v1's own title for those is better.
    label: headline(s.prompt) ? null : s.title,
    big: false,
    claim,
    tmux: null,
    startedAt: s.started_at ?? s.created_at,
    lastActivityAt,
    // Enough to draw the row before the fleet first reads the transcript.
    facts: {
      cwd: s.worktree ?? s.repo,
      firstPrompt: s.prompt.slice(0, 500),
      lastMessage: s.last_message?.slice(0, 300) ?? null,
      model: s.model,
      lastActivityAt,
      turnOpen: false,
    },
    createdAt: s.created_at,
    ...fromV1,
  });
}

console.log(
  `\n${dryRun ? "dry run: " : ""}${counts.imported} imported, ${counts.claimed} claimed from the board, ` +
    `${counts.already} already imported, ${counts.skipped} skipped (of ${rows.length})`,
);
