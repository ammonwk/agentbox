#!/usr/bin/env bun
/**
 * Moves the agents of the old in-core Agents runtime (`<agentbox home>/agents/runtime.db`,
 * gone from agentbox's code) into superagents, so nothing they had is lost.
 *
 * Each old agent instance that has something to keep — a conversation, memory
 * records, a loop, a picture, a SOUL.md that is not the empty seed — becomes
 * a superagent directory in `--into` (default `~/.agents/superagents`), named
 * after the agent and, for a project's instance, the project
 * (`vulcan-plaibook-dev`). It is registered with its conversation as its main
 * (and the earlier ones as before), its loop, picture and provider choice,
 * and its memory journal is copied record by record (same ids) into the
 * superagent's home, with MEMORY.md rebuilt there. A SOUL.md that holds text
 * goes into the directory, which is the person's own config.
 *
 * Agentbox's code names no agent, so this script does not either: what an old
 * agent becomes is given on the command line.
 *   --template <old name>=<directory>   start from that superagent directory: its
 *                                       manifest and MAIN.md, its program run from there
 *   --events <old name>=<event>[,…]     the generic events it takes ("pr.ready")
 * An agent with no template becomes a conversation agent with its old instructions.
 *
 * The old runtime's work in flight goes with them: its issue claims become
 * work claims of the superagent that held them (so no second writer takes an
 * issue its old writer still works on), the ready PRs already handed over are
 * marked given (so `pr.ready` does not hand them over again), and the /help
 * receipts are kept. The old work families themselves are listed, not moved:
 * their sessions, PR claims and waits stay where they are.
 *
 * Run it after the server runs this version (integrate and restart first):
 * it refuses a database the server has not brought up to date. Each instance
 * moves once (`superagent_imports`); a directory this script did not write is
 * never overwritten, and neither is one that is not empty. `--dry-run` says
 * what it would do and writes nothing.
 *
 *   bun scripts/migrate-local-agents.ts --dry-run \
 *     --template vulcan=superagents/vulcan --events terminus=pr.ready
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getDb, getSessionRecord, listRepos, MIGRATIONS } from "../src/core/db";
import { agentboxHome } from "../src/core/paths";
import { soulSeed, MemoryFile } from "../src/core/superagent/files";
import { closeJournals, journalOf } from "../src/core/superagent/memory";
import { patchState } from "../src/core/superagent/state";
import { readManifest } from "../src/core/superagents";
import { canonicalSource } from "../src/core/workclaims";
import { SUPERAGENT_EVENTS } from "../src/core/types";

type Old = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  provider?: string;
  pinned?: string;
  repo: string | null;
  project?: string;
  session: string | null;
  previous?: string[];
  enabled: boolean;
  memoryPolicy?: { rollover?: boolean; idleMin?: number; contextPct?: number };
  loop?: { when: string; check: string | null; prompt: string; nextAt: number | null; due?: number | null; lastAt?: number | null; last?: string | null };
  avatar?: { file: string; at: number };
  selection?: { provider: string; why: string; at: number };
  rolled?: Record<string, string>;
  contexts?: Record<string, { handoff: string; session: string; at: number }[]>;
};

const args = process.argv.slice(2);
const flag = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]!] : a.startsWith(`${k}=`) ? [a.slice(k.length + 1)] : []));
const dry = args.includes("--dry-run");
const into = resolve((flag("--into")[0] ?? "~/.agents/superagents").replace(/^~(?=\/|$)/, homedir()));
const pairs = (k: string) => new Map(flag(k).map((p) => [p.slice(0, p.indexOf("=")).toLowerCase(), p.slice(p.indexOf("=") + 1)] as const));
const templates = new Map([...pairs("--template")].map(([k, v]) => [k, resolve(v)]));
const events = new Map([...pairs("--events")].map(([k, v]) => [k, v.split(",").map((e) => e.trim()).filter(Boolean)]));
for (const [k, list] of events) for (const e of list) if (!(SUPERAGENT_EVENTS as readonly string[]).includes(e)) throw new Error(`--events ${k}=${e}: not an event agentbox knows (${SUPERAGENT_EVENTS.join(", ")})`);
for (const [k, dir] of templates) {
  // A worktree goes away; the programs a template's copies run must not.
  if (dir.startsWith(join(agentboxHome(), "worktrees") + "/")) throw new Error(`--template ${k}=${dir}: that is a worktree, which is removed later; give the checkout the server runs from`);
  readManifest(dir);
  console.log(`template ${k}: ${dir}`);
}

// The server must have brought the database up to date: this script never migrates it.
const boxFile = join(agentboxHome(), "box.db");
if (existsSync(boxFile)) {
  const box = new Database(boxFile, { readonly: true });
  const version = (box.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  box.close();
  if (version < MIGRATIONS.length) {
    console.error(`${boxFile} is at version ${version}, and this agentbox needs ${MIGRATIONS.length}: integrate this branch and restart the server first, then run this.`);
    process.exit(1);
  }
}

const source = join(agentboxHome(), "agents", "runtime.db");
if (!existsSync(source)) {
  console.log(`nothing to move: ${source} does not exist`);
  process.exit(0);
}
// Read only; a WAL database without its -shm file opens only for writing, and nothing here writes it.
let old: Database;
try {
  old = new Database(source, { readonly: true });
  old.query("SELECT 1").get();
} catch {
  old = new Database(source);
}
const rows = (old.query("SELECT id, body FROM local_agents").all() as { id: string; body: string }[]).map((r) => ({ ...(JSON.parse(r.body) as Old), id: r.id }));
const has = (t: string) => !!old.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const records = new Map<string, number>();
if (has("agent_memory")) for (const r of old.query("SELECT scope, count(*) AS n FROM agent_memory GROUP BY scope").all() as { scope: string; n: number }[]) records.set(r.scope, r.n);
const repos = listRepos();
const db = getDb();

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const soulOf = (o: Old) => {
  const path = join(agentboxHome(), "agents", "local", o.id, "SOUL.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return text.trim() && text !== soulSeed(o.name) ? text : null;
};
const worth = (o: Old) => !!(o.session || o.previous?.length || records.get(o.id) || o.loop || o.avatar || soulOf(o));
const taken = new Set((db.query("SELECT name FROM superagents").all() as { name: string }[]).map((r) => r.name));

function nameOf(o: Old): string {
  const project = o.project ?? o.repo;
  const repo = project ? repos.find((r) => r.id === project) : null;
  let base = slug(o.name).replace(/^[^a-z]+/, "") || "agent";
  if (project) base = `${base}-${slug(repo?.displayName ?? project.slice(0, 8))}`;
  base = base.slice(0, 36).replace(/-+$/, "");
  let name = base;
  for (let n = 2; taken.has(name) && !ownedBy(name, o.id); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}
/** A name this script gave this instance in an earlier run. */
const ownedBy = (name: string, id: string) => !!db.query("SELECT 1 FROM superagent_imports WHERE name = ? AND source = ?").get(name, id);

