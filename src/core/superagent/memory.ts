/** Bounded continuity records for a superagent's main conversations:
 * handoffs, decisions and preferences (manifest `"memory": true`). They are
 * evidence for the next conversation, never authorization. The provider
 * transcript stays the record: a record names its source session, it never
 * copies a transcript. Each superagent's journal is `memory.db` in its home,
 * so it stays with the superagent's other state. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FleetError } from "../fleet";
import { agentboxBin, agentboxHome } from "../paths";

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
/** One preference: a rule with its reason and exceptions, not only a phrase. */
export const PREFERENCE_CHARS = 1500;
export const NoteInput = z
  .object({ decision: text(400), why: z.string().trim().max(600).default(""), refs: z.array(Ref).max(8).default([]) })
  .strict();
export type Note = z.infer<typeof NoteInput>;
export const PreferenceInput = z
  .object({ key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/i, "key: letters, digits, . _ -"), text: z.string().trim().max(PREFERENCE_CHARS) })
  .strict();
/** About 500 words, with a margin for references. */
export const HANDOFF_WORDS = 550;
export const PREFERENCES_MAX = 40;
/** The memory part of a fresh conversation's first prompt, at most. */
export const BOOTSTRAP_CHARS = 12_000;

export type MemoryKind = "handoff" | "note" | "preference";
/** A handoff put into a conversation's first prompt, and the conversation it summarizes. */
export type Supplied = { handoff: string; session: string; at: number };
export type MemoryRecord = {
  id: string;
  scope: string;
  kind: MemoryKind;
  key: string | null;
  /** The provider conversation it came from; `agentbox log` reads it. */
  session: string;
  at: number;
  /** Its main conversation, a person, or its program. */
  by: "agent" | "operator" | "program";
  /** The checkpoint request it answers, for a handoff saved on request. */
  checkpoint: string | null;
  /** The conversation that started from it. */
  usedBy: string | null;
  retired: number | null;
  body: Handoff | Note | { text: string };
};

/** Credential-shaped text: refused in memory and reports, redacted from what
 *  a teammate reads. GitHub, OpenAI and Anthropic, Stripe, Slack, AWS, Google
 *  and Supabase keys, JWTs, private keys, and a URL with a password in it. */
export const CREDENTIAL =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [^-]*PRIVATE KEY-----|\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@)/;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
export function handoffWords(h: Handoff) {
  return words([h.intent, ...h.decisions.flatMap((d) => [d.decision, d.why]), ...h.open, ...h.commitments, ...h.refs.map((r) => r.label)].join(" "));
}
const summary = (r: MemoryRecord) =>
  r.kind === "handoff" ? (r.body as Handoff).intent : r.kind === "note" ? (r.body as Note).decision : `${r.key}: ${(r.body as { text: string }).text}`;
const terms = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9_#./-]{3,}/g) ?? []);

const journals = new Map<string, MemoryJournal>();

