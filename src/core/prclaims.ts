/**
 * Who has a pull request: the one answer, so that no two sessions work the
 * same PR and nothing has to guess from prompts and titles.
 *
 * A session holds a PR in one of two ways. It is on the PR's branch (what
 * `openPrs` has always matched: the session that opened it, or checked it
 * out), or it said so: `agentbox pr claim`, or `--claim` when it was started,
 * which is how a session in a detached worktree, or one sent to fix someone
 * else's PR, holds it. A claim that was said wins over a branch: the branch is
 * a fact about a checkout, the claim is a decision.
 *
 * Only a live session holds anything (running, waiting or asking): a claim
 * lapses when its session stops or closes, with nothing to clean up, and a
 * live session that asks next gets the PR. A claim is refused while another
 * live session holds the PR, and the refusal names it. When an agent's main
 * conversation is replaced (agents.ts) the claims go to the successor, as its
 * children and cards do.
 */

import { getDb } from "./db";
import type { PrClaim, Session } from "./types";

/** `owner/repo#12`, a PR's URL, or a bare number in `repo`. */
export function parsePrRef(text: string, repo: string | null): { repo: string; number: number } {
  const t = text.trim();
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(t);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const full = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t);
  if (full) return { repo: full[1]!, number: Number(full[2]) };
  const bare = /^#?(\d+)$/.exec(t);
  if (!bare) throw new Error(`"${text}" is not a pull request: give its number, owner/repo#number, or its URL`);
  if (!repo) throw new Error(`which repo is #${bare[1]} in? Give owner/repo#${bare[1]} or the PR's URL (nothing here says: no GitHub repo around this directory or session)`);
  return { repo, number: Number(bare[1]) };
}

type PrRef = { repo: string; number: number };

export function releasedPrs(sessionId: string): PrRef[] {
  return getDb().query("SELECT repo, number FROM pr_releases WHERE session_id = ? ORDER BY repo, number").all(sessionId) as PrRef[];
}

/** Who holds the PR now, and since when. */
export function prHolder(pr: PrRef): { sessionId: string; at: number } | null {
  const row = getDb().query("SELECT session_id, at FROM pr_claims WHERE lower(repo) = lower(?) AND number = ?").get(pr.repo, pr.number) as { session_id: string; at: number } | null;
  return row ? { sessionId: row.session_id, at: row.at } : null;
}

export function assignedPrHolder(pr: PrRef): string | null {
  return prHolder(pr)?.sessionId ?? null;
}

export function prReleased(sessionId: string, pr: PrRef): boolean {
  // A release recorded as Team/Repo is the record for team/repo: a claim, a
  // rename or another session's casing is not a new PR.
  return !!getDb().query("SELECT 1 FROM pr_releases WHERE session_id = ? AND lower(repo) = lower(?) AND number = ?").get(sessionId, pr.repo, pr.number);
}

/** The line for the PRs a session lost: which PR, who holds it now and since
 *  when, and that it is not to edit that branch or worktree. */
function prLossLine(refs: PrRef[]): string {
  if (!refs.length) return "";
  const names = refs.map((p) => {
    const holder = prHolder(p);
    return holder
      ? `${p.repo}#${p.number} is ${holder.sessionId}'s since ${new Date(holder.at).toLocaleTimeString()}`
      : `${p.repo}#${p.number} is held by nobody now`;
  });
  const many = names.length > 1;
  return `[agentbox: PR ${names.join(many ? " and " : "")}, not yours: do not edit ${many ? "those branches or worktrees" : "that branch or worktree"}, `
    + `and leave ${many ? "them" : "it"} to whoever holds ${many ? "them" : "it"}; only your user can hand ${many ? "them" : "it"} back to you (\`agentbox pr claim\`).]`;
}

/**
 * What a session lost and has not been told about: said once, the next time
 * anything is delivered to it, and never again for that claim. Read at
 * delivery, not when a message is queued: ownership can move meanwhile.
 */
export function prReleaseLine(sessionId: string): string {
  return prLossLine(getDb().query("SELECT repo, number FROM pr_releases WHERE session_id = ? AND told_at IS NULL ORDER BY repo, number").all(sessionId) as PrRef[]);
}

/** Everything a session lost, told or not: what its heir inherits, and is
 *  told about once. */
export function prReleasedLine(sessionId: string): string {
  return prLossLine(releasedPrs(sessionId));
}

/** It has been said: never again for that claim. */
export function prReleaseTold(sessionId: string): void {
  getDb().run("UPDATE pr_releases SET told_at = ? WHERE session_id = ? AND told_at IS NULL", [Date.now(), sessionId]);
}

