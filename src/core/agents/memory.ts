/** Bounded continuity records for conversational agents: handoffs, decisions
 * and preferences, scoped to one agent instance. They are evidence for the
 * next conversation, never authorization. The provider transcript stays the
 * record: a record names its source session, it never copies a transcript. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FleetError } from "../fleet";

const text = (max: number) => z.string().trim().min(1).max(max);
const Ref = z.object({ label: text(120), ref: text(500) }).strict();
export const HandoffInput = z
  .object({
    intent: text(1200),
    decisions: z.array(z.object({ decision: text(400), why: z.string().trim().max(600).default("") }).strict()).max(12).default([]),
    open: z.array(text(400)).max(10).default([]),
    commitments: z.array(text(400)).max(10).default([]),
    refs: z.array(Ref).max(20).default([]),
  })
  .strict();
export type Handoff = z.infer<typeof HandoffInput>;
export const NoteInput = z
  .object({ decision: text(400), why: z.string().trim().max(600).default(""), refs: z.array(Ref).max(8).default([]) })
  .strict();
export type Note = z.infer<typeof NoteInput>;
export const PreferenceInput = z
  .object({ key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/i, "key: letters, digits, . _ -"), text: z.string().trim().max(400) })
  .strict();
/** Per instance. `idleMin`: the user is away this long while the cache is
 *  still warm, so save a handoff. `contextPct`: a conversation this full is
 *  replaced at the next message even while warm. */
export const MemoryPolicy = z
  .object({
    rollover: z.boolean().default(true),
    idleMin: z.number().int().min(5).max(240).default(10),
    contextPct: z.number().int().min(20).max(95).default(60),
  })
  .strict();
export type MemoryPolicy = z.infer<typeof MemoryPolicy>;
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = MemoryPolicy.parse({});

/** About 500 words, with a margin for references. */
export const HANDOFF_WORDS = 550;
export const PREFERENCES_MAX = 40;

export type MemoryKind = "handoff" | "note" | "preference";
export type MemoryRecord = {
  id: string;
  scope: string;
  kind: MemoryKind;
  key: string | null;
  /** The provider conversation it came from; `agentbox log` reads it. */
  session: string;
  at: number;
  by: "agent" | "operator";
  /** The checkpoint request it answers, for a handoff saved on request. */
  checkpoint: string | null;
  /** The conversation that started from it. */
  usedBy: string | null;
  retired: number | null;
  body: Handoff | Note | { text: string };
};

const CREDENTIAL =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [^-]*PRIVATE KEY-----)/;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
export function handoffWords(h: Handoff) {
  return words([h.intent, ...h.decisions.flatMap((d) => [d.decision, d.why]), ...h.open, ...h.commitments, ...h.refs.map((r) => r.label)].join(" "));
}
const summary = (r: MemoryRecord) =>
  r.kind === "handoff" ? (r.body as Handoff).intent : r.kind === "note" ? (r.body as Note).decision : `${r.key}: ${(r.body as { text: string }).text}`;
const terms = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9_#./-]{3,}/g) ?? []);

