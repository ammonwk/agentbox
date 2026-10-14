/** Browser-only work in progress. Taking a draft and recording its pending
 *  submission are one localStorage write. Successful sends retain no text. */
import type { SavedAttachment } from "../../attachments";
import type { SendReceipt } from "../../../../src/core/types";

export type AgentDraftContext = { proposal: string; run: string };
export interface Draft {
  agentContext?: AgentDraftContext;
  text: string;
  images: SavedAttachment[];
  at: number;
  revision: string;
}
export interface PendingSend {
  id: string;
  sessionId: string;
  draft: Draft;
  kind: "send" | "resume" | "btw";
  body: string;
  bodyHash: string;
  at: number;
  state: SendReceipt["state"];
  error: string | null;
}
interface ComposerWork {
  draft?: Draft;
  pending?: PendingSend[];
  /** Text-free tombstones prevent another mounted tab saving an old draft. */
  taken?: string[];
  /** Repeated content cannot be uniquely attributed through a plain-text TUI. */
  attempts?: { id: string; bodyHash: string }[];
}
// A versioned key prevents an older open UI (which prunes every object that
// is not a Draft) from deleting pending work written by this one.
const KEY = "agentbox.composerWork";
const LEGACY_KEY = "agentbox.drafts";
const EVENT = "agentbox:composer-work";
const AGE_MS = 30 * 24 * 3600 * 1000;

/** HTTP tailnet pages lack randomUUID/subtle, but getRandomValues works. */
export function newRevision(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only for conservative repeat detection in browser metadata. A collision
 *  keeps a submission unconfirmed; it cannot prove delivery. The server's
 *  idempotency fingerprint separately uses SHA-256. */
export function submissionHash(text: string): string {
  const value = text.replace(/\r\n/g, "\n").trim();
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return `${value.length}:${a >>> 0}:${b >>> 0}`;
}

export function draftSnapshot(): string {
  // Import legacy drafts only until the first new-format write. Keeping the
  // old key cannot resurrect a taken draft in a later visit.
  try { return localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? "{}"; } catch { return "{}"; }
}
function readAll(): Record<string, ComposerWork> {
  const raw = JSON.parse(draftSnapshot()) as Record<string, ComposerWork | Draft>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([id, v]) => {
    // Upgrade the old draft format without confusing old sent text with a
    // new pending send: only a user submitting it can take a legacy draft.
    if (v && "text" in v) return [id, { draft: { ...v, revision: v.revision ?? `legacy-${v.at}` } }];
    return [id, v ?? {}];
  }));
}
function write(all: Record<string, ComposerWork>): void {
  // Prune drafts, never unresolved submissions. Losing one silently could
  // invite a duplicate or discard the user's only recoverable input.
  const drafts = Object.entries(all).filter(([, w]) => w.draft).sort(([, a], [, b]) => b.draft!.at - a.draft!.at);
  const kept = new Set(drafts.slice(0, 60).map(([id]) => id));
  for (const [id, w] of Object.entries(all)) {
    if (w.draft && (!kept.has(id) || Date.now() - w.draft.at > AGE_MS)) delete w.draft;
    if (!w.draft && !w.pending?.length && !w.taken?.length) delete all[id];
  }
  localStorage.setItem(KEY, JSON.stringify(all));
  dispatchEvent(new Event(EVENT));
}
export function onDraftWork(fn: () => void): () => void {
  const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === LEGACY_KEY || e.key === null) fn(); };
  addEventListener(EVENT, fn);
  addEventListener("storage", storage);
  fn();
  return () => { removeEventListener(EVENT, fn); removeEventListener("storage", storage); };
}
export function loadDraft(id: string): Draft | null {
  try {
    const d = readAll()[id]?.draft;
    return d && typeof d.text === "string" ? d : null;
  } catch { return null; }
}
export function draftTaken(id: string, revision: string): boolean {
  try { return readAll()[id]?.taken?.includes(revision) ?? false; } catch { return false; }
}
let lockDb: Promise<IDBDatabase> | null = null;
function storageLock(): Promise<IDBDatabase> {
  return lockDb ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("agentbox.composer-lock", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("lock");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => { lockDb = null; reject(open.error); };
  });
}
// Web Locks serialize across tabs. An IndexedDB read/write transaction is
// the same exclusive lock on HTTP tailnet origins, where Web Locks is absent.
async function mutate(fn: () => void): Promise<void> {
  if (navigator.locks) { await navigator.locks.request(KEY, fn); return; }
  const db = await storageLock();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("lock", "readwrite");
    let failure: unknown;
    const request = tx.objectStore("lock").get(KEY);
    request.onsuccess = () => {
      try { fn(); }
      catch (e) { failure = e; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? tx.error);
  });
}
export async function saveDraft(id: string, text: string, images: SavedAttachment[], revision: string, agentContext?: AgentDraftContext, previousRevision?: string): Promise<void> {
  try {
    await mutate(() => {
      const all = readAll();
      const w = all[id] ??= {};
      if (w.taken?.includes(revision)) return;
      if (text.trim() || images.length) w.draft = { text, images, at: Date.now(), revision, ...(agentContext ? { agentContext } : {}) };
      // An empty field in another tab must not erase somebody else's draft.
      else if (w.draft?.revision === revision || (previousRevision !== undefined && w.draft?.revision === previousRevision)) delete w.draft;
      write(all);
    });
  } catch { /* Ordinary draft saving remains best effort. Taking one does not. */ }
}
export async function beginSend(pending: PendingSend): Promise<void> {
  await mutate(() => {
    const all = readAll();
    const w = all[pending.sessionId] ??= {};
    if (w.taken?.includes(pending.draft.revision)) throw new Error("this draft was already submitted in another tab");
    w.pending = [...(w.pending ?? []), pending];
    w.attempts = [...(w.attempts ?? []), { id: pending.id, bodyHash: pending.bodyHash }];
    w.taken = [...(w.taken ?? []), pending.draft.revision];
    if (w.draft?.revision === pending.draft.revision) delete w.draft;
    // Quota/private-mode failures refuse delivery: don't clear an input we
    // cannot recover. No await occurs between taking it and saving it.
    write(all);
  });
}
export function pendingSends(id: string): PendingSend[] {
  try { return readAll()[id]?.pending ?? []; } catch { return []; }
}
export function uniqueSubmission(p: PendingSend): boolean {
  const attempts = readAll()[p.sessionId]?.attempts ?? [];
  // A page from the first rollout used SHA-256 in this browser-only field.
  // Mixed formats cannot establish uniqueness, so rely on the receipt.
  return attempts.every((a) => a.bodyHash.includes(":") === p.bodyHash.includes(":")) && attempts.filter((a) => a.bodyHash === p.bodyHash).length === 1;
}
export async function updatePending(id: string, patch: Partial<Pick<PendingSend, "state" | "error" | "body">>): Promise<void> {
  await mutate(() => {
    const all = readAll();
    for (const w of Object.values(all)) {
      const p = w.pending?.find((p) => p.id === id);
      if (p) {
        // A slower status check cannot undo a definitive failure response.
        if (p.state === "failed" && patch.state !== "failed") return;
        Object.assign(p, patch); write(all); return;
      }
    }
  });
}
export async function forgetPending(sessionId: string, id: string): Promise<void> {
  await mutate(() => {
    const all = readAll();
    const w = all[sessionId];
    if (!w) return;
    w.pending = w.pending?.filter((p) => p.id !== id);
    write(all);
  });
}

