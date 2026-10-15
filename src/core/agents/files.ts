/** A local agent's two files in its private directory, named as OpenClaw
 * names them (and Muse Code its memory index):
 *
 * - SOUL.md: persona, voice and boundaries. The user and the agent edit it;
 *   Agentbox creates it once and never writes it again. It is read when a
 *   fresh conversation starts and gives no authority: the definition,
 *   Agentbox's rules and approvals win over it.
 * - MEMORY.md: a read-only view of the memory journal (`memory.ts`), rebuilt
 *   after each journal write. The journal stays the only writable memory, so
 *   an edit here is set aside and reported, never used or imported.
 *
 * Neither holds a transcript or a credential. Nothing here is uploaded. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../paths";
import { CREDENTIAL, type AgentMemory, type Handoff, type Note } from "./memory";

/** The part of SOUL.md a first prompt carries, at most. */
export const SOUL_CHARS = 4000;
/** MEMORY.md, at most: OpenClaw's default limit for one injected file. */
export const MEMORY_FILE_CHARS = 20_000;
const MEMORY_ENTRIES = 20;

/** The agent's private directory, also its cwd when it has no repository. */
export const agentDir = (id: string) => join(agentboxHome(), "agents", "local", id);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export type Soul = { path: string; text: string; hash: string | null; notes: string[] };
export type FilesStatus = {
  dir: string;
  soul: { path: string; hash: string | null; notes: string[] };
  memory: { path: string; setAside: { path: string; at: number } | null };
};

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

export class AgentFiles {
  constructor(readonly db: Database, readonly memory: AgentMemory) {
    db.exec("CREATE TABLE IF NOT EXISTS agent_files (agent TEXT PRIMARY KEY, memory_hash TEXT, set_aside TEXT, set_aside_at INTEGER)");
  }
  private dir(id: string) {
    const d = agentDir(id);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  /** SOUL.md, else the lowercase soul.md (OpenClaw's fallback rule for its
   *  MEMORY.md); null when neither exists. */
  private soulPath(dir: string) {
    const names = readdirSync(dir);
    const upper = names.includes("SOUL.md"), lower = names.includes("soul.md");
    return { path: upper ? join(dir, "SOUL.md") : lower ? join(dir, "soul.md") : null, both: upper && lower };
  }
  /** Created once from the seed, then never written by Agentbox. */
  private seed(dir: string, name: string) {
    if (this.soulPath(dir).path) return;
    try {
      writeFileSync(join(dir, "SOUL.md"), soulSeed(name), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  /** What a fresh conversation's first prompt gets: whole lines within
   *  `SOUL_CHARS`, nothing when it holds credential-shaped text. */
  soul(a: { id: string; name: string }): Soul {
    const dir = this.dir(a.id);
    this.seed(dir, a.name);
    const { path, both } = this.soulPath(dir);
    const fallback = join(dir, "SOUL.md");
    if (!path) return { path: fallback, text: "", hash: null, notes: ["SOUL.md is missing."] };
    const raw = readFileSync(path, "utf8"), hash = sha(raw), notes: string[] = [];
    if (both) notes.push("soul.md is ignored because SOUL.md exists.");
    // The untouched seed says nothing the prompt does not; one line instead.
    if (raw === soulSeed(a.name)) return { path, text: "", hash, notes: [...notes, "SOUL.md is still the empty seed: no persona is written yet."] };
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
  /** MEMORY.md as the journal says now: every active preference, the latest
   *  decisions and an index of the latest handoffs, within `MEMORY_FILE_CHARS`. */
  render(a: { id: string; name: string }) {
    const m = this.memory, cli = "agentbox";
    const prefs = m.preferences(a.id), notes = m.recent(a.id, "note", MEMORY_ENTRIES), handoffs = m.recent(a.id, "handoff", MEMORY_ENTRIES);
    const newest = Math.max(0, ...[...prefs, ...notes, ...handoffs].map((r) => r.at));
    const head = [
      `# MEMORY.md - ${a.name}`,
      "",
      `A read-only view of ${a.name}'s Agentbox memory journal${newest ? `, as of ${new Date(newest).toISOString()}` : ""}.`,
      "Do not edit this file: Agentbox rebuilds it, and sets an edited copy aside without using it.",
      "Change memory with these commands:",
      `- \`${cli} agent memory ${a.id} prefer --key <key> --text <text>\` (\`forget --key <key>\` removes one)`,
      `- \`${cli} agent memory ${a.id} note --request <UUID> --file <JSON path>\``,
      `- \`${cli} agent memory ${a.id} show <record ID>\` reads one record in full.`,
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
      if (kept.length < lines.length) out.push(`- (${lines.length - kept.length} more left out; \`${cli} agent memory ${a.id} search <words>\` finds them.)`);
    }
    if (out.length === head.length) out.push("", "Nothing is recorded yet.");
    return out.join("\n") + "\n";
  }
  /** Rebuild MEMORY.md. A file that is not what Agentbox last wrote (an edit,
   *  or one made by hand before) is renamed aside and reported, never used. */
  writeMemory(a: { id: string; name: string }) {
    const dir = this.dir(a.id), path = join(dir, "MEMORY.md"), text = this.render(a), hash = sha(text);
    const row = this.db.query("SELECT memory_hash FROM agent_files WHERE agent=?").get(a.id) as { memory_hash: string | null } | null;
    const written = () => this.db.run("INSERT INTO agent_files(agent,memory_hash) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET memory_hash=excluded.memory_hash", [a.id, hash]);
    if (existsSync(path)) {
      const now = sha(readFileSync(path, "utf8"));
      if (now === hash) return void (row?.memory_hash !== hash && written());
      if (now !== row?.memory_hash) {
        const at = Date.now(), aside = join(dir, `MEMORY.edited-${new Date(at).toISOString().replace(/[:.]/g, "-")}.md`);
        renameSync(path, aside);
        this.db.run(
          "INSERT INTO agent_files(agent,set_aside,set_aside_at) VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET set_aside=excluded.set_aside,set_aside_at=excluded.set_aside_at",
          [a.id, aside, at],
        );
        console.error(`agentbox: ${a.id}: MEMORY.md was edited; set aside as ${aside} (memory changes go through the journal)`);
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
  status(a: { id: string; name: string }): FilesStatus {
    const soul = this.soul(a), dir = agentDir(a.id);
    return {
      dir,
      soul: { path: soul.path, hash: soul.hash, notes: soul.notes },
      memory: { path: join(dir, "MEMORY.md"), setAside: this.setAside(a.id) },
    };
  }
}
