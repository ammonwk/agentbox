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
 * live session holds the PR, and the refusal names it. On a same-session
 * replacement (scheduler) the claims go to the successor, as its children and
 * cards do.
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
    if (!said.has(`${b.repo.toLowerCase()}#${b.number}`) && holds(byId.get(b.sessionId))) out.push({ ...b, how: "branch" });
  }
  return out;
}

export function holderOf(claims: readonly PrClaim[], repo: string, number: number): PrClaim | null {
  return claims.find((c) => c.number === number && c.repo.toLowerCase() === repo.toLowerCase()) ?? null;
}

/** Another live session has it. */
export class PrHeld extends Error {
  constructor(readonly claim: PrClaim, holder: Session | undefined) {
    super(
      `not claimed: ${claim.repo}#${claim.number} is held by ${claim.sessionId}` +
        `${holder ? ` (“${holder.label ?? holder.title}”, ${holder.status})` : ""}, ` +
        `${claim.how === "said" ? "which claimed it" : "which is on its branch"}. ` +
        `Do not work it as well: read \`agentbox show ${claim.sessionId}\`, and say what you know to that session if it matters. ` +
        `Its hold lapses when it stops or closes${claim.how === "said" ? ", or when it runs `agentbox pr release`" : ""}.`,
    );
  }
}

/** `sessionId` takes the PR, unless another live session holds it. Its own
 *  again is no change. */
export function claimPr(claims: readonly PrClaim[], sessions: readonly Session[], repo: string, number: number, sessionId: string, now: number): PrClaim {
  const held = holderOf(claims, repo, number);
  if (held && held.sessionId !== sessionId) throw new PrHeld(held, sessions.find((s) => s.id === held.sessionId));
  if (held?.how === "said") return held;
  getDb().run("INSERT OR REPLACE INTO pr_claims (repo, number, session_id, at) VALUES (?,?,?,?)", [held?.repo ?? repo, number, sessionId, now]);
  return { repo: held?.repo ?? repo, number, sessionId, how: "said", at: now };
}

/** An explicit handoff, including a hold inferred from a startup branch.
 * The caller must be the expected holder. Read/check/write are synchronous
 * in the server's single writer, so competing transfers cannot both win. */
export function transferPr(claims: readonly PrClaim[], sessions: readonly Session[], repo: string, number: number, actor: string, expected: string, to: string, now: number): PrClaim {
  const held = holderOf(claims, repo, number);
  if (!held || held.sessionId !== expected) throw new Error(`ownership changed: expected ${expected}, found ${held?.sessionId ?? "nobody"}; read pr who again`);
  if (actor !== expected) throw new Error(`only the current holder ${expected} may hand this PR over`);
  if (to === expected) throw new Error("the destination already holds this PR");
  if (!holds(sessions.find((s) => s.id === to))) throw new Error(`destination ${to} must be a live, independent session`);
  getDb().run("INSERT OR REPLACE INTO pr_claims (repo, number, session_id, at) VALUES (?,?,?,?)", [held.repo, number, to, now]);
  return { repo: held.repo, number, sessionId: to, how: "said", at: now };
}

/** What `sessionId` said it holds, let go: one PR, or all of them. */
export function releasePr(sessionId: string, pr: { repo: string; number: number } | null): number {
  return pr
    ? getDb().run("DELETE FROM pr_claims WHERE session_id = ? AND number = ? AND lower(repo) = lower(?)", [sessionId, pr.number, pr.repo]).changes
    : getDb().run("DELETE FROM pr_claims WHERE session_id = ?", [sessionId]).changes;
}

/** A session that is being replaced hands what it claimed to its successor. */
export function movePrClaims(from: string, to: string): number {
  return getDb().run("UPDATE pr_claims SET session_id = ? WHERE session_id = ?", [to, from]).changes;
}
