/** Reading a prompt as it was sent: who sent it, and where pasted text sits
 *  in it. Pure; the server and the web app both use it.
 *
 *  `agentbox send` types into Claude through tmux, as a paste, and Claude
 *  records a paste wrapped: `<pasted_content id="cf71">\n…\n</pasted_content
 *  id="cf71">`. That wrapper comes before the sender mark, so the mark must
 *  be looked for inside it. A paste you made yourself is recorded the same
 *  way, wherever in the message it went. */

/** What `agentbox send` puts before a message an agent sends. The sender's
 *  agentbox id follows `from` when it is known (`AGENTBOX_SESSION`). */
export const AGENT_SENT_MARK = "[via agentbox send]";
export const agentSentMark = (from?: string | null): string => (from ? `[via agentbox send from ${from}]` : AGENT_SENT_MARK);

// The removed Project session signed its messages `[Project session]`; old
// transcripts still carry that form.
const MARK = /^\s*\[(?:via agentbox send(?: from ([\w-]+))?|Project session)\]\s*/;
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
   *  or the name a delivered message carries. */
  from: string | null;
  /** How it came: `agentbox send`, or Claude's own delivery between sessions. */
  via: "agentbox send" | "Claude" | null;
  /** The message without its wrapper and mark. */
  text: string;
}

export function readSent(raw: string): Sent {
  const text = unwrapPaste(raw);
  const m = MARK.exec(text);
  if (m) return { agent: true, from: m[1] ?? null, via: "agentbox send", text: text.slice(m[0].length).trim() };
  const d = DELIVERED.exec(text);
  if (d) {
    const from = d[1] === "cross-session-message" ? (attr(d[2]!, "from-name") ?? null) : attr(d[2]!, "from");
    return { agent: true, from, via: "Claude", text: d[3]!.trim() };
  }
  return { agent: false, from: null, via: null, text };
}

export const isAgentSent = (text: string): boolean => readSent(text).agent;

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
