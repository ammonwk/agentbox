import { createContext } from "react";
import type { SessionIndex } from "../../lib/sessionrefs";

export interface SessionLinksValue {
  /** The board's sessions, as a lookup for the ids, tmux names, provider ids
   *  and worktrees agent prose names. */
  index: SessionIndex;
  /** The session being read: a reference to itself is not a jump. */
  self: string | null;
}

/** A context so the timeline's markdown rows do not each take the board as a
 *  prop. */
export const SessionLinks = createContext<SessionLinksValue>({ index: { ids: new Set(), provider: new Map() }, self: null });
