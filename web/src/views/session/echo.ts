/**
 * What you just sent, shown at once. The timeline only learns of a message
 * when the agent writes it to its transcript, and a busy agent can take
 * seconds to; until then the composer's echo stands in, marked as sending.
 */

import { dropPasteTags } from "../../../../src/core/sent";

export interface Echo {
  sessionId: string;
  text: string;
  at: number;
}

const EVENT = "agentbox:sent";
/** An agent that has not recorded it after this long is not going to by itself. */
export const ECHO_TTL_MS = 120_000;

export function echoSent(sessionId: string, text: string): void {
  dispatchEvent(new CustomEvent<Echo>(EVENT, { detail: { sessionId, text, at: Date.now() } }));
}

export function onEcho(fn: (e: Echo) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Echo>).detail);
  addEventListener(EVENT, h);
  return () => removeEventListener(EVENT, h);
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