const holds = (s: Session | undefined): s is Session =>
  !!s && s.host !== "subagent" && (s.status === "running" || s.status === "waiting" || s.status === "blocked");

interface Row { repo: string; number: number; session_id: string; at: number }

/** Every PR a live session holds: those said, then those held by a branch
 *  that nobody said otherwise about. `byBranch` is `branchHolders` (prs.ts). */
export function prClaims(sessions: readonly Session[], byBranch: readonly Omit<PrClaim, "how">[]): PrClaim[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rows = getDb().query("SELECT * FROM pr_claims ORDER BY at").all() as Row[];
  const out: PrClaim[] = rows
    .filter((r) => holds(byId.get(r.session_id)))
    .map((r) => ({ repo: r.repo, number: r.number, sessionId: r.session_id, how: "said" as const, at: r.at }));
  const said = new Set(out.map((c) => `${c.repo.toLowerCase()}#${c.number}`));
  for (const b of byBranch) {
    if (!said.has(`${b.repo.toLowerCase()}#${b.number}`) && holds(byId.get(b.sessionId)) && !prReleased(b.sessionId, b)) out.push({ ...b, how: "branch" });
  }
  return out;
}

/**
 * The PRs each session said it has that are not known to be finished (open,
 * or missing from the PR copy), whatever its status: `prClaims` asks which a
 * live session holds; these must not lapse unseen when a session is folded
 * into history or closed along with another (`Fleet.workHeld`). A branch is
 * not one: finished sessions sit on open PRs' branches by the dozen.
 */
export function unfinishedClaims(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = getDb()
    .query("SELECT c.* FROM pr_claims c LEFT JOIN prs p ON p.repo = c.repo AND p.number = c.number WHERE p.state IS NULL OR p.state = 'OPEN'")
    .all() as Row[];
  for (const r of rows) out.set(r.session_id, [...(out.get(r.session_id) ?? []), `${r.repo}#${r.number}`]);
  return out;
}

export function holderOf(claims: readonly PrClaim[], repo: string, number: number): PrClaim | null {
  return claims.find((c) => c.number === number && c.repo.toLowerCase() === repo.toLowerCase()) ?? null;
}

/** Another live session has it. `asker` is the session that asked, named
 *  beside the holder: j2g254q4 read "#8154 is j2g254q4's" as another
 *  session's and stood down from four PRs it held itself. */
export class PrHeld extends Error {
  constructor(readonly claim: PrClaim, holder: Session | undefined, asker?: string) {
    super(
      `not claimed: ${claim.repo}#${claim.number} is held by another session, ${claim.sessionId}` +
        `${holder ? ` (“${holder.label ?? holder.title}”, ${holder.status})` : ""}, ` +
        `${claim.how === "said" ? "which claimed it" : "which is on its branch"}` +
        `${asker ? `; you are ${asker}` : ""}. ` +
        `Do not work it as well: read \`agentbox show ${claim.sessionId}\`, and say what you know to that session if it matters. ` +
        `Its hold lapses when it stops or closes${claim.how === "said" ? ", or when it runs `agentbox pr release`" : ""}.`,
    );
  }
}

/** `sessionId` takes the PR, unless another live session holds it. Its own
 *  again is no change. */
export function claimPr(claims: readonly PrClaim[], sessions: readonly Session[], repo: string, number: number, sessionId: string, now: number): PrClaim {
  const held = holderOf(claims, repo, number);
  if (held && held.sessionId !== sessionId) throw new PrHeld(held, sessions.find((s) => s.id === held.sessionId), sessionId);
  if (held?.how === "said") return held;
  const db = getDb();
  db.transaction(() => {
    const prior = db.query("SELECT * FROM pr_claims WHERE lower(repo) = lower(?) AND number = ?").all(repo, number) as Row[];
    for (const old of prior) if (old.session_id !== sessionId) releasePr(old.session_id, { repo: old.repo, number });
    db.run("DELETE FROM pr_claims WHERE lower(repo) = lower(?) AND number = ?", [repo, number]);
    db.run("INSERT INTO pr_claims (repo, number, session_id, at) VALUES (?,?,?,?)", [held?.repo ?? repo, number, sessionId, now]);
    db.run("DELETE FROM pr_releases WHERE session_id = ? AND lower(repo) = lower(?) AND number = ?", [sessionId, repo, number]);
  })();
  return { repo: held?.repo ?? repo, number, sessionId, how: "said", at: now };
}

