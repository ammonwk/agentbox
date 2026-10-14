/**
 * A session with work going is never closed as a side effect. On 2026-10-11
 * qgvwbhb4, 3y9uquv2 and bhenimat were each parked after an hour idle with
 * `agentbox wait`s armed on open PRs, under a parent that was parked too, and
 * the board showed each as closed: the rule that folds a finished call into
 * history read them as one, their PRs showed nobody holding them, and the
 * steward found the PRs unowned an hour later. Closing such a parent took them
 * with it for real, waits cancelled.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, getSessionRecord, getWait, insertSessionRecord, insertWait, type SessionRecord } from "../db";
import { Fleet, type Runtime } from "../fleet";
import { claimPr, prClaims } from "../prclaims";

const dir = mkdtempSync(join(tmpdir(), "agentbox-heldwork-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  mkdirSync(process.env.HOME, { recursive: true });
  closeDb();
});

afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.now();
const HOUR = 3_600_000;

/** A session the fleet parked an hour after its last turn, under `parent`. */
function parked(id: string, parent: string | null): SessionRecord {
  return {
    id, provider: "claude", agentSessionId: null, accountId: null, cwd: "/tmp", worktree: null, label: null, claim: 1,
    origin: "agentbox", tmux: `ab-${id}`, transcriptPath: null, startedAt: NOW - 3 * HOUR, lastActivityAt: NOW - 2 * HOUR,
    archivedAt: null, facts: null, createdAt: NOW - 3 * HOUR, parent, parkedAt: NOW - HOUR,
  } as SessionRecord;
}

const noPanes: Runtime = {
  newSession: () => 0, listPanes: () => [], sendText: async () => {}, sendKeys: () => {}, capture: () => null,
  captureMany: () => new Map(), killSession: () => {},
};

function pr(number: number, state: "OPEN" | "MERGED"): void {
  getDb().run(
    "INSERT INTO prs (repo, number, title, head_ref, base_ref, state, draft, author, url, created_at, updated_at) VALUES ('o/r', ?, 't', ?, 'staging', ?, 0, 'a', 'u', '', '')",
    [number, `b${number}`, state],
  );
}

test("a parked child with a wait or an open PR stays on the board, keeps its claim, and a parent's close leaves it open", async () => {
  const fleet = new Fleet({ adapters: [], runtime: noPanes, usage: { usageOf: () => null } });
  // The release session and its children, all parked: one waiting on its PR's
  // checks, one that claimed an open PR, one whose PR merged, one that only finished.
  for (const r of [parked("rel", null), parked("waiter", "rel"), parked("claimer", "rel"), parked("merged", "rel"), parked("done", "rel"), parked("grandkid", "waiter")]) {
    insertSessionRecord(r);
  }
  const wait = insertWait({ sessionId: "waiter", spec: { kind: "pr", repo: "o/r", number: 9030, head: null, all: true, checks: [], merged: false }, createdAt: NOW - 2 * HOUR, deadline: NOW + 6 * HOUR });
  pr(9031, "OPEN");
  pr(9020, "MERGED");
  claimPr([], [], "o/r", 9031, "claimer", NOW - 2 * HOUR);
  claimPr([], [], "o/r", 9020, "merged", NOW - 2 * HOUR);

  await fleet.tick();
  const status = () => Object.fromEntries(fleet.sessions().map((s) => [s.id, s.status]));
  expect(status()).toMatchObject({ rel: "waiting", waiter: "waiting", claimer: "waiting", merged: "closed", done: "closed", grandkid: "closed" });
  expect(prClaims(fleet.sessions(), []).map((c) => `${c.sessionId} #${c.number}`)).toEqual(["claimer #9031"]);

  const out = await fleet.close("rel", true);
  expect(out.closed.sort()).toEqual(["done", "merged", "rel"]);
  expect(out.kept).toEqual([
    { id: "waiter", holds: [`wait ${wait.id}`] },
    { id: "claimer", holds: ["o/r#9031"] },
  ]);
  expect(out.said).toContain("left waiter open");
  for (const id of ["waiter", "claimer", "grandkid"]) expect(getSessionRecord(id)!.archivedAt).toBeNull();
  expect(getWait(wait.id)!.ended).toBeNull();

  // Closed by its own id, it goes, and says what it gave up.
  const own = await fleet.close("waiter", true);
  expect(own.closed.sort()).toEqual(["grandkid", "waiter"]);
  expect(own.said).toBe(`, with the sessions it started: grandkid; it gave up wait ${wait.id}, which no session holds now`);
});
