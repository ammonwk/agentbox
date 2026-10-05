/** The prompt cache: when a session's goes cold, and keeping it warm.
 *
 * One clock for everything that asks whether a session's cache is warm: the
 * board's `cold` (a cold session wakes on whichever account has room), a
 * claim lapsing, parking, the order crash recovery resumes in, and the
 * keep-warm message below. The cache lives from the newest model call — not
 * the newest line: notification lines arrive for hours with no call behind
 * them — for as long as that call wrote it to live. Claude says which in each
 * call's usage: an hour on a subscription, five minutes on an API key or in
 * usage overage. A provider that does not say gets `claimIdleMin`.
 */

export const CACHE_TTL_1H_MS = 60 * 60_000;
export const CACHE_TTL_5M_MS = 5 * 60_000;

/**
 * How long the cache a Claude model call wrote lives, from its usage's split
 * of `cache_creation`; null when it wrote nothing (a read keeps the cache's
 * lifetime as it was). Any five-minute write makes it five minutes: Claude
 * marks the conversation's tail, the bulk of it, with one lifetime, and the
 * system prompt alone staying warm saves little.
 */
export function claudeCacheTtl(usage: any): number | null {
  const c = usage?.cache_creation;
  if (!c || typeof c !== "object") return null;
  if ((c.ephemeral_5m_input_tokens ?? 0) > 0) return CACHE_TTL_5M_MS;
  if ((c.ephemeral_1h_input_tokens ?? 0) > 0) return CACHE_TTL_1H_MS;
  return null;
}

/** When the cache goes cold: the newest model call (or, where the provider
 *  cannot tell one apart, the newest line; or `fallbackAt`) plus the lifetime
 *  that call wrote, or `fallbackTtlMs` where the provider does not say. */
export function cacheWarmUntil(
  f: { lastTurnAt?: number | null; lastActivityAt?: number | null; cacheTtlMs?: number | null } | null | undefined,
  fallbackAt: number,
  fallbackTtlMs: number,
): number {
  return (f?.lastTurnAt ?? f?.lastActivityAt ?? fallbackAt) + (f?.cacheTtlMs ?? fallbackTtlMs);
}

// ---------------------------------------------------------------- keep warm

/** A session waiting on work that will wake it is sent the keep-warm message
 *  this long before its cache goes cold. */
export const KEEP_WARM_LEAD_MS = 5 * 60_000;
/** Only a cache that lives at least this long is worth keeping: a message
 *  every few minutes to save a five-minute cache's rewrite costs more in
 *  reads and replies than the rewrite. */
export const KEEP_WARM_MIN_TTL_MS = 30 * 60_000;
/** At most this many in one wait. Each costs a tenth of what the rewrite it
 *  saves would, plus its reply; a wait that outlasts this many hours is
 *  likely stuck, and is left to go cold. */
export const KEEP_WARM_MAX = 8;

/** Is the cache about to go cold: inside the last `KEEP_WARM_LEAD_MS` of its
 *  life? */
export function cacheExpiring(now: number, warmUntil: number): boolean {
  return now >= warmUntil - KEEP_WARM_LEAD_MS && now < warmUntil;
}

/** The keep-warm messages sent in one wait: how many, and when the last went. */
export interface WarmSpell {
  count: number;
  at: number;
}

/**
 * Whether a session waiting on work that will wake it gets the keep-warm
 * message now: the spell that sending it makes, or null. Not before its cache
 * is about to go cold, nor for a five-minute cache; not again before the last
 * one has been answered; and not past `KEEP_WARM_MAX` in one wait. A wait
 * starts over once you have said something to it since the last, or it has
 * worked since it answered.
 */
export function keepWarmPlan(
  s: { now: number; warmUntil: number; cacheTtlMs?: number | null; lastTurnAt?: number | null; lastPromptAt?: number | null },
  spell: WarmSpell | undefined,
): WarmSpell | null {
  if (!cacheExpiring(s.now, s.warmUntil) || (s.cacheTtlMs ?? 0) < KEEP_WARM_MIN_TTL_MS) return null;
  const lastTurn = s.lastTurnAt ?? 0;
  if (spell && spell.at > lastTurn) return null;
  const same = spell && (s.lastPromptAt ?? 0) <= spell.at && lastTurn <= spell.at + KEEP_WARM_LEAD_MS;
  const count = (same ? spell.count : 0) + 1;
  return count > KEEP_WARM_MAX ? null : { count, at: s.now };
}

/** The keep-warm message: the work it waits on, and that nothing has
 *  happened. Answered in a line, which the board then shows as its last
 *  word, so the line should say what it is waiting on. */
export function keepWarmNote(work: string): string {
  return `[agentbox: keeping this session's prompt cache warm while it waits (${work}); nothing has finished yet. Reply with one short line saying what you are still waiting on, and do nothing else: you will be told when it finishes.]`;
}