/** The journal of superagent `name`: `<agentbox home>/superagents/<name>/memory.db`. */
export function journalOf(name: string): MemoryJournal {
  let j = journals.get(name);
  if (!j) {
    const home = join(agentboxHome(), "superagents", name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    j = new MemoryJournal(new Database(join(home, "memory.db")), name);
    journals.set(name, j);
  }
  return j;
}

/** Close every journal opened here (tests, and a server that stops). */
export function closeJournals(): void {
  for (const j of journals.values()) j.db.close();
  journals.clear();
}

/** The command a conversation runs to read and write its own journal. */
export const memoryCommand = (name: string) => `${agentboxBin()} superagent memory ${name}`;

export class MemoryJournal {
  /** `scope` names whose records these are: the superagent's name. */
  constructor(
    readonly db: Database,
    readonly scope: string,
  ) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
        key TEXT, session TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, fingerprint TEXT NOT NULL,
        checkpoint TEXT, used_by TEXT, retired INTEGER, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_memory_scope ON agent_memory(scope, kind, at);`);
  }
  private row(r: Record<string, unknown>): MemoryRecord {
    return {
      id: r.id as string, scope: r.scope as string, kind: r.kind as MemoryKind, key: (r.key as string) ?? null,
      session: r.session as string, at: r.at as number, by: r.by as MemoryRecord["by"],
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
  handoff(scope: string, id: string, session: string, input: unknown, checkpoint: string | null, by: MemoryRecord["by"] = "agent") {
    const body = HandoffInput.parse(input), n = handoffWords(body);
    if (n > HANDOFF_WORDS) throw new FleetError(400, `The handoff has ${n} words; keep it to about 500 and point to sources instead`);
    return this.insert({ id, scope, kind: "handoff", key: null, session, at: Date.now(), by, checkpoint, body });
  }
  note(scope: string, id: string, session: string, input: unknown, by: MemoryRecord["by"] = "agent") {
    return this.insert({ id, scope, kind: "note", key: null, session, at: Date.now(), by, checkpoint: null, body: NoteInput.parse(input) });
  }
  /** Replaces the active preference with that key; empty text forgets it. */
  prefer(scope: string, session: string | null, input: unknown, by: MemoryRecord["by"] = session ? "agent" : "operator") {
    const p = PreferenceInput.parse(input);
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.run("UPDATE agent_memory SET retired=? WHERE scope=? AND kind='preference' AND key=? AND retired IS NULL", [now, scope, p.key]);
      if (!p.text) return null;
      if (this.preferences(scope).length >= PREFERENCES_MAX) throw new FleetError(409, `Keep at most ${PREFERENCES_MAX} preferences; forget one first`);
      return this.insert({ id: crypto.randomUUID(), scope, kind: "preference", key: p.key, session: session ?? by, at: now, by, checkpoint: null, body: { text: p.text } });
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
   * decisions recorded since, within `BOOTSTRAP_CHARS` however long the
   * journal grows. Assembled by whole lines: a handoff too long for what is
   * left loses its last lines (said, with how to read the rest), and an
   * earlier one that does not fit is left out. `supplied` names exactly the
   * handoffs whose text went in; the rest stays a search away.
   */
  bootstrap(scope: string, latest: string | null, message: string): { text: string; supplied: Supplied[] } {
    const out: string[] = [], supplied: Supplied[] = [];
    let left = BOOTSTRAP_CHARS;
    /** Whole lines while they fit; how many did not. */
    const take = (lines: string[], room: number) => {
      const kept: string[] = [];
      for (const l of lines) {
        if (l.length + 1 > room) break;
        kept.push(l);
        room -= l.length + 1;
      }
      return { kept, dropped: lines.length - kept.length };
    };
    const block = (head: string, lines: string[], room = left) => {
      const { kept } = take([head, ...lines], Math.min(room, left - 2));
      if (kept.length < 2) return 0;
      out.push(kept.join("\n"));
      left -= kept.join("\n").length + 2;
      return kept.length - 1;
    };
    const prefs = this.preferences(scope);
    if (prefs.length) {
      const shown = block("Durable preferences:", prefs.map((p) => `- ${p.key}: ${(p.body as { text: string }).text}`), 6000);
      // Never dropped without a word: the rest are a search away.
      if (shown < prefs.length) {
        const rest = `${prefs.length - shown} more preference(s) did not fit: ${prefs.slice(shown).map((p) => p.key).join(", ")}. Read them with ${memoryCommand(this.scope)} search <key>.`;
        out.push(rest);
        left -= rest.length + 2;
      }
    }
    const handoffs = this.recent(scope, "handoff", 40);
    const last = (latest && handoffs.find((h) => h.id === latest)) || handoffs[0];
    if (last) {
      const h = last.body as Handoff;
      const lines = [
        `Intent: ${h.intent}`,
        ...(h.decisions.length ? ["Decisions:", ...h.decisions.map((d) => `- ${d.decision}${d.why ? ` (why: ${d.why})` : ""}`)] : []),
        ...(h.open.length ? ["Open questions:", ...h.open.map((x) => `- ${x}`)] : []),
        ...(h.commitments.length ? ["Commitments:", ...h.commitments.map((x) => `- ${x}`)] : []),
        ...(h.refs.length ? ["References:", ...h.refs.map((r) => `- ${r.label}: ${r.ref}`)] : []),
      ];
      const tail = `(The rest of this handoff did not fit; read it with the show command for ${last.id}.)`;
      const { kept, dropped } = take(lines, left - 200 - tail.length);
      if (kept.length) {
        block(`Latest handoff ${last.id} (from conversation ${last.session}, ${new Date(last.at).toISOString()}):`, dropped ? [...kept, tail] : kept);
        supplied.push({ handoff: last.id, session: last.session, at: last.at });
      }
      const want = terms(message);
      const related = handoffs
        .filter((x) => x.id !== last.id)
        .map((x, i) => ({ x, i, shared: [...terms(JSON.stringify(x.body))].filter((t) => want.has(t)).length }))
        .filter((r) => r.shared > 0 || r.i === 0)
        .sort((a, b) => b.shared - a.shared || a.i - b.i)
        .slice(0, 2)
        .map(({ x }) => ({ x, line: `- ${x.id} (${new Date(x.at).toISOString().slice(0, 10)}, conversation ${x.session}): ${(x.body as Handoff).intent.slice(0, 600)}` }));
      const head = "Earlier handoffs (read one with the show command below):";
      const fits = take(related.map((r) => r.line), left - head.length - 3).kept.length;
      if (fits && block(head, related.slice(0, fits).map((r) => r.line)) === fits)
        supplied.push(...related.slice(0, fits).map(({ x }) => ({ handoff: x.id, session: x.session, at: x.at })));
    }
    const notes = this.recent(scope, "note", 10, last?.at ?? 0);
    if (notes.length)
      block("Decisions recorded since then:", notes.reverse().map((n) => `- ${(n.body as Note).decision}${(n.body as Note).why ? ` (why: ${(n.body as Note).why})` : ""}`), 3000);
    return { text: out.join("\n\n"), supplied };
  }
}