/** An explicit handoff, including a hold inferred from a startup branch.
 * The caller must be the expected holder. Read/check/write are synchronous
 * in the server's single writer, so competing transfers cannot both win. The
 * holder lets go as on `releasePr` (its ownership waits cancelled, a notice on
 * its next prompt) and the successor holds it as on `claimPr`. */
export function transferPr(claims: readonly PrClaim[], sessions: readonly Session[], repo: string, number: number, actor: string, expected: string, to: string, now: number): PrClaim {
  const held = holderOf(claims, repo, number);
  if (!held || held.sessionId !== expected) throw new Error(`ownership changed: expected ${expected}, found ${held?.sessionId ?? "nobody"}; read pr who again`);
  if (actor !== expected) throw new Error(`only the current holder ${expected} may hand this PR over`);
  if (to === expected) throw new Error("the destination already holds this PR");
  if (!holds(sessions.find((s) => s.id === to))) throw new Error(`destination ${to} must be a live, independent session`);
  const db = getDb();
  db.transaction(() => {
    releasePr(expected, { repo: held.repo, number });
    db.run("DELETE FROM pr_claims WHERE lower(repo) = lower(?) AND number = ?", [repo, number]);
    db.run("INSERT INTO pr_claims (repo, number, session_id, at) VALUES (?,?,?,?)", [held.repo, number, to, now]);
    db.run("DELETE FROM pr_releases WHERE session_id = ? AND lower(repo) = lower(?) AND number = ?", [to, repo, number]);
  })();
  return { repo: held.repo, number, sessionId: to, how: "said", at: now };
}

/** Cancel the ownership waits and results still waiting to be delivered,
 *  atomically with release: there is no owner left to act on the PR, and no
 *  one to tell. Acting on it is what those waits are — checks, --require,
 *  --only, --feedback. A `--merged` wait is the wait for a PR yours is
 *  stacked on, which needs no ownership: it outlives the release and is told
 *  as usual when the PR merges, naming whoever holds it by then. */
export function releasePr(sessionId: string, pr: PrRef | null): number {
  const db = getDb();
  return db.transaction(() => {
    const refs = pr ? [pr] : db.query("SELECT repo, number FROM pr_claims WHERE session_id = ?").all(sessionId) as PrRef[];
    let released = 0;
    for (const ref of refs) {
      db.run("INSERT OR IGNORE INTO pr_releases (session_id, repo, number) VALUES (?,?,?)", [sessionId, ref.repo, ref.number]);
      db.run(`UPDATE waits SET ended = 'cancelled', ended_at = ?, outcome = ?, untold = NULL
        WHERE session_id = ? AND told_at IS NULL AND json_extract(spec, '$.kind') = 'pr'
        AND json_extract(spec, '$.merged') IS NOT 1
        AND lower(json_extract(spec, '$.repo')) = lower(?) AND json_extract(spec, '$.number') = ?`,
        [Date.now(), `PR ownership released: ${ref.repo}#${ref.number}; this session no longer holds it.`, sessionId, ref.repo, ref.number]);
      released += db.run("DELETE FROM pr_claims WHERE session_id = ? AND number = ? AND lower(repo) = lower(?)", [sessionId, ref.number, ref.repo]).changes;
    }
    return released;
  })();
}

/** A schedule's replacement keeps its predecessor's obligations and exclusions. */
export function movePrClaims(from: string, to: string): number {
  const db = getDb();
  const now = Date.now();
  return db.transaction(() => {
    const held = db.query("SELECT repo, number FROM pr_claims WHERE session_id = ?").all(from) as PrRef[];
    const moved = db.run("UPDATE pr_claims SET session_id = ?, at = ? WHERE session_id = ?", [to, now, from]).changes;
    // The predecessor let the PRs go to its heir: it is told, when it next
    // wakes, that they are not its to edit.
    for (const ref of held) db.run("INSERT OR IGNORE INTO pr_releases (session_id, repo, number) VALUES (?,?,?)", [from, ref.repo, ref.number]);
    // The heir inherits the exclusions: the PRs its predecessor lost, which
    // are not its to work either.
    db.run(`INSERT OR IGNORE INTO pr_releases (session_id, repo, number)
      SELECT ?, r.repo, r.number FROM pr_releases r WHERE r.session_id = ?
      AND NOT EXISTS (SELECT 1 FROM pr_claims c WHERE c.session_id = ? AND lower(c.repo) = lower(r.repo) AND c.number = r.number)`, [to, from, to]);
    db.run("UPDATE waits SET session_id = ? WHERE session_id = ? AND told_at IS NULL AND ended IS NOT 'cancelled'", [to, from]);
    return moved;
  })();
}