/** The manifest and files of `o`'s directory. */
function directory(o: Old, name: string): { manifest: Record<string, unknown>; files: Record<string, string> } {
  const project = o.project ?? o.repo ?? null;
  const p = o.memoryPolicy ?? {};
  const rollover = p.rollover === false ? undefined : { idleMin: p.idleMin ?? 10, contextPct: p.contextPct ?? 60 };
  const provider = o.pinned ?? "auto";
  const where = project ? { repoId: project, worktree: true } : {};
  const common = {
    // A general instance showed in no project tab: it stays in All projects only.
    projects: project ? [project] : [],
    memory: true,
    sweep: true,
    ...(events.get(o.name.toLowerCase()) ? { events: events.get(o.name.toLowerCase()) } : {}),
  };
  const before = `# ${title(o.name)} before agentbox's superagents\n\nRole: ${o.role}\n\n${o.instructions}\n`;
  const tdir = templates.get(o.name.toLowerCase());
  if (!tdir) {
    return {
      manifest: { name, title: title(o.name), description: o.role, ...common, main: { start: { provider, ...(project ? where : { cwd: "." }) }, instructions: "MAIN.md", ...(rollover ? { rollover } : {}) } },
      files: { "MAIN.md": `${o.instructions.trim()}\n` },
    };
  }
  const t = JSON.parse(readFileSync(join(tdir, "superagent.json"), "utf8")) as Record<string, unknown> & { run?: string[]; main?: Record<string, unknown> };
  const start: Record<string, unknown> = { ...((t.main?.start as Record<string, unknown>) ?? {}), provider, ...where };
  if (project) delete start.cwd;
  // The program is the template's code, run from the template's directory.
  const run = t.run?.map((a) => (existsSync(join(tdir, a)) ? join(tdir, a) : a));
  const main = { ...(t.main ?? {}), start, ...(rollover ? { rollover } : {}) };
  const files: Record<string, string> = { "MAIN.before.md": before };
  if (typeof t.main?.instructions === "string") files["MAIN.md"] = readFileSync(join(tdir, t.main.instructions), "utf8");
  return { manifest: { ...t, name, ...(run ? { run } : {}), ...common, main: { ...main, ...(files["MAIN.md"] ? { instructions: "MAIN.md" } : {}) } }, files };
}

