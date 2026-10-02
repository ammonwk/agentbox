/** What changed on the board that someone not looking at it would want told:
 *  a session started asking something, finished its turn, stopped. Shared by
 *  `agentbox watch` and voice mode's board news, so both mean the same thing
 *  by "it finished". Pure: rows in, changes out. */

import type { Session, SessionStatus } from "./types";

export const CHANGE_KINDS = ["blocked", "waiting", "running", "stopped"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface Change {
  id: string;
  kind: ChangeKind;
  title: string;
  /** Blocked: what it is asking. Waiting: the end of its last message, where the question usually is. */
  detail: string;
}

export type ChangeRow = Pick<Session, "id" | "status" | "label" | "title" | "firstPrompt" | "lastMessage" | "turnError"> & {
  /** Why it is blocked, from `attentionOf`. */
  reason?: string;
};

/** Names a set of rows, so a watch can ask the server to answer only once its rows differ. */
export const rowsVersion = (rows: readonly ChangeRow[]): string => Bun.hash(JSON.stringify(rows)).toString(36);

const oneLine = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The last `n` characters: an agent ends its turn with its question. */
export function tail(s: string | null | undefined, n: number): string {
  const t = oneLine(s);
  return t.length > n ? `…${t.slice(-n)}` : t;
}

const titleOf = (s: ChangeRow) => oneLine(s.label) || oneLine(s.title) || oneLine(s.firstPrompt?.split("\n")[0]).slice(0, 80) || "untitled";

function changeOf(was: { status: SessionStatus; lastMessage: string | null }, s: ChangeRow): Change | null {
  const c = (kind: ChangeKind, detail = ""): Change => ({ id: s.id, kind, title: titleOf(s), detail });
  // A turn that ended on the provider has no honest last message — the cap
  // cut it off, or it failed; the attention reason is the true line.
  const waitingDetail = () => (s.turnError && s.reason ? oneLine(s.reason) : tail(s.lastMessage, 400));
  if (s.status === was.status) {
    // A turn short enough to start and end between two looks.
    return s.status === "waiting" && s.lastMessage && s.lastMessage !== was.lastMessage ? c("waiting", waitingDetail()) : null;
  }
  switch (s.status) {
    case "blocked":
      return c("blocked", s.reason ?? "waiting on a prompt");
    case "waiting":
      // From stopped it was only resumed; nothing happened.
      return was.status === "running" || was.status === "blocked" ? c("waiting", waitingDetail()) : null;
    case "running":
      return was.status === "closed" ? null : c("running");
    case "stopped":
      return was.status === "closed" ? null : c("stopped");
    default:
      return null;
  }
}

/** Feed it the board over and over; it answers what changed since last time.
 *  The first look is only a snapshot, and so is a session's first appearance —
 *  unless `current`, when the first look also reports where each session
 *  already stands, so a subscriber that starts after a turn ended still hears it. */
export class ChangeWatcher {
  private seen = new Map<string, { status: SessionStatus; lastMessage: string | null }>();
  private primed = false;

  constructor(private readonly opts: { current?: boolean } = {}) {}

  next(rows: readonly ChangeRow[]): Change[] {
    const out: Change[] = [];
    for (const s of rows) {
      const was = this.seen.get(s.id) ?? (!this.primed && this.opts.current ? { status: "running" as const, lastMessage: null } : undefined);
      this.seen.set(s.id, { status: s.status, lastMessage: s.lastMessage });
      const c = (this.primed || this.opts.current) && was ? changeOf(was, s) : null;
      if (c) out.push(c);
    }
    this.primed = true;
    return out;
  }
}

/** `<id>  <kind>  "<title>": <detail>` — one line, id first. */
export function changeLine(c: Change): string {
  const title = c.title.length > 80 ? `${c.title.slice(0, 79)}…` : c.title;
  return `${c.id}  ${c.kind.padEnd(7)}  "${title}"${c.detail ? `: ${c.detail}` : ""}`;
}