export class AgentMemory {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
        key TEXT, session TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, fingerprint TEXT NOT NULL,
        checkpoint TEXT, used_by TEXT, retired INTEGER, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_memory_scope ON agent_memory(scope, kind, at);
      CREATE TABLE IF NOT EXISTS memory_checkpoints (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  /** The checkpoint of a conversation whose record lives elsewhere (a shared run's). */
  checkpoint<T>(id: string): T | undefined {
    const r = this.db.query("SELECT body FROM memory_checkpoints WHERE id=?").get(id) as { body: string } | null;
    return r ? (JSON.parse(r.body) as T) : undefined;
  }
  setCheckpoint<T>(id: string, change: (c: T | undefined) => T | undefined) {
    this.db.transaction(() => {
      const next = change(this.checkpoint<T>(id));
      if (next === undefined) this.db.run("DELETE FROM memory_checkpoints WHERE id=?", [id]);
      else this.db.run("INSERT INTO memory_checkpoints(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [id, JSON.stringify(next)]);
    })();
  }
  private row(r: Record<string, unknown>): MemoryRecord {
    return {
      id: r.id as string, scope: r.scope as string, kind: r.kind as MemoryKind, key: (r.key as string) ?? null,
      session: r.session as string, at: r.at as number, by: r.by as "agent" | "operator",
      checkpoint: (r.checkpoint as string) ?? null, usedBy: (r.used_by as string) ?? null,
      retired: (r.retired as number) ?? null, body: JSON.parse(r.body as string),
    };
  }
  get(scope: string, id: string): MemoryRecord {
    const r = this.db.query("SELECT * FROM agent_memory WHERE id=? AND scope=?").get(id, scope) as Record<string, unknown> | null;
    if (!r) throw new FleetError(404, "No such memory record for this agent");
    return this.row(r);
  }
  /** Idempotent by `id`: the same request returns the record it made. */
  private insert(rec: Omit<MemoryRecord, "usedBy" | "retired">) {
    const body = JSON.stringify(rec.body);
    if (CREDENTIAL.test(body)) throw new FleetError(400, "Remove credentials from memory; refer to where they are kept instead");
    const fingerprint = createHash("sha256").update(JSON.stringify([rec.scope, rec.kind, rec.key, body])).digest("hex");
    const old = this.db.query("SELECT * FROM agent_memory WHERE id=?").get(rec.id) as Record<string, unknown> | null;
    if (old) {
      if (old.fingerprint !== fingerprint || old.session !== rec.session) throw new FleetError(409, "This request ID already names another memory record");
      return this.row(old);
    }
    this.db.run(
      "INSERT INTO agent_memory(id,scope,kind,key,session,at,by,fingerprint,checkpoint,body) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [rec.id, rec.scope, rec.kind, rec.key, rec.session, rec.at, rec.by, fingerprint, rec.checkpoint, body],
    );
    return this.get(rec.scope, rec.id);
  }
  handoff(scope: string, id: string, session: string, input: unknown, checkpoint: string | null) {
    const body = HandoffInput.parse(input), n = handoffWords(body);
    if (n > HANDOFF_WORDS) throw new FleetError(400, `The handoff has ${n} words; keep it to about 500 and point to sources instead`);
    return this.insert({ id, scope, kind: "handoff", key: null, session, at: Date.now(), by: "agent", checkpoint, body });
  }
  note(scope: string, id: string, session: string, input: unknown) {
    return this.insert({ id, scope, kind: "note", key: null, session, at: Date.now(), by: "agent", checkpoint: null, body: NoteInput.parse(input) });
  }
  /** Replaces the active preference with that key; empty text forgets it. */
  prefer(scope: string, session: string | null, input: unknown) {
    const p = PreferenceInput.parse(input);
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.run("UPDATE agent_memory SET retired=? WHERE scope=? AND kind='preference' AND key=? AND retired IS NULL", [now, scope, p.key]);
      if (!p.text) return null;
      if (this.preferences(scope).length >= PREFERENCES_MAX) throw new FleetError(409, `Keep at most ${PREFERENCES_MAX} preferences; forget one first`);
      return this.insert({ id: crypto.randomUUID(), scope, kind: "preference", key: p.key, session: session ?? "operator", at: now, by: session ? "agent" : "operator", checkpoint: null, body: { text: p.text } });
    })();
  }
  preferences(scope: string) {
    return (this.db.query("SELECT * FROM agent_memory WHERE scope=? AND kind='preference' AND retired IS NULL ORDER BY key").all(scope) as Record<string, unknown>[]).map((r) => this.row(r));
  }
  recent(scope: string, kind: MemoryKind, limit: number, since = 0) {
    return (this.db.query("SELECT * FROM agent_memory WHERE scope=? AND kind=? AND at>=? AND retired IS NULL ORDER BY at DESC, rowid DESC LIMIT ?").all(scope, kind, since, limit) as Record<string, unknown>[]).map((r) => this.row(r));
  }
  used(id: string, by: string) {
    this.db.run("UPDATE agent_memory SET used_by=? WHERE id=? AND used_by IS NULL", [by, id]);
  }
  /** Every word must appear; newest first. Bounded, never the whole journal. */
  search(scope: string, query: string, limit = 10) {
    const want = [...terms(query)].slice(0, 8);
    const rows = this.db.query("SELECT * FROM agent_memory WHERE scope=? AND retired IS NULL ORDER BY at DESC LIMIT 2000").all(scope) as Record<string, unknown>[];
    return rows
      .filter((r) => want.every((t) => (r.body as string).toLowerCase().includes(t) || String(r.key ?? "").toLowerCase().includes(t)))
      .slice(0, Math.min(limit, 50))
      .map((r) => this.row(r))
      .map((r) => ({ id: r.id, kind: r.kind, at: r.at, session: r.session, summary: summary(r).slice(0, 300) }));
  }

  /**
   * What a fresh conversation starts from: durable preferences, the latest
   * handoff, up to two earlier ones that share words with the message, and
   * decisions recorded since. Bounded (about 12k characters) however long
   * the journal grows; the rest stays a search away.
   */
  bootstrap(scope: string, latest: string | null, message: string): string {
    const out: string[] = [];
    const prefs = this.preferences(scope);
    if (prefs.length) out.push(`Durable preferences:\n${prefs.map((p) => `- ${p.key}: ${(p.body as { text: string }).text}`).join("\n").slice(0, 4000)}`);
    const handoffs = this.recent(scope, "handoff", 40);
    const last = (latest && handoffs.find((h) => h.id === latest)) || handoffs[0];
    if (last) {
      const h = last.body as Handoff;
      out.push(
        [
          `Latest handoff ${last.id} (from conversation ${last.session}, ${new Date(last.at).toISOString()}):`,
          `Intent: ${h.intent}`,
          ...(h.decisions.length ? ["Decisions:", ...h.decisions.map((d) => `- ${d.decision}${d.why ? ` (why: ${d.why})` : ""}`)] : []),
          ...(h.open.length ? ["Open questions:", ...h.open.map((x) => `- ${x}`)] : []),
          ...(h.commitments.length ? ["Commitments:", ...h.commitments.map((x) => `- ${x}`)] : []),
          ...(h.refs.length ? ["References:", ...h.refs.map((r) => `- ${r.label}: ${r.ref}`)] : []),
        ].join("\n"),
      );
      const want = terms(message);
      const related = handoffs
        .filter((x) => x.id !== last.id)
        .map((x, i) => ({ x, i, shared: [...terms(JSON.stringify(x.body))].filter((t) => want.has(t)).length }))
        .filter((r) => r.shared > 0 || r.i === 0)
        .sort((a, b) => b.shared - a.shared || a.i - b.i)
        .slice(0, 2);
      if (related.length)
        out.push(`Earlier handoffs (read one with the show command below):\n${related.map(({ x }) => `- ${x.id} (${new Date(x.at).toISOString().slice(0, 10)}, conversation ${x.session}): ${(x.body as Handoff).intent.slice(0, 600)}`).join("\n")}`);
    }
    const notes = this.recent(scope, "note", 10, last?.at ?? 0);
    if (notes.length)
      out.push(`Decisions recorded since then:\n${notes.reverse().map((n) => `- ${(n.body as Note).decision}${(n.body as Note).why ? ` (why: ${(n.body as Note).why})` : ""}`).join("\n").slice(0, 3000)}`);
    return out.join("\n\n").slice(0, 12000);
  }
}
