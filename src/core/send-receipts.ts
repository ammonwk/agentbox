/** A receipt is written before delivery starts. Never replay a submission
 *  whose delivery might have begun, including across a server restart. */
import { createHash } from "node:crypto";
import { getDb } from "./db";
import type { SendReceipt } from "./types";

interface Row extends SendReceipt { fingerprint: string }
const active = new Set<string>();

export class SendReceiptConflict extends Error {}

function read(id: string): Row | null {
  return getDb().query(`SELECT id, session_id AS sessionId, fingerprint, state, at, error
    FROM send_receipts WHERE id = ?`).get(id) as Row | null;
}

function update(id: string, state: SendReceipt["state"], error: string | null = null): void {
  const db = getDb();
  // NORMAL can lose the newest WAL commit on a machine crash. The attempt
  // boundary must reach disk before the message can reach the agent.
  if (state === "attempting") db.exec("PRAGMA synchronous = FULL");
  try {
    db.query("UPDATE send_receipts SET state = ?, error = ? WHERE id = ?").run(state, error, id);
  } finally {
    if (state === "attempting") db.exec("PRAGMA synchronous = NORMAL");
  }
}

export function sendReceipt(sessionId: string, id: string): SendReceipt | null {
  const row = read(id);
  if (!row || row.sessionId !== sessionId) return null;
  // Only this process's live work can complete. A queued operation was lost
  // on restart; one past its attempt boundary may already be in the pane.
  if (!active.has(id) && (row.state === "pending" || row.state === "attempting")) {
    update(id, row.state === "pending" ? "failed" : "unconfirmed", "Agentbox restarted before confirming delivery");
    return sendReceipt(sessionId, id);
  }
  const { fingerprint: _, ...receipt } = row;
  return receipt;
}

export async function submitWithReceipt(
  sessionId: string,
  id: string,
  operation: string,
  payload: string,
  deliver: (attempt: () => void) => unknown | Promise<unknown>,
): Promise<SendReceipt> {
  const fingerprint = createHash("sha256").update(JSON.stringify([sessionId, operation, payload])).digest("hex");
  const old = read(id);
  if (old) {
    if (old.sessionId !== sessionId || old.fingerprint !== fingerprint) {
      throw new SendReceiptConflict("that send ID belongs to another submission");
    }
    return sendReceipt(sessionId, id)!;
  }
  getDb().query("INSERT INTO send_receipts (id, session_id, fingerprint, state, at) VALUES (?, ?, ?, 'pending', ?)")
    .run(id, sessionId, fingerprint, Date.now());
  active.add(id);
  let attempted = false;
  try {
    await deliver(() => {
      // Persist before touching the pane or starting a CLI with this prompt.
      update(id, "attempting");
      attempted = true;
    });
    update(id, "sent");
  } catch (e) {
    update(id, attempted ? "unconfirmed" : "failed", e instanceof Error ? e.message : String(e));
  } finally {
    active.delete(id);
  }
  return sendReceipt(sessionId, id)!;
}
