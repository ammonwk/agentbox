/**
 * What you just sent, shown at once. The timeline only learns of a message
 * when the agent writes it to its transcript, and a busy agent can take
 * seconds to; until then the composer's echo stands in, marked as sending,
 * from the moment you press Send. A send that fails takes its echo back.
 */

import { dropPasteTags } from "../../../../src/core/sent";

export interface Echo {
  /** The submission it stands for. */
  id: string;
  sessionId: string;
  text: string;
  at: number;
}

const EVENT = "agentbox:sent";
const DROP = "agentbox:sent-dropped";
/** An agent that has not recorded it after this long is not going to by itself. */
export const ECHO_TTL_MS = 120_000;

export function echoSent(id: string, sessionId: string, text: string): void {
  dispatchEvent(new CustomEvent<Echo>(EVENT, { detail: { id, sessionId, text, at: Date.now() } }));
}

export function dropEcho(id: string): void {
  dispatchEvent(new CustomEvent<string>(DROP, { detail: id }));
}

export function onEcho(fn: (e: Echo) => void, drop: (id: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Echo>).detail);
  const d = (e: Event) => drop((e as CustomEvent<string>).detail);
  addEventListener(EVENT, h);
  addEventListener(DROP, d);
  return () => {
    removeEventListener(EVENT, h);
    removeEventListener(DROP, d);
  };
}

// Claude records a long or many-lined send wrapped in `<pasted_content>`
// (it arrives through tmux as a paste); the echo has no wrapper.
const norm = (s: string) => dropPasteTags(s).replace(/\s+/g, " ").trim().slice(0, 80);

/** Whether the transcript now has the message an echo stands for. */
export function landed(echo: Echo, users: readonly { text: string; at: number }[]): boolean {
  const want = norm(echo.text);
  // Clocks: the transcript's timestamp is the agent's, a moment after ours.
  return users.some((u) => u.at >= echo.at - 10_000 && norm(u.text).startsWith(want.slice(0, 40)));
}
