/**
 * Steward: every `every` seconds, one pass over this person's open pull
 * requests and the sessions it started. A pull request that needs work and
 * has nobody on it gets an owner session; a session that ends on `STATUS:
 * needs …` becomes an item for the steward's main conversation, which judges.
 * The pass holds nothing between runs but its store, so a restart picks up
 * where it was, and every start is keyed so it never happens twice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError, AgentboxError, agentbox, call, every, md, me, serve, store, type AgentBlock, type AgentView } from "../lib/sdk";
import type { Session } from "../../src/core/types";

type Config = { repos: string[]; author: string; every: number; owners: { provider: string; running: number; perPass: number; prompt: string } };
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "agent.json"), "utf8")) as { steward: Config };
const cfg = manifest.steward;

type Check = { conclusion?: string | null; state?: string | null; status?: string | null; name?: string; context?: string };
type Pr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  statusCheckRollup: Check[] | null;
};
type State = "draft" | "needs-work" | "pending" | "ready";

const db = store();
db.exec(`
  CREATE TABLE IF NOT EXISTS started (key TEXT PRIMARY KEY, session TEXT NOT NULL, pr TEXT, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, line TEXT NOT NULL, session TEXT, at INTEGER NOT NULL, told INTEGER, done_at INTEGER, note TEXT);
  CREATE TABLE IF NOT EXISTS log (at INTEGER NOT NULL, what TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
const log = (what: string) => db.run("INSERT INTO log VALUES (?, ?)", [Date.now(), what]);
const kv = (k: string): string | null => (db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
const setKv = (k: string, v: string | null) => (v === null ? db.run("DELETE FROM kv WHERE k = ?", [k]) : db.run("INSERT OR REPLACE INTO kv VALUES (?, ?)", [k, v]));

let last: { at: number; prs: (Pr & { state: State; why: string; owner: string | null })[]; error: string | null } = { at: 0, prs: [], error: null };

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${err.trim().slice(0, 300)}`);
  return out;
}

function stateOf(pr: Pr): { state: State; why: string } {
  if (pr.isDraft) return { state: "draft", why: "draft" };
  const checks = pr.statusCheckRollup ?? [];
  const failed = checks.filter((c) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].includes((c.conclusion ?? c.state ?? "").toUpperCase()));
  const why: string[] = [];
  if (pr.mergeable === "CONFLICTING") why.push("it conflicts with its base");
  if (failed.length) why.push(`${failed.map((c) => c.name ?? c.context).join(", ")} failed`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") why.push("a reviewer asked for changes");
  if (why.length) return { state: "needs-work", why: why.join("; ") };
  const pending = checks.some((c) => (c.status && c.status.toUpperCase() !== "COMPLETED") || (c.state ?? "").toUpperCase() === "PENDING");
  return pending ? { state: "pending", why: "checks are running" } : { state: "ready", why: "green and clean" };
}

async function repos(): Promise<{ slug: string; id: string | null }[]> {
  const registered = (await agentbox.state()).repos;
  const slugs = cfg.repos.length ? cfg.repos : registered.map((r) => r.fullName).filter((x): x is string => !!x);
  return [...new Set(slugs)].map((slug) => ({ slug, id: registered.find((r) => r.fullName?.toLowerCase() === slug.toLowerCase())?.id ?? null }));
}

const live = (s: Session | undefined) => !!s && s.status !== "closed" && s.status !== "stopped";

async function pass(): Promise<void> {
  if (kv("paused")) return;
  const state = await agentbox.state(false);
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const main = (await agentbox.self()).main;

  // The pull requests, and what each needs.
  const prs: typeof last.prs = [];
  for (const r of await repos()) {
    const out = await gh(["pr", "list", "--repo", r.slug, "--author", cfg.author, "--state", "open", "--limit", "100", "--json", "number,title,url,headRefName,headRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup"]);
    for (const p of JSON.parse(out) as Omit<Pr, "repo">[]) {
      const pr = { ...p, repo: r.slug };
      const who = await agentbox.prWho(`${r.slug}#${p.number}`).catch(() => null);
      prs.push({ ...pr, ...stateOf(pr), owner: who?.claim?.sessionId ?? null });
    }
  }
  last = { at: Date.now(), prs, error: null };

  // Owners for what needs work and has nobody, a few a pass, up to the dial.
  const running = (db.query("SELECT session FROM started").all() as { session: string }[]).filter((r) => live(byId.get(r.session))).length;
  let room = Math.min(cfg.owners.perPass, cfg.owners.running - running);
  const template = readFileSync(join(import.meta.dir, cfg.owners.prompt), "utf8");
  for (const pr of prs) {
    if (room <= 0) break;
    if (pr.state !== "needs-work" || pr.owner) continue;
    const key = `owner:${pr.repo}#${pr.number}:${pr.headRefOid.slice(0, 10)}`;
    const had = db.query("SELECT session FROM started WHERE key = ?").get(key) as { session: string } | null;
    if (had) continue;
    const repoId = (await repos()).find((r) => r.slug === pr.repo)?.id;
    const prompt = template
      .replaceAll("{{url}}", pr.url)
      .replaceAll("{{title}}", pr.title)
      .replaceAll("{{number}}", String(pr.number))
      .replaceAll("{{why}}", pr.why);
    try {
      const s = await agentbox.start({
        provider: cfg.owners.provider,
        prompt,
        claim: `${pr.repo}#${pr.number}`,
        ...(repoId ? { repoId, branch: pr.headRefName } : {}),
        ...(main ? { parent: main } : {}),
      });
      db.run("INSERT INTO started VALUES (?, ?, ?, ?)", [key, s.id, `${pr.repo}#${pr.number}`, Date.now()]);
      log(`started owner ${s.id} for ${pr.repo}#${pr.number}: ${pr.why}`);
      room--;
    } catch (e) {
      // Another session took it a moment ago, or no account has room: next pass looks again.
      log(`could not start an owner for ${pr.repo}#${pr.number}: ${(e as Error).message}`);
      if (!(e instanceof AgentboxError) || e.status !== 409) break;
    }
  }

  // What its sessions asked: one item per question, said to the main conversation once.
  for (const r of db.query("SELECT session, pr FROM started").all() as { session: string; pr: string | null }[]) {
    const s = byId.get(r.session);
    if (!s || s.status === "running") continue;
    const ask = /STATUS:\s*needs\s+(.+)/i.exec(s.lastMessage ?? "");
    if (!ask) continue;
    const key = `question:${s.id}:${s.lastActivityAt}`;
    db.run("INSERT OR IGNORE INTO items (key, line, session, at) VALUES (?, ?, ?, ?)", [key, `${s.id}${r.pr ? ` (${r.pr})` : ""} asks: ${ask[1]!.slice(0, 400)}`, s.id, Date.now()]);
  }
  await tellMain(main);
}

/** New items go to the main conversation in one message; a main that is working hears it at its next pass. */
async function tellMain(main: string | null): Promise<void> {
  const fresh = db.query("SELECT key, line FROM items WHERE done_at IS NULL AND told IS NULL ORDER BY at").all() as { key: string; line: string }[];
  if (!fresh.length) return;
  const text = `[steward] ${fresh.length} item${fresh.length === 1 ? "" : "s"} to judge:\n${fresh.map((i) => `- ${i.key}: ${i.line}`).join("\n")}`;
  try {
    if (main) {
      const s = await agentbox.session(main);
      if (s?.status === "running") return;
      await agentbox.send(main, text, { wake: true });
    } else {
      await call("POST", `/api/agents/${me.name}/chat`, { text, sendId: crypto.randomUUID() });
    }
    db.run(`UPDATE items SET told = ? WHERE key IN (${fresh.map(() => "?").join(",")})`, [Date.now(), ...fresh.map((i) => i.key)]);
  } catch (e) {
    log(`could not tell the main conversation: ${(e as Error).message}`);
  }
}

