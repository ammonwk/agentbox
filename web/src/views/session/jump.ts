/** A message to show in the Timeline once it opens: the rail beside the
 *  terminal hands over what the terminal could not scroll to, and a search
 *  hit the message it was found in. */

export interface Jump {
  turnId: string;
  /** Why it is shown here rather than where it was clicked. */
  note?: string;
}

const pending = new Map<string, Jump>();
const listeners = new Set<(sessionId: string) => void>();

export function jumpInTimeline(sessionId: string, jump: Jump): void {
  pending.set(sessionId, jump);
  for (const l of listeners) l(sessionId);
}

/** Take the jump waiting for this session, once. */
export function takeJump(sessionId: string): Jump | null {
  const j = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return j;
}

/** Hear of a jump handed over while the Timeline is already open. */
export function onJump(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
