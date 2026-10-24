/** Reading a prompt as it was sent: who sent it, and where pasted text sits
 *  in it. Pure; the server and the web app both use it.
 *
 *  Claude records a long paste wrapped: `<pasted_content id="cf71">\n…\n
 *  </pasted_content id="cf71">`. Messages typed in through tmux were once one
 *  paste each, so older transcripts have the whole message in that wrapper,
 *  the sender mark inside it (they go in piecewise now and are not wrapped:
 *  `ProviderAdapter.pasteInPieces`). A paste you made yourself in the
 *  terminal is still recorded that way, wherever in the message it went. */

/** How much of a session's first and last prompt the board carries (and its
 *  record keeps); the transcript has the rest. */
export const PROMPT_PREVIEW = 500;

/** What `agentbox send` puts before a message an agent sends. The sender's
 *  agentbox id follows `from` when it is known (`AGENTBOX_SESSION`). */
export const AGENT_SENT_MARK = "[via agentbox send]";
export const agentSentMark = (from?: string | null): string => (from ? `[via agentbox send from ${from}]` : AGENT_SENT_MARK);
/** What a schedule that keeps to one session puts before each note it types
 *  into it (src/core/scheduler.ts): not you, and not another session. */
export const scheduleSentMark = (scheduleId: string): string => `[via agentbox schedule ${scheduleId}]`;

// The removed Project session signed its messages `[Project session]`; old
// transcripts still carry that form.
const MARK = /^\s*\[(?:via agentbox send(?: from ([\w-]+))?|via agentbox (schedule) [\w-]+|Project session)\]\s*/;
const PASTE_OPEN = /<pasted_content\s+id="[^"]*"\s*>/;
const PASTE_CLOSE = /<\/pasted_content(?:\s+id="[^"]*")?\s*>/;
const PASTE = new RegExp(`${PASTE_OPEN.source}([\\s\\S]*?)(?:${PASTE_CLOSE.source}|$)`, "g");
const WHOLE_PASTE = new RegExp(`^\\s*${PASTE_OPEN.source}([\\s\\S]*?)(?:${PASTE_CLOSE.source})?\\s*$`);

/** The text without a paste wrapper that holds the whole of it. */
export function unwrapPaste(text: string): string {
  const m = WHOLE_PASTE.exec(text);
  // Two pastes side by side are not one wrapper.
  return m && !PASTE_OPEN.test(m[1]!) ? m[1]!.trim() : text;
}

/** Another agent's message delivered by Claude itself rather than typed:
 *  a peer session's (`<cross-session-message from-name="v4j82hzn-4f">`) or a
 *  named agent's (`<agent-message from="rel-sales">`). */
const DELIVERED = /^\s*<(cross-session-message|agent-message)\b([^>]*)>([\s\S]*?)(?:<\/\1>)?\s*$/;
const attr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

export interface Sent {
  /** Written by another agent, not by you. */
  agent: boolean;
  /** Who sent it, when the message says: an agentbox id from the send mark,
   *  the name a delivered message carries, or "agentbox" for its own note. */
  from: string | null;
  /** How it came: `agentbox send`, a schedule's note, or Claude's own
   *  delivery between sessions. */
  via: "agentbox send" | "a schedule" | "Claude" | null;
  /** The message without its wrapper and mark. */
  text: string;
}

/** A note agentbox itself typed into a session, the whole of the message: a
 *  nudge, a keep-warm, a recovery notice, or several of them delivered
 *  together. A note put before your own message
 *  (`[agentbox: …]\n\nwhat you wrote`, waking a parked session) is yours. */
const FLEET_NOTE = /^\s*(?:\[agentbox: (?:(?!\]\n)[\s\S])*\]\s*)+$/;
/** Notes agentbox put before a message say nothing of who wrote it: an
 *  agent's mark comes after them. Each ends at a `]` before a newline, the
 *  next bracket or the end: agentbox may join them with no newline. */
const NOTES_BEFORE = /^\s*(?:\[agentbox: [\s\S]*?\](?=\n|\s*\[|\s*$)\s*)+/;

/** The text without the agentbox notes put before it. */
export const withoutNotes = (text: string): string => text.replace(NOTES_BEFORE, "");

export function readSent(raw: string): Sent {
  const text = unwrapPaste(raw);
  if (FLEET_NOTE.test(text)) return { agent: true, from: "agentbox", via: null, text: text.trim() };
  const signed = withoutNotes(text);
  // The notes stay in what is shown; only the mark comes out.
  const notes = text.slice(0, text.length - signed.length).trim();
  const shown = (rest: string): string => [notes, rest.trim()].filter(Boolean).join("\n\n");
  const m = MARK.exec(signed);
  if (m) {
    const via = m[2] ? "a schedule" : "agentbox send";
    return { agent: true, from: m[2] ? "agentbox" : (m[1] ?? null), via, text: shown(signed.slice(m[0].length)) };
  }
  const d = DELIVERED.exec(signed);
  if (d) {
    const from = d[1] === "cross-session-message" ? (attr(d[2]!, "from-name") ?? null) : attr(d[2]!, "from");
    return { agent: true, from, via: "Claude", text: shown(d[3]!) };
  }
  return { agent: false, from: null, via: null, text };
}

export const isAgentSent = (text: string): boolean => readSent(text).agent;
export const isFleetNote = (text: string): boolean => FLEET_NOTE.test(unwrapPaste(text));

/** The text with every paste wrapper taken off and its content kept: for a
 *  one-line preview, where a paste is just more of what was said. */
export function dropPasteTags(text: string): string {
  return text.replace(new RegExp(PASTE_OPEN.source, "g"), "").replace(new RegExp(PASTE_CLOSE.source, "g"), "");
}

export type SentPart = { kind: "text"; text: string } | { kind: "paste"; text: string };

/** The message split at the pastes in it, so each can be shown as one. */
export function splitPastes(text: string): SentPart[] {
  const out: SentPart[] = [];
  let at = 0;
  for (const m of text.matchAll(PASTE)) {
    const before = text.slice(at, m.index).trim();
    if (before) out.push({ kind: "text", text: before });
    const body = m[1]!.trim();
    if (body) out.push({ kind: "paste", text: body });
    at = m.index! + m[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest || out.length === 0) out.push({ kind: "text", text: rest });
  return out;
}
