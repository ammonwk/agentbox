import type { Session } from "../../../../src/core/types";
import { attentionOf } from "../../../../src/core/attention";
import type { SessionRow } from "../../lib/board";

/** How long a session started here stands in for the board's copy. The board
 *  carries a new one within a second or two; past this, an id still missing
 *  is a real "No such session". */
const HOLD_MS = 30_000;

const started = new Map<string, { session: SessionRow; at: number }>();

/** The new-session dialog opens the session the moment the server answers,
 *  before the board's next frame lists it: hold the server's answer so the
 *  page shows it starting rather than "No such session". */
export function noteStarted(session: Session): void {
  started.set(session.id, { session: { ...session, attention: attentionOf(session) }, at: Date.now() });
}

/** The session started here under that id, while the board may not carry it yet. */
export function justStarted(id: string): SessionRow | null {
  const s = started.get(id);
  if (!s) return null;
  if (Date.now() - s.at > HOLD_MS) {
    started.delete(id);
    return null;
  }
  return s.session;
}
