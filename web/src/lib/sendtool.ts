/** A tool call that messages another agent, read as the message it sends.
 *  Pure.
 *
 *  The ways an agent writes to another one, as the transcripts record them:
 *  Claude's `SendMessage` (`{to, summary, message}`); an MCP `send` or
 *  `send_message` (`{to|id|target, message|text}`: agentbox's own fleet MCP,
 *  omp's); Codex's `collaboration.send_message`, whose message is sealed; and
 *  `agentbox send <id> <text…>` run in a shell, text quoted or on stdin from
 *  a heredoc. Inputs are capped, so a field is read even when the JSON is
 *  cut off. */

import type { TimelineEvent } from "../../../src/core/types";

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;

export interface SendCall {
  /** Who it went to, as the call names them: an agentbox id, a session or teammate name, a socket address. */
  to: string;
  /** What it said; null when the call does not show it (sealed, or a structured request). */
  text: string | null;
  /** The tool, in a word. */
  via: string;
}

const MCP_SEND = /(?:^|__|\.|\/)send(?:_message)?$/i;

export function sendOf(ev: ToolEvent): SendCall | null {
  if (ev.name === "SendMessage") {
    const to = field(ev.input, "to");
    return to ? { to, text: field(ev.input, "message"), via: "SendMessage" } : null;
  }
  if (MCP_SEND.test(ev.name)) {
    const to = field(ev.input, "to") ?? field(ev.input, "target") ?? field(ev.input, "id");
    if (!to) return null;
    const text = field(ev.input, "message") ?? field(ev.input, "text");
    const via = ev.name.startsWith("collaboration.") ? "Codex" : (/^mcp__([^_]+)__/.exec(ev.name)?.[1] ?? ev.name);
    // Codex seals what one agent sends another: base64 behind `gAAAA`.
    return { to, text: text && !/^gAAAA[\w-]{40,}/.test(text) ? text : null, via };
  }
  const cmd = (ev.name === "Bash" ? field(ev.input, "command") : null) ?? ev.summary;
  return cmd && cmd.includes("agentbox") ? shellSend(cmd) : null;
}

/** A string field of a JSON object that may have been cut off mid-value. */
export function field(input: string | undefined, key: string): string | null {
  if (!input) return null;
  try {
    const v = (JSON.parse(input) as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  } catch {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`).exec(input);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`) + (m[2] ? "" : "…");
    } catch {
      return m[1]!.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
    }
  }
}

const SEND_CMD = /(?:^|[\s;&|(`"'])(?:\S*\/)?agentbox\s+send\s+/;

/** `agentbox send <id> 'text'`, `… "text"`, `… words…`, or `… - <<'EOF'` with the text in the heredoc. */
export function shellSend(cmd: string): SendCall | null {
  const m = SEND_CMD.exec(cmd);
  if (!m) return null;
  const words = shellWords(cmd.slice(m.index + m[0].length));
  const [to, ...rest] = words.filter((w) => !w.startsWith("--"));
  if (!to || to === "-") return null;
  let text: string | null = rest.join(" ").trim() || null;
  if (text === "-" || text === null) {
    const doc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)(?:\n\2(?:\n|$)|$)/.exec(cmd);
    text = doc ? doc[3]!.trim() : null;
  }
  return { to, text, via: "agentbox send" };
}

/** The shell words up to the end of the command: quotes joined, `'\''` understood. */
function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      has = true;
      i = end < 0 ? s.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) j++;
        cur += s[j];
        j++;
      }
      has = true;
      i = j + 1;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c) || c === ";" || c === "&" || c === "|" || c === ")" || c === "<" || c === ">") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      if (c !== " " && c !== "\t") break;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}
