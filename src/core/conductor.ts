import type { Attention, AttentionKind, PrInfo, Session } from "./types";

/**
 * How much each kind of attention costs the human, worst first.
 *
 * Rank is derived from kind rather than assigned per-item so the Inbox order,
 * the board's sort and the sidebar badge cannot drift apart — that split was the
 * old build's bug, where three call sites each decided "urgent" for themselves.
 *
 * The ordering argument: `approval` is an agent parked mid-task that one click
 * un-parks, so every second there is wasted work. `flagged` is the supervisor
 * having stopped a run that is still rescuable, and rescuing it gets harder the
 * longer the context sits. `failed` is a task the human asked for that is not
 * happening at all — it produced nothing, so it beats `review`, which is
 * finished work waiting on a human. `idle` is a session with nothing left to do.
 */
export const ATTENTION_RANK: Record<AttentionKind, number> = {
  approval: 0,
  flagged: 1,
  failed: 2,
  review: 3,
  idle: 4,
  none: 5,
};

function attention(kind: AttentionKind, label: string): Attention {
  return { kind, rank: ATTENTION_RANK[kind], label };
}

/**
 * What this session needs from a human, if anything.
 *
 * The single derivation. Every consumer — Inbox, list sort, badge — reads this
 * and nothing else, so there is exactly one answer to "is this urgent".
 */
export function attentionOf(s: Session): Attention {
  // Blocked outranks status: a session can be `running` or `waiting` and still
  // be parked on a permission prompt, and the prompt is the thing that matters.
  //
  // It takes a LIVE permission, not just the persisted `blocked` flag, because
  // `blocked` survives a restart while the ACP connection that would receive the
  // answer does not — and an Approve/Deny rendered then can only fail with "no
  // pending permission".
  //
  // The engine's `reconcile()` already clears `blocked` at boot for any session
  // with no runner, so after boot this conjunct is redundant. It stays anyway:
  // the invariant depends on a different module calling `reconcile()` before the
  // first broadcast, and one `&&` is cheaper than a dead button if that ordering
  // ever changes. (A restart-blocked session comes back `waiting`, not `dead` —
  // `onPermission` sets `waiting` — so it falls through to `idle` and gets the
  // Steer composer. Sending a message relaunches onto `ompSessionId` and the
  // agent re-asks for the permission itself.)
  if (s.blocked && s.permission) {
    return attention(
      "approval",
      `Asking permission to ${lowerFirst(s.permission.title)} — it is parked until you answer.`
    );
  }

  switch (s.status) {
    case "flagged":
      return attention(
        "flagged",
        s.flagReason
          ? `The supervisor stopped it: ${sentence(s.flagReason)} Resume when you have steered it.`
          : "The supervisor stopped it. Read the transcript and resume when you have steered it."
      );

    case "failed":
      // `failed` is only ever set by the engine's setup failure path, which
      // runs before a conversation exists — so Resume re-sends the original
      // task rather than continuing anything. The label has to say the retry
      // exists: it sits directly beside a Resume button that works, and a line
      // reading "nothing is running" next to a live button teaches people to
      // stop reading the line.
      return attention(
        "failed",
        s.exitCode !== null
          ? `It never got going — exited ${s.exitCode}. Resume runs it again from the original task.`
          : "It never got going. Resume runs it again from the original task."
      );

    case "dead":
      return attention(
        "failed",
        "Its process vanished mid-run. The conversation survived, so Resume picks it back up."
      );

    case "done":
      return attention(
        "review",
        s.prNumber !== null
          ? `Opened PR #${s.prNumber}. It is waiting on your review.`
          : "It finished and opened a pull request, waiting on your review."
      );

    case "waiting":
      return attention("idle", "Finished its turn and is waiting for your next instruction.");

    case "running":
    case "spawning":
      return attention("none", "Working.");
  }
}

/** Sentence-case a fragment we are splicing mid-sentence, without mangling an
 *  acronym or a path that starts with a capital for a reason. */
function lowerFirst(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (t.length > 1 && t[1] === t[1].toUpperCase() && /[A-Za-z]/.test(t[1])) return t;
  return t[0].toLowerCase() + t.slice(1);
}

/** Splice a supervisor's reason into a sentence that keeps reading as one. */
function sentence(text: string): string {
  const t = lowerFirst(text);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// ------------------------------------------------------------------ inbox

/**
 * One row of the Inbox: always a session, since a session is the only thing a
 * human acts on here. `pr` is attached when the session opened one, so a
 * `review` row can name it without the UI going looking.
 */
export interface InboxItem {
  key: string;
  rank: number;
  updatedAt: number;
  session: Session;
  attention: Attention;
  /** The PR this session opened, when the (cached) PR list has caught up. */
  pr: PrInfo | null;
}

/**
 * The kinds that constitute a request for a human act.
 *
 * `idle` is deliberately absent. It means "a turn ended and nothing is wrong",
 * which described 15 of 22 real sessions permanently — an Inbox containing it
 * has an unreachable empty state and stops being a list of things to do. It
 * stays in `Attention` because it orders the Sessions board; ordering and
 * demanding attention are different jobs.
 */
const INBOX_KINDS = new Set<AttentionKind>(["approval", "failed", "flagged", "review"]);

/**
 * Everything that wants a human act, ranked.
 *
 * Sessions only. Standalone PRs are not here: "open PRs with no session behind
 * them" means, against any real repo, every PR anybody has open — 50 of them on
 * the author's, none of them agentbox's. A PR reaches the Inbox through the
 * session that produced it, as `review`, or not at all. `prs` is still a
 * parameter because it is how a review row learns its PR's title and draft
 * state; `listPrs` also still feeds branch linking and `done`.
 */
export function inboxItems(sessions: Session[], prs: PrInfo[]): InboxItem[] {
  const items: InboxItem[] = [];

  for (const session of sessions) {
    // Closing IS the act of dealing with something, so a closed session is
    // never an Inbox item.
    //
    // This test is doing real work. It used to be satisfied by accident —
    // `getHotState` built its list from `listSessions(false)`, so closed
    // sessions could not reach any caller. The day closed sessions started
    // being carried to the client, that accident would have silently turned
    // Close into a no-op that leaves the row sitting in the Inbox. Correct
    // behaviour resting on an unstated fact elsewhere breaks far from the edit
    // that breaks it, with no error.
    if (session.closedAt !== null) continue;

    const attention = attentionOf(session);
    if (!INBOX_KINDS.has(attention.kind)) continue;
    items.push({
      key: `session:${session.id}`,
      rank: attention.rank,
      updatedAt: session.updatedAt,
      session,
      attention,
      pr: prFor(session, prs),
    });
  }

  items.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt);
  return items;
}

/**
 * The PR a session opened, if the cache knows about it yet. Matched on the
 * recorded number first — `sessionId` is resolved by branch name and misses a
 * session whose branch was renamed after the PR opened.
 */
function prFor(session: Session, prs: PrInfo[]): PrInfo | null {
  if (session.prNumber !== null) {
    const byNumber = prs.find((p) => p.number === session.prNumber && p.repo === session.repoFullName);
    if (byNumber) return byNumber;
  }
  return prs.find((p) => p.sessionId === session.id) ?? null;
}