/** Restoring a known failure is an explicit edit, saved with the removal of
 *  the pending copy in one transaction. A newer draft is never replaced. */
export async function restorePending(sessionId: string, id: string, draft: Draft, previousRevision: string, unchanged: () => boolean): Promise<void> {
  await mutate(() => {
    const all = readAll();
    const w = all[sessionId];
    if (!w?.pending?.some((p) => p.id === id && p.state === "failed")) throw new Error("this submission is no longer a known failure");
    if (!unchanged() || (w.draft && w.draft.revision !== previousRevision)) throw new Error("the draft changed; try restoring again");
    w.draft = draft;
    w.pending = w.pending.filter((p) => p.id !== id);
    write(all);
  });
}

/** Explicit human recovery of an old agent-level draft into a chosen thread.
 * Moves under the existing cross-tab lock; never silently retargets a proposal. */
export async function recoverAgentDraft(from: string, to: string, run: string | undefined): Promise<Draft | null> {
  let result: Draft | null = null;
  await mutate(() => {
    const all = readAll(), source = all[from], draft = source?.draft;
    if (!source || !draft) return;
    if (draft.agentContext && draft.agentContext.run !== run) throw Error("This guidance belongs to another conversation; open that conversation to recover it.");
    const target = all[to] ??= {};
    const current = target.draft;
    const numbersIn = (text: string) => [...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]));
    let n = Math.max(0, ...numbersIn(current?.text ?? ""), ...(current?.images ?? []).map((a) => a.n));
    // Renumber even an unfinished upload's token: it must never take an
    // unrelated image already attached to the destination draft.
    const numbers = new Map([...new Set([...numbersIn(draft.text), ...draft.images.map((a) => a.n)])].map((old) => [old, ++n]));
    const recovered = draft.text.replace(/\[Image #(\d+)\]/g, (_, old: string) => `[Image #${numbers.get(Number(old))}]`);
    result = {
      ...draft,
      text: [current?.text.trimEnd(), recovered].filter(Boolean).join("\n\n"),
      images: [...(current?.images ?? []), ...draft.images.map((a) => ({ ...a, n: numbers.get(a.n)! }))],
      revision: newRevision(),
    };
    source.taken = [...(source.taken ?? []), draft.revision]; delete source.draft;
    target.draft = result; write(all);
  });
  return result;
}
