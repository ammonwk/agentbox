/**
 * Messages on their way to a session, from Send until the server's receipt
 * says what became of them. Each shows where it was sent, as a bubble in the
 * timeline whose note changes in place. One the server never got is sent
 * again with the same ID, which cannot deliver twice (docs/v2.md); only one
 * whose delivery is truly unknown, or that was refused, waits on you.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, Unreachable } from "../../api";
import { dropPasteTags } from "../../../../src/core/sent";
import type { SendReceipt } from "../../../../src/core/types";
import { beginSend, draftSnapshot, forgetPending, onDraftWork, pendingSends, retryPending, uniqueSubmission, updatePending, type PendingSend } from "./drafts";
import { echoSent } from "./echo";

/** Submissions this tab has a request out for. */
const active = new Set<string>();
/** Past this, a message the server never got waits for you instead of going
 *  by itself: an instruction written minutes ago may no longer be wanted. */
const RESEND_MS = 2 * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function deliverPending(p: PendingSend): Promise<void> {
  // Out from before it is stored: a check that finds it stored with no
  // receipt yet must not send it alongside.
  active.add(p.id);
  try {
    await beginSend(p);
    await submit(p);
  } finally {
    active.delete(p.id);
  }
}

async function attempt(p: PendingSend): Promise<void> {
  if (active.has(p.id)) return;
  active.add(p.id);
  try {
    await submit(p);
  } finally {
    active.delete(p.id);
  }
}

async function submit(p: PendingSend): Promise<void> {
  try {
    await settle(p, await api.submit(p.sessionId, p.id, p.kind, p.body));
  } catch (e) {
    // No answer says nothing about delivery: it stays on its way, and its
    // receipt says what happened once agentbox answers. An answer that
    // refuses it came before any receipt.
    await updatePending(p.id, e instanceof Unreachable ? { error: message(e) } : { state: "failed", error: message(e) });
  }
}

async function settle(p: PendingSend, receipt: SendReceipt): Promise<void> {
  if (receipt.state === "sent") {
    // The timeline's Sending… bubble carries it until the transcript has it.
    if (p.kind !== "btw" && p.body.trim()) echoSent(p.id, p.sessionId, p.body);
    await forgetPending(p.sessionId, p.id);
  } else if (receipt.state === "failed" || receipt.state === "unconfirmed") {
    if (receipt.state === "unconfirmed" && (await inTranscript(p))) await forgetPending(p.sessionId, p.id);
    else await updatePending(p.id, { state: receipt.state, error: receipt.error });
  } else if (p.error) {
    await updatePending(p.id, { error: null });
  }
}

const normalized = (text: string) => dropPasteTags(text).replace(/\r\n/g, "\n").trim();

/** Typed in but unconfirmed: the complete transcript, back to the attempt.
 *  A long prompt is capped in the turn rail, and two identical submissions
 *  cannot be told apart by text, so those rely on the receipt alone. */
async function inTranscript(p: PendingSend): Promise<boolean> {
  if (p.kind === "btw" || !p.body.trim() || !uniqueSubmission(p)) return false;
  const want = normalized(p.body);
  let before: string | undefined;
  // An old one must not reread a whole busy session on every check.
  for (let pages = 0; pages < 10; pages++) {
    const page = await api.timeline(p.sessionId, { before, limit: 100 });
    if (page.events.some((e) => e.kind === "user" && e.at >= p.at && normalized(e.text) === want)) return true;
    if (!page.before || page.events.some((e) => e.at < p.at) || page.before === before) return false;
    before = page.before;
  }
  return false;
}

async function check(p: PendingSend): Promise<void> {
  if (active.has(p.id) || p.state === "failed") return;
  const receipt = await api.submission(p.sessionId, p.id);
  if (receipt) return settle(p, receipt);
  // agentbox answers and has no receipt: it never got the message, since
  // the receipt is written before anything is typed.
  if (Date.now() - p.at < RESEND_MS) return attempt(p);
  await updatePending(p.id, { state: "failed", error: "agentbox was out of reach for over two minutes" });
}

/** Keeps a session's submissions moving while its page is open: every few
 *  seconds, and at once when the network or the tab comes back. */
export function useDelivery(sessionId: string): void {
  const any = usePendingSends(sessionId).length > 0;
  useEffect(() => {
    if (!any) return;
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      // Unreachable again: the next round tries it.
      for (const p of pendingSends(sessionId)) await check(p).catch(() => {});
      busy = false;
    };
    const visible = () => document.visibilityState === "visible" && void run();
    void run();
    const timer = setInterval(() => void run(), 5000);
    addEventListener("online", run);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      removeEventListener("online", run);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [sessionId, any]);
}

export function usePendingSends(sessionId: string): PendingSend[] {
  const snapshot = useSyncExternalStore(onDraftWork, draftSnapshot);
  return useMemo(() => pendingSends(sessionId), [sessionId, snapshot]);
}

/** Waiting on you rather than on agentbox. */
export const stuck = (p: PendingSend) => p.state === "failed" || p.state === "unconfirmed";

/** What its bubble says under it. */
export function pendingNote(p: PendingSend): { note: string; title: string } {
  if (p.state === "failed") return { note: p.error ? `Not sent: ${p.error}` : "Not sent", title: p.error ?? "" };
  if (p.state === "unconfirmed") {
    return { note: "May not have arrived", title: "agentbox typed it in but could not confirm the agent got it. Look at the terminal before sending it again." };
  }
  if (p.error) return { note: "Waiting for agentbox…", title: "It sends as soon as agentbox answers" };
  return { note: "Sending…", title: "The agent has not recorded it yet" };
}

const EDIT = "agentbox:edit-pending";
/** Edit belongs to the composer, which owns the box it goes back into. */
export function onEditPending(sessionId: string, fn: (p: PendingSend) => void): () => void {
  const h = (e: Event) => {
    const p = (e as CustomEvent<PendingSend>).detail;
    if (p.sessionId === sessionId) fn(p);
  };
  addEventListener(EDIT, h);
  return () => removeEventListener(EDIT, h);
}

/** Retry, Edit and Delete, for one that waits on you. Retry is a new
 *  submission: the old ID's receipt already says it failed or is unknown. */
export function PendingActions({ p }: { p: PendingSend }) {
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<void> | void) => async () => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return (
    <>
      <button className="linkish" disabled={busy} onClick={act(async () => { const next = await retryPending(p.sessionId, p.id); if (next) await attempt(next); })}>
        {p.state === "unconfirmed" ? "Send again" : "Retry"}
      </button>
      <button className="linkish" disabled={busy} onClick={act(() => void dispatchEvent(new CustomEvent(EDIT, { detail: p })))}>Edit</button>
      <button className="linkish" disabled={busy} onClick={act(() => forgetPending(p.sessionId, p.id))}>Delete</button>
    </>
  );
}

/** Which sessions have a timeline on screen to show their submissions in. */
const shown = new Map<string, number>();
const SHOWN = "agentbox:pending-shown";
export function useShowsPending(sessionId: string): void {
  useEffect(() => {
    shown.set(sessionId, (shown.get(sessionId) ?? 0) + 1);
    dispatchEvent(new Event(SHOWN));
    return () => {
      shown.set(sessionId, shown.get(sessionId)! - 1);
      dispatchEvent(new Event(SHOWN));
    };
  }, [sessionId]);
}
export function usePendingShown(sessionId: string): boolean {
  return useSyncExternalStore(
    (fn) => { addEventListener(SHOWN, fn); return () => removeEventListener(SHOWN, fn); },
    () => (shown.get(sessionId) ?? 0) > 0,
  );
}
