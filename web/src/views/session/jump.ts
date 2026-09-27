/** A message to show in the Timeline once it opens: the rail beside the
 *  terminal hands over what the terminal could not scroll to. */

export interface Jump {
  turnId: string;
  /** Why it is shown here rather than where it was clicked. */
  note?: string;
}

const pending = new Map<string, Jump>();

export function jumpInTimeline(sessionId: string, jump: Jump): void {
  pending.set(sessionId, jump);
}

/** Take the jump waiting for this session, once. */
export function takeJump(sessionId: string): Jump | null {
  const j = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return j;
}