const MARK = ".migrated-from-local-agent.json";
let moved = 0;
/** The name each old agent gets in this run, for the work in flight below. */
const planned = new Map<string, string>();
for (const o of rows) {
  if (!worth(o)) continue;
  const done = db.query("SELECT name FROM superagent_imports WHERE source = ?").get(o.id) as { name: string } | null;
  if (done) {
    console.log(`${o.id}: moved before, to ${done.name}`);
    continue;
  }
  const name = nameOf(o);
  planned.set(o.id, name);
  const dir = join(into, name);
  const { manifest, files } = directory(o, name);
  const soul = soulOf(o);
  const memory = records.get(o.id) ?? 0;
  const main = o.session && getSessionRecord(o.session) ? o.session : null;
  const previous = (o.previous ?? []).filter((id) => getSessionRecord(id));
  const plan = `${o.id} → ${name} (${dir}): ${main ? `main ${main}` : "no main"}${previous.length ? `, ${previous.length} earlier` : ""}, ${memory} memory records${o.loop ? `, loop "${o.loop.when}"` : ""}${o.avatar ? ", picture" : ""}${soul ? ", SOUL.md" : ""}${templates.has(o.name.toLowerCase()) ? `, from ${templates.get(o.name.toLowerCase())}` : ", its own instructions"}${o.enabled ? "" : ", disabled"}`;
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, MARK))) {
    console.log(`${plan}\n  SKIPPED: ${dir} is not empty, and this script did not write it`);
    continue;
  }
  const row = db.query("SELECT dir FROM superagents WHERE name = ?").get(name) as { dir: string } | null;
  if (row && resolve(row.dir) !== dir) {
    console.log(`${plan}\n  SKIPPED: a superagent named ${name} is registered from ${row.dir}`);
    continue;
  }
  console.log(plan);
  if (dry) continue;

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "superagent.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  if (soul && !existsSync(join(dir, "SOUL.md"))) writeFileSync(join(dir, "SOUL.md"), soul);
  writeFileSync(join(dir, MARK), `${JSON.stringify({ from: o.id, at: Date.now() }, null, 2)}\n`);
  readManifest(dir);

  if (memory) {
    const j = journalOf(name);
    const insert = j.db.query("INSERT OR IGNORE INTO agent_memory (id, scope, kind, key, session, at, by, fingerprint, checkpoint, used_by, retired, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const all = old.query("SELECT * FROM agent_memory WHERE scope = ?").all(o.id) as Record<string, string | number | null>[];
    j.db.transaction(() => {
      for (const r of all) {
        const fingerprint = createHash("sha256").update(JSON.stringify([name, r.kind, r.key, r.body])).digest("hex");
        insert.run(r.id as string, name, r.kind as string, r.key, r.session as string, r.at as number, r.by as string, fingerprint, r.checkpoint, r.used_by, r.retired, r.body as string);
      }
    })();
    new MemoryFile(j).writeMemory({ name, title: String(manifest.title ?? name) });
  }
  db.transaction(() => {
    if (!row) db.run("INSERT INTO superagents (name, dir, enabled, main, previous, created_at) VALUES (?, ?, ?, ?, ?, ?)", [name, dir, o.enabled ? 1 : 0, main, JSON.stringify(previous), Date.now()]);
    patchState(name, (s) => {
      if (o.avatar) s.avatar = o.avatar;
      if (o.selection && (o.selection.provider === "claude" || o.selection.provider === "codex")) s.selection = { provider: o.selection.provider, why: o.selection.why, at: o.selection.at };
      if (o.rolled) s.rolled = { ...o.rolled, ...s.rolled };
      if (o.contexts) s.contexts = { ...o.contexts, ...s.contexts };
      if (o.loop) {
        const last = o.loop.lastAt ? { at: o.loop.lastAt, result: (/^skipped/.test(o.loop.last ?? "") ? "skipped" : /^failed/.test(o.loop.last ?? "") ? "failed" : "sent") as "sent" | "skipped" | "failed", detail: o.loop.last ?? "" } : null;
        // `of` empty: the loop's clock starts again on its rule at the first tick.
        s.loops = { ...s.loops, loop: { spec: { when: o.loop.when, check: o.loop.check, prompt: o.loop.prompt }, of: "", nextAt: o.loop.nextAt, due: o.loop.due ?? null, last } };
      }
    });
    db.run("INSERT INTO superagent_imports (source, name, at, report) VALUES (?, ?, ?, ?)", [o.id, name, Date.now(), plan]);
  })();

  if (o.avatar) {
    const pic = join(agentboxHome(), "agents", "avatars", o.avatar.file);
    if (!existsSync(pic)) console.log(`  its picture ${pic} is gone`);
  }
  moved++;
}
// ---- the old runtime's work in flight, once each (`superagent_imports`)
const nameOfOld = new Map((db.query("SELECT source, name FROM superagent_imports").all() as { source: string; name: string }[]).map((r) => [r.source, r.name]));
for (const [id, name] of planned) if (!nameOfOld.has(id)) nameOfOld.set(id, name);
const once = (source: string, name: string, report: string) => db.run("INSERT OR IGNORE INTO superagent_imports (source, name, at, report) VALUES (?, ?, ?, ?)", [source, name, Date.now(), report]).changes === 1;
const doneBefore = (source: string) => !!db.query("SELECT 1 FROM superagent_imports WHERE source = ?").get(source);
const works = new Map(has("agent_work") ? (old.query("SELECT id, body FROM agent_work").all() as { id: string; body: string }[]).map((r) => [r.id, JSON.parse(r.body) as { agent?: { id?: string }; state?: string; session?: string; input?: { issues?: { source: string }[] } }]) : []);

