/** Who sent an agent's message, as the server knows it.
 *
 * A message one agent sends another reaches it through the provider's user
 * role, marked `[via agentbox send from <session> #<id>]` (sent.ts). The mark
 * is text anyone can type; the record here is what proves it. Written before
 * the message is typed, it holds the recipient, the sending session, whether
 * the sender was authenticated (its session capability, or the server's own
 * runtime identity), the registered agent that session belonged to then, and
 * a digest of the body: never the body itself. A timeline event is attributed
 * only when its mark names a record for this conversation (or one it took
 * over from), with the same digest, written near the time it arrived.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { getDb, getSessionRecord } from "./db";
import { readSent } from "./sent";
import type { SenderView, TimelineEvent } from "./types";

export type RegisteredAgent = NonNullable<SenderView["agent"]>;
/** The registered agent a session belongs (or belonged) to, by its durable
 *  records, never by a title; and an agent's current profile by its id. */
export interface SenderDirectory {
  agentOfSession(session: string): RegisteredAgent | null;
  agent(id: string): RegisteredAgent | null;
  /** The session that took over from `id`, following each handover. */
  heir(id: string): string;
}

/** How far a message may arrive from its record: a queued one waits a while. */
const ARRIVAL_MS = 24 * 3_600_000;
const ready = new WeakSet<Database>();
function db(): Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(`CREATE TABLE IF NOT EXISTS sent_attributions (id TEXT PRIMARY KEY, to_session TEXT NOT NULL,
      from_session TEXT, verified INTEGER NOT NULL, agent TEXT, at INTEGER NOT NULL, digest TEXT NOT NULL)`);
    ready.add(d);
  }
  return d;
}
const digest = (body: string) => createHash("sha256").update(body.trim()).digest("hex");

/** Record a send before it is typed; the id goes in its mark. */
export function recordSend(r: { to: string; from: string | null; verified: boolean; agent: string | null; body: string }, now = Date.now()): string {
  const id = randomBytes(6).toString("hex");
  db().run("INSERT INTO sent_attributions(id,to_session,from_session,verified,agent,at,digest) VALUES (?,?,?,?,?,?,?)", [
    id, r.to, r.from, r.verified ? 1 : 0, r.agent, now, digest(r.body),
  ]);
  return id;
}

type Row = { id: string; to_session: string; from_session: string | null; verified: number; agent: string | null; at: number; digest: string };

function sessionLabel(id: string): string {
  const rec = getSessionRecord(id);
  const title = (rec?.facts as { title?: string } | null)?.title;
  return (rec?.label || title || id).slice(0, 120);
}

/** `events` of `session` with each message's sender attached. `scoped`
 *  leaves out identities a reader outside this machine must not see. */
export function attribute<T extends TimelineEvent>(session: string, events: T[], dir: SenderDirectory, scoped = false): T[] {
  const reads = events.map((e) => (e.kind === "user" ? readSent(e.text) : null));
  const ids = [...new Set(reads.map((r) => r?.attribution).filter((x): x is string => !!x))];
  const rows = new Map<string, Row>();
  if (ids.length)
    for (const r of db().query(`SELECT * FROM sent_attributions WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]) rows.set(r.id, r);
  return events.map((e, i) => {
    const sent = reads[i];
    if (!sent?.agent || e.kind !== "user") return e;
    let sender: SenderView;
    if (sent.via === null) sender = { kind: "system", label: "agentbox", session: null };
    else if (sent.via === "a schedule") sender = { kind: "schedule", label: "A schedule", session: null };
    else if (sent.via === "agentbox cloud") sender = { kind: "cloud", label: sent.from ?? "Another installation", session: null };
    else if (sent.via === "Claude") sender = { kind: "peer", label: sent.from ?? "A Claude session", session: null };
    else {
      const row = sent.attribution ? rows.get(sent.attribution) : undefined;
      const proven =
        !!row && row.verified === 1 && row.from_session === sent.from && row.digest === digest(sent.text) &&
        (row.to_session === session || dir.heir(row.to_session) === session) && Math.abs(e.at - row.at) <= ARRIVAL_MS;
      const agent = proven && row!.agent ? dir.agent(row!.agent) : null;
      sender = !proven
        ? { kind: "unverified", label: "Unverified sender", session: null }
        : agent
          ? { kind: "agent", label: agent.name, session: row!.from_session, agent }
          : { kind: "session", label: sessionLabel(row!.from_session!), session: row!.from_session };
    }
    if (scoped && (sender.kind === "agent" || sender.kind === "session")) sender = { kind: sender.kind, label: sender.kind === "agent" ? "An agent" : "An agent session", session: null };
    return { ...e, sender };
  });
}