every(cfg.every * 1000, async () => {
  try {
    await pass();
  } catch (e) {
    last = { ...last, error: (e as Error).message };
    throw e;
  }
});

serve({
  action({ action, values }) {
    switch (action) {
      case "done": {
        const key = String(values.key ?? "");
        const n = db.run("UPDATE items SET done_at = ?, note = ? WHERE key = ? AND done_at IS NULL", [Date.now(), String(values.note ?? ""), key]).changes;
        if (!n) throw new ActionError(`no open item ${key}`, 404);
        log(`done ${key}: ${String(values.note ?? "")}`);
        return { message: "Done." };
      }
      case "pause":
        setKv("paused", String(Date.now()));
        log("paused");
        return { message: "Paused: no passes until you resume it." };
      case "resume":
        setKv("paused", null);
        log("resumed");
        return { message: "Resumed." };
      default:
        throw new ActionError(`the steward has no action ${action}`, 404);
    }
  },
  view(tab): AgentView {
    const open = db.query("SELECT key, line, session, at FROM items WHERE done_at IS NULL ORDER BY at").all() as { key: string; line: string; session: string | null; at: number }[];
    const tabs = [
      { id: "prs", title: "Pull requests", badge: last.prs.filter((p) => p.state === "needs-work" && !p.owner).length },
      { id: "inbox", title: "Inbox", badge: open.length },
      { id: "log", title: "Log" },
    ];
    const paused = kv("paused");
    const head: AgentBlock[] = [
      {
        type: "fields",
        items: [
          { label: "Repositories", value: (cfg.repos.length ? cfg.repos : ["every registered GitHub repository"]).join(", ") },
          { label: "Last pass", value: last.at ? new Date(last.at).toLocaleTimeString() : "not yet" },
          { label: "State", value: paused ? "paused" : last.error ? `failing: ${md(last.error)}` : "running" },
        ],
      },
      { type: "actions", actions: [paused ? { id: "resume", label: "Resume", style: "primary" } : { id: "pause", label: "Pause" }] },
    ];
    if (tab === "inbox")
      return {
        tabs,
        refresh: 10,
        blocks: open.length
          ? open.map((i) => ({ type: "item", title: i.line, subtitle: i.key, sessions: i.session ? [i.session] : [], actions: [{ id: "done", label: "Done", values: { key: i.key } }] }))
          : [{ type: "markdown", text: "Nothing waits on judgement." }],
      };
    if (tab === "log")
      return {
        tabs,
        refresh: 10,
        blocks: [{ type: "markdown", text: (db.query("SELECT at, what FROM log ORDER BY at DESC LIMIT 80").all() as { at: number; what: string }[]).map((l) => `- ${new Date(l.at).toLocaleString()}: ${md(l.what)}`).join("\n") || "Nothing yet." }],
      };
    const order: State[] = ["needs-work", "pending", "ready", "draft"];
    return {
      tabs,
      refresh: 10,
      blocks: [
        ...head,
        ...order.flatMap((st) => {
          const these = last.prs.filter((p) => p.state === st);
          return these.length
            ? [
                { type: "heading", text: `${st} (${these.length})` } as AgentBlock,
                ...these.map(
                  (p): AgentBlock => ({
                    type: "item",
                    status: st === "needs-work" ? (p.owner ? "busy" : "warn") : st === "ready" ? "ok" : "idle",
                    title: `${p.repo}#${p.number} ${p.title}`,
                    subtitle: p.why,
                    sessions: p.owner ? [p.owner] : [],
                    links: [{ label: "Pull request", url: p.url }],
                  }),
                ),
              ]
            : [];
        }),
      ],
    };
  },
});
console.log(`steward ${me.name}: every ${cfg.every}s over ${cfg.repos.join(", ") || "every registered GitHub repository"}`);