// Issue claims: the superagent that took over the old agent holds them, with its old writer.
if (has("agent_issue_claim"))
  for (const c of old.query("SELECT source, work FROM agent_issue_claim").all() as { source: string; work: string }[]) {
    const w = works.get(c.work), name = w?.agent?.id ? nameOfOld.get(w.agent.id) : undefined;
    const src = `issue-claim:${c.source}`;
    if (!name || doneBefore(src)) continue;
    const session = w?.session && getSessionRecord(w.session) ? w.session : null;
    console.log(`claim ${c.source} (old work ${c.work}) → held by ${name}${session ? ` with session ${session}` : ""}`);
    if (dry) continue;
    const now = Date.now();
    const canon = canonicalSource(c.source);
    db.transaction(() => {
      const taken = db.query("SELECT 1 FROM work_claims WHERE scope = 'work' AND key = ? AND state != 'released'").get(canon.key);
      if (!taken)
        db.run("INSERT OR REPLACE INTO work_claims (scope, key, source, fence, state, superagent, session, note, lease_until, claimed_at, updated_at) VALUES ('work', ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?)", [
          canon.key, canon.source, name, session, `old in-core work ${c.work}`, now + 90_000, now, now,
        ]);
      once(src, name, `claim ${c.source}${taken ? " (already held: left as it was)" : ""}`);
    })();
  }

// Ready PRs already handed over: given, so the pr.ready event does not hand them over again.
if (has("pr_ready")) {
  const takers = (db.query("SELECT name, dir FROM superagents").all() as { name: string; dir: string }[]).filter((r) => {
    try {
      return !!readManifest(r.dir).events?.includes("pr.ready");
    } catch {
      return false;
    }
  });
  for (const r of old.query("SELECT repo, number, head FROM pr_ready").all() as { repo: string; number: number; head: string }[]) {
    const key = `pr.ready:${r.repo.toLowerCase()}#${r.number}@${r.head.toLowerCase()}`;
    for (const t of takers) {
      if (doneBefore(`${key}:${t.name}`)) continue;
      console.log(`${r.repo}#${r.number} on ${r.head.slice(0, 10)} → already given to ${t.name}`);
      if (dry) continue;
      db.run("INSERT OR IGNORE INTO superagent_events (name, key, at) VALUES (?, ?, ?)", [t.name, key, Date.now()]);
      once(`${key}:${t.name}`, t.name, `pr.ready ${r.repo}#${r.number}`);
    }
  }
}

// /help and report receipts: kept for the superagent, so a lost answer still reconciles and the daily limit counts.
if (has("agent_feedback")) {
  if (!dry) db.exec("CREATE TABLE IF NOT EXISTS agent_feedback (id TEXT PRIMARY KEY, agent TEXT NOT NULL, body TEXT NOT NULL)");
  let kept = 0;
  for (const f of old.query("SELECT id, agent, body FROM agent_feedback").all() as { id: string; agent: string; body: string }[]) {
    const name = nameOfOld.get(f.agent);
    if (!name || doneBefore(`feedback:${f.id}`)) continue;
    kept++;
    if (dry) continue;
    const body = { ...(JSON.parse(f.body) as Record<string, unknown>), agent: name };
    db.run("INSERT OR IGNORE INTO agent_feedback (id, agent, body) VALUES (?, ?, ?)", [f.id, name, JSON.stringify(body)]);
    once(`feedback:${f.id}`, name, "report receipt");
  }
  if (kept) console.log(`${kept} report receipts → kept for their superagents`);
}

// The old work families are the old runtime's: listed, not moved.
for (const [id, w] of works) {
  if (w.state === "done" || w.state === "abandoned") continue;
  const name = w.agent?.id ? (nameOfOld.get(w.agent.id) ?? w.agent.id) : "?";
  console.log(`old work family ${id} (${w.state}) of ${name}, writer session ${w.session ?? "none"}: not moved; its sessions, PR claims and waits stay as they are, and its issues stay claimed`);
}

closeJournals();
console.log(dry ? "dry run: nothing changed" : `${moved} moved; the server shows them at its next look (agentbox superagent ls)`);
