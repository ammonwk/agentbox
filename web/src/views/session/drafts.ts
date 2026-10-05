/** The unsent text in each session's composer, remembered while you are
 *  somewhere else — another session, another page, or a reload. The
 *  new-session dialog keeps its draft the same way (`agentbox.newSession`);
 *  this is that, per session. Cleared by sending: an empty draft deletes
 *  itself, and `draftSent` takes it out when the composer that sent it is
 *  no longer there to empty. */

import type { SavedAttachment } from "../../attachments";

export interface Draft {
  text: string;
  /** Images of the draft that made it to the server. */
  images: SavedAttachment[];
  /** Last typed-at, for the prune. */
  at: number;
}

const KEY = "agentbox.drafts";
/** Entries kept, and for how long: half-typed prompts to sessions that are
 *  long gone are not worth the space. */
const MAX = 60;
const AGE_MS = 30 * 24 * 3600 * 1000;

function readAll(): Record<string, Draft> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

export function loadDraft(id: string): Draft | null {
  const d = readAll()[id];
  return d && typeof d.text === "string" && d.text ? d : null;
}

export function saveDraft(id: string, text: string, images: SavedAttachment[]): void {
  try {
    const all = readAll();
    if (text.trim() || images.length > 0) all[id] = { text, images, at: Date.now() };
    else delete all[id];
    const kept = Object.entries(all)
      .filter(([, d]) => Date.now() - d.at < AGE_MS)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // private mode or full: forgetting is fine
  }
}

const SENT = "agentbox:draft-sent";

/** `text` was sent: its draft goes, whoever holds it. The server answers a
 *  send only once the pane has taken it, seconds on a busy machine, and a
 *  composer left by then cannot empty itself; one opened in the meantime
 *  started from the draft and is told to. */
export function draftSent(id: string, text: string): void {
  if (readAll()[id]?.text === text) saveDraft(id, "", []);
  dispatchEvent(new CustomEvent(SENT, { detail: { id, text } }));
}

export function onDraftSent(fn: (id: string, text: string) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<{ id: string; text: string }>).detail;
    fn(d.id, d.text);
  };
  addEventListener(SENT, h);
  return () => removeEventListener(SENT, h);
}
