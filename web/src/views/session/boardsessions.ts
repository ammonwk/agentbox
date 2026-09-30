import { createContext, useContext } from "react";
import type { SessionRow } from "../../lib/board";

/** The board's sessions by id, for the timeline: who sent a message, and
 *  what a session named in prose is doing. A context so each row does not
 *  subscribe to the board itself. */
export const BoardSessions = createContext<ReadonlyMap<string, SessionRow>>(new Map());
export const useBoardSessions = () => useContext(BoardSessions);

/** An agentbox id: eight of `newSessionId`'s alphabet (no 0/o/1/l). */
const BOX_ID = /^([2-9a-km-z]{8})(?:$|[^a-z0-9])/;

/**
 * The session a message's sender names: an agentbox id (`agentbox send`), a
 * Claude peer's name, which starts with one (`v4j82hzn-4f`), or a teammate's
 * name — its title or label.
 */
export function senderOf(from: string, board: ReadonlyMap<string, SessionRow>, byName: ReadonlyMap<string, SessionRow>): SessionRow | null {
  const exact = board.get(from);
  if (exact) return exact;
  const id = BOX_ID.exec(from)?.[1];
  if (id && board.has(id)) return board.get(id)!;
  const named = byName.get(from);
  if (named) return named;
  for (const s of board.values()) if (s.label?.trim() === from || s.title?.trim() === from) return s;
  return null;
}

/**
 * The agents this session started inside itself — Claude's background `Agent`
 * calls, by the name it gave them — which have no session of their own to
 * open. A link to one goes to the call that started it.
 */
export interface LocalAgentsValue {
  /** Name to the id of the timeline event that started it. */
  names: ReadonlyMap<string, string>;
  /** Scroll the timeline to an event, paging older history in until it is there. */
  jump: (eventId: string) => void;
}
export const LocalAgents = createContext<LocalAgentsValue>({ names: new Map(), jump: () => {} });
export const useLocalAgents = () => useContext(LocalAgents);

/** A name worth finding in prose: one word, as agent and teammate names are.
 *  A title with spaces in it is not looked for. */
export const isLinkableName = (n: string): boolean => /^[A-Za-z][\w.-]{2,63}$/.test(n) && !/^(?:main|team|lead|agent|user)$/i.test(n);
