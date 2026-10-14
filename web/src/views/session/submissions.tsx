/** Temporary pending input, not conversation history. No automatic resend. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { Button } from "../../components";
import { dropPasteTags } from "../../../../src/core/sent";
import { beginSend, draftSnapshot, forgetPending, onDraftWork, pendingSends, uniqueSubmission, updatePending, type PendingSend } from "./drafts";
import { echoSent } from "./echo";
import { chatSubmitted } from "./scroll";

const active = new Set<string>();

export async function deliverPending(p: PendingSend): Promise<void> {
  active.add(p.id);
  try {
    await beginSend(p);
    chatSubmitted(p.sessionId);
    try {
      const receipt = await api.submit(p.sessionId, p.id, p.kind, p.body);
      if (receipt.state === "sent") {
        if (p.kind === "send") echoSent(p.sessionId, p.body);
        await forgetPending(p.sessionId, p.id);
      } else await updatePending(p.id, { state: receipt.state, error: receipt.error });
    } catch (e) {
      // A disconnected response says nothing about whether the server typed
      // the message. It stays out of the draft until delivery is resolved.
      await updatePending(p.id, { state: "unconfirmed", error: e instanceof Error ? e.message : String(e) });
    }
  } finally { active.delete(p.id); }
}

/** A send that lands quickly never shows its note: it would only flash. */
const QUIET_MS = 500;
const sending = (p: PendingSend) => p.state === "pending" || p.state === "attempting";

const normalized = (text: string) => dropPasteTags(text).replace(/\r\n/g, "\n").trim();
/** Full content, after this submission began; never scan ordinary drafts. */
export function submissionLanded(p: PendingSend, users: readonly { text: string; at: number }[]): boolean {
  if (p.kind === "btw" || !p.body.trim()) return false;
  const want = normalized(p.body);
  return users.some((u) => u.at >= p.at && normalized(u.text) === want);
}

async function reconcile(p: PendingSend): Promise<void> {
  if (active.has(p.id) || p.state === "failed") return;
  const receipt = await api.submission(p.sessionId, p.id);
  if (receipt?.state === "sent") { await forgetPending(p.sessionId, p.id); return; }
  if (receipt?.state === "failed") {
    await updatePending(p.id, { state: "failed", error: receipt.error });
    return;
  }
  // A long prompt is capped in the turn rail. Use complete timeline events
  // and page back to the attempt, stopping at an exact match or its time.
  if (p.kind !== "btw" && p.body.trim() && uniqueSubmission(p)) {
    let before: string | undefined;
    // An old uncertain submission must not reread an entire busy session on
    // every poll. Its receipt still resolves it at any age.
    for (let pages = 0; pages < 10; pages++) {
      const page = await api.timeline(p.sessionId, { before, limit: 100 });
      if (submissionLanded(p, page.events.filter((e) => e.kind === "user"))) {
        await forgetPending(p.sessionId, p.id);
        return;
      }
      if (!page.before || page.events.some((e) => e.at < p.at) || page.before === before) break;
      before = page.before;
    }
  }
  await updatePending(p.id, {
    state: receipt?.state ?? "unconfirmed",
    error: receipt?.error ?? (receipt ? null : "No delivery receipt was found"),
  });
}

export function PendingSends({ sessionId, onRestore, reconcileSend = reconcile }: { sessionId: string; onRestore?: (p: PendingSend) => Promise<void>; reconcileSend?: (p: PendingSend) => Promise<void> }) {
  const snapshot = useSyncExternalStore(onDraftWork, draftSnapshot);
  const all = useMemo(() => pendingSends(sessionId), [sessionId, snapshot]);
  const ids = all.map((p) => p.id).join(",");
  const [now, setNow] = useState(Date.now);
  const pending = all.filter((p) => !sending(p) || now - p.at >= QUIET_MS);
  // Re-render when the next quiet send has waited long enough to be shown.
  const reveal = Math.min(...all.filter((p) => sending(p) && now - p.at < QUIET_MS).map((p) => p.at + QUIET_MS));
  useEffect(() => {
    if (!Number.isFinite(reveal)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, reveal - Date.now()));
    return () => clearTimeout(timer);
  }, [reveal]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ids) return;
    let busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const p of pendingSends(sessionId)) {
          try { await reconcileSend(p); }
          catch (e) {
            if (!active.has(p.id)) await updatePending(p.id, { state: "unconfirmed", error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      catch { /* Storage unavailable: keep the last recoverable copy. */ }
      finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => clearInterval(timer);
  }, [sessionId, ids, reconcileSend]);
  if (!pending.length) return null;
  async function act(fn: () => Promise<void>) {
    setChecking(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  }
  return <div className="cmp-pending">
    {pending.map((p) => <div className="cmp-note" key={p.id} role="status">
      <div className="cmp-pending-body">
        <strong>{p.state === "failed" ? "Not sent" : p.state === "unconfirmed" ? "Delivery unconfirmed" : "Sending…"}</strong>
        <div className="cmp-pending-text">{p.draft.text || "Resume session"}</div>
        {p.error ? <div>{p.error}</div> : null}
        {p.state === "unconfirmed" ? <div>Check the timeline or terminal before sending this again.</div> : null}
      </div>
      {p.state === "failed" && onRestore ? <Button size="sm" variant="ghost" loading={checking} onClick={() => void act(() => onRestore(p))}>Restore draft</Button> : <Button size="sm" variant="ghost" loading={checking} onClick={() => void act(() => reconcileSend(p))}>Check delivery</Button>}
      <Button size="sm" variant="ghost" loading={checking} onClick={() => void act(() => forgetPending(sessionId, p.id))}>Dismiss</Button>
    </div>)}
    {error ? <div className="cmp-error" role="alert">{error}</div> : null}
  </div>;
}
