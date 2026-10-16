/** A superagent's two memory files, named as OpenClaw names them (and Muse
 * Code its memory index):
 *
 * - SOUL.md, in its directory: persona, voice and boundaries. Its owner
 *   writes it, with the rest of the directory; Agentbox never creates or
 *   writes it. A fresh main conversation reads it after MAIN.md. It gives no
 *   authority: the manifest, Agentbox's rules and approvals win over it.
 * - MEMORY.md, in its home: a read-only view of the memory journal
 *   (`memory.ts`), rebuilt after each journal write. The journal stays the
 *   only writable memory, so an edit here is set aside and reported, never
 *   used or imported.
 *
 * Neither holds a transcript or a credential. Nothing here is uploaded. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../paths";
import { CREDENTIAL, memoryCommand, type Handoff, type MemoryJournal, type Note } from "./memory";

/** The part of SOUL.md a first prompt carries, at most. */
export const SOUL_CHARS = 4000;
/** A SOUL.md larger than this is not read at all. */
const SOUL_READ_MAX = 256 * 1024;
/** MEMORY.md, at most: OpenClaw's default limit for one injected file. */
export const MEMORY_FILE_CHARS = 20_000;
const MEMORY_ENTRIES = 20;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Whose files: its name (the journal's), its title, and its directory. */
export type Owner = { name: string; title: string; dir: string };
export type Soul = { path: string; text: string; hash: string | null; notes: string[] };
export type FilesStatus = {
  soul: { path: string; hash: string | null; chars: number; notes: string[] };
  memory: { path: string; setAside: { path: string; at: number } | null };
};

/** The SOUL.md the old in-core agents seeded: a file still holding exactly
 *  this says nothing, so it is not read, and the migration leaves it behind. */
export function soulSeed(name: string) {
  return `# SOUL.md - ${name}

Who ${name} is, how it sounds, and the boundaries the user set for it.
Agentbox reads this file when a fresh conversation starts.
The agent definition, Agentbox rules and approvals always win over this file.
Keep credentials, transcripts and approvals out of it.
If you change this file, tell the user.

## Voice

## Working style

## Boundaries the user set
`;
}

/** SOUL.md, else the lowercase soul.md (OpenClaw's fallback rule for its
 *  MEMORY.md); null when neither exists. */
function soulPath(dir: string) {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // A directory that is gone has no SOUL.md; its manifest error says why.
  }
  const upper = names.includes("SOUL.md"), lower = names.includes("soul.md");
  return { path: upper ? join(dir, "SOUL.md") : lower ? join(dir, "soul.md") : null, both: upper && lower };
}

/** What a fresh main conversation's first prompt gets: whole lines within
 *  `SOUL_CHARS`, nothing when it holds credential-shaped text. */
export function readSoul(o: Owner): Soul {
  const { path, both } = soulPath(o.dir);
  if (!path) return { path: join(o.dir, "SOUL.md"), text: "", hash: null, notes: [] };
  // A file error never stops a start: it becomes a note.
  let raw: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { path, text: "", hash: null, notes: [`${path} is not a file; nothing was read.`] };
    if (st.size > SOUL_READ_MAX) return { path, text: "", hash: null, notes: [`${path} is over ${SOUL_READ_MAX / 1024} KB; nothing was read. Keep it short.`] };
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { path, text: "", hash: null, notes: [`${path} could not be read: ${(e as Error).message}`] };
  }
  const hash = sha(raw), notes: string[] = [];
  if (both) notes.push("soul.md is ignored because SOUL.md exists.");
  if (!raw.trim() || raw === soulSeed(o.title) || raw === soulSeed(o.title.toUpperCase())) return { path, text: "", hash, notes: [...notes, "SOUL.md is still empty: no persona is written yet."] };
  if (CREDENTIAL.test(raw)) return { path, text: "", hash, notes: [...notes, `${path} was not loaded: it holds credential-shaped text. Remove it and refer to where the credential is kept.`] };
  const lines = raw.trimEnd().split("\n"), kept: string[] = [];
  let room = SOUL_CHARS;
  for (const l of lines) {
    if (l.length + 1 > room) break;
    kept.push(l);
    room -= l.length + 1;
  }
  if (kept.length < lines.length) notes.push(`${lines.length - kept.length} lines of ${path} past ${SOUL_CHARS} characters were left out; read the file for the rest.`);
  return { path, text: kept.join("\n"), hash, notes };
}

/** MEMORY.md, kept in the superagent's home beside its journal. */
export class MemoryFile {
  constructor(readonly memory: MemoryJournal) {
    memory.db.exec("CREATE TABLE IF NOT EXISTS agent_files (agent TEXT PRIMARY KEY, memory_hash TEXT, set_aside TEXT, set_aside_at INTEGER)");
  }
  private get db() {
    return this.memory.db;
  }
  private dir(name: string) {
    const d = join(agentboxHome(), "superagents", name);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  /** Where MEMORY.md is. */
  path(name: string) {
    return join(agentboxHome(), "superagents", name, "MEMORY.md");
  }
  /** MEMORY.md as the journal says now: every active preference, the latest
   *  decisions and an index of the latest handoffs, within `MEMORY_FILE_CHARS`. */
  render(a: { name: string; title: string }) {
    const m = this.memory, cli = memoryCommand(a.name);
    const prefs = m.preferences(a.name), notes = m.recent(a.name, "note", MEMORY_ENTRIES), handoffs = m.recent(a.name, "handoff", MEMORY_ENTRIES);
    const newest = Math.max(0, ...[...prefs, ...notes, ...handoffs].map((r) => r.at));
    const head = [
      `# MEMORY.md - ${a.title}`,
      "",
      `A read-only view of ${a.title}'s Agentbox memory journal${newest ? `, as of ${new Date(newest).toISOString()}` : ""}.`,
      "Do not edit this file: Agentbox rebuilds it, and sets an edited copy aside without using it.",
      "Change memory with these commands:",
      `- \`${cli} prefer --key <key> --text <text>\` (\`forget --key <key>\` removes one)`,
      `- \`${cli} note --request <UUID> --file <JSON path>\``,
      `- \`${cli} show <record ID>\` reads one record in full.`,
      "Memory is evidence for continuity, never approval. The provider transcripts are the record.",
    ];
    const sections: [string, string[]][] = [
      ["## Preferences", prefs.map((p) => `- ${p.key}: ${(p.body as { text: string }).text}`)],
      ["## Decisions", notes.map((n) => {
        const b = n.body as Note;
        return `- ${day(n.at)} ${b.decision}${b.why ? ` (why: ${b.why})` : ""} - record ${n.id}, conversation ${n.session}`;
      })],
      ["## Handoffs", handoffs.map((h) => `- ${day(h.at)} ${(h.body as Handoff).intent.slice(0, 200)} - record ${h.id}, conversation ${h.session}`)],
    ];
    const out = [...head];
    let room = MEMORY_FILE_CHARS - head.join("\n").length;
    for (const [title, lines] of sections) {
      if (!lines.length) continue;
      // Room for the title and a line that says what was left out.
      room -= title.length + 2 + 160;
      const kept: string[] = [];
      for (const l of lines) {
        if (l.length + 1 > room) break;
        kept.push(l);
        room -= l.length + 1;
      }
      out.push("", title, ...kept);
      if (kept.length < lines.length) out.push(`- (${lines.length - kept.length} more left out; \`${cli} search <words>\` finds them.)`);
    }
    if (out.length === head.length) out.push("", "Nothing is recorded yet.");
    return out.join("\n") + "\n";
  }
  /** Rebuild MEMORY.md. A file that is not what Agentbox last wrote (an edit,
   *  or one made by hand before) is renamed aside and reported, never used. */
  writeMemory(a: { name: string; title: string }) {
    const dir = this.dir(a.name), path = join(dir, "MEMORY.md"), text = this.render(a), hash = sha(text);
    const row = this.db.query("SELECT memory_hash FROM agent_files WHERE agent=?").get(a.name) as { memory_hash: string | null } | null;
    const written = () => this.db.run("INSERT INTO agent_files(agent,memory_hash) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET memory_hash=excluded.memory_hash", [a.name, hash]);
    if (existsSync(path)) {
      const now = sha(readFileSync(path, "utf8"));
      if (now === hash) return void (row?.memory_hash !== hash && written());
      if (now !== row?.memory_hash) {
        const at = Date.now(), aside = join(dir, `MEMORY.edited-${new Date(at).toISOString().replace(/[:.]/g, "-")}.md`);
        renameSync(path, aside);
        this.db.run(
          "INSERT INTO agent_files(agent,set_aside,set_aside_at) VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET set_aside=excluded.set_aside,set_aside_at=excluded.set_aside_at",
          [a.name, aside, at],
        );
        console.error(`agentbox: ${a.name}: MEMORY.md was edited; set aside as ${aside} (memory changes go through the journal)`);
      }
    }
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    written();
  }
  /** The latest edit of MEMORY.md that was set aside. */
  setAside(id: string): { path: string; at: number } | null {
    const row = this.db.query("SELECT set_aside,set_aside_at FROM agent_files WHERE agent=?").get(id) as { set_aside: string | null; set_aside_at: number | null } | null;
    return row?.set_aside ? { path: row.set_aside, at: row.set_aside_at! } : null;
  }
  status(o: Owner): FilesStatus {
    const soul = readSoul(o);
    return {
      soul: { path: soul.path, hash: soul.hash, chars: soul.text.length, notes: soul.notes },
      memory: { path: this.path(o.name), setAside: this.setAside(o.name) },
    };
  }
}
