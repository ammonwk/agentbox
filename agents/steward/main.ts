/**
 * Steward: takes pull requests to ready. Each one it has is a hand-off: from
 * anyone, with `agentbox agent call steward tend --set pr=<PR> [--set
 * note=<findings>]`, or from its own scan, which every `every` seconds hands
 * it each open PR by `author` that needs work and has nobody on it (unless
 * `discover` is false, when it takes only what it is handed).
 *
 * A hand-off goes to one owner: the session that already holds the PR, so
 * its context is kept, else one the steward started on it before, else a new
 * one. The PR counts as ready only when its owner ends a turn with `STATUS:
 * ready <SHA>` and GitHub shows that SHA as its head, green and clean. An
 * answer that does not hold up is said back to the owner once; the next time
 * the main conversation hears of it, as it hears every `STATUS: needs …`.
 *
 * The pass holds nothing between runs but its store, so a restart picks up
 * where it was.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError, agentbox, call, every, md, me, serve, store, type AgentBlock, type AgentView } from "../lib/sdk";
import type { Session } from "../../src/core/types";

type Config = { repos: string[]; author: string; every: number; discover?: boolean; owners: { provider: string; running: number; perPass: number; prompt: string } };
const cfg = (JSON.parse(readFileSync(join(import.meta.dir, "agent.json"), "utf8")) as { steward: Config }).steward;
const discover = cfg.discover !== false;

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
  state?: string;
};
type State = "draft" | "needs-work" | "pending" | "ready";
const FIELDS = "number,title,url,headRefName,headRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup";

/** One PR it has: open (no owner yet), owned, ready, lost (its owner stopped first) or closed. */
type Tend = { pr: string; head: string; note: string | null; sender: string; at: number; session: string | null; given: number | null; answered: number | null; told: number; state: "open" | "owned" | "ready" | "lost" | "closed" };

const db = store();
db.exec(`
  CREATE TABLE IF NOT EXISTS tends (pr TEXT PRIMARY KEY, head TEXT NOT NULL, note TEXT, sender TEXT NOT NULL, at INTEGER NOT NULL,
    session TEXT, given INTEGER, answered INTEGER, told INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, line TEXT NOT NULL, session TEXT, at INTEGER NOT NULL, told INTEGER, done_at INTEGER, note TEXT);
  CREATE TABLE IF NOT EXISTS log (at INTEGER NOT NULL, what TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
const log = (what: string) => db.run("INSERT INTO log VALUES (?, ?)", [Date.now(), what]);
const kv = (k: string): string | null => (db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
const setKv = (k: string, v: string | null) => (v === null ? db.run("DELETE FROM kv WHERE k = ?", [k]) : db.run("INSERT OR REPLACE INTO kv VALUES (?, ?)", [k, v]));
const tendOf = (pr: string) => db.query("SELECT * FROM tends WHERE pr = ?").get(pr) as Tend | null;
const tends = (...states: Tend["state"][]) => db.query(`SELECT * FROM tends WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY at`).all(...states) as Tend[];
const item = (key: string, line: string, session: string | null) => db.run("INSERT OR IGNORE INTO items (key, line, session, at) VALUES (?, ?, ?, ?)", [key, line, session, Date.now()]);

let last: { at: number; prs: (Pr & { state: State; why: string; owner: string | null })[]; error: string | null } = { at: 0, prs: [], error: null };

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${err.trim().slice(0, 300)}`);
  return out;
}

const view = async (pr: string): Promise<Pr> => {
  const [repo, n] = pr.split("#") as [string, string];
  return { ...(JSON.parse(await gh(["pr", "view", n, "--repo", repo, "--json", `${FIELDS},state`])) as Omit<Pr, "repo">), repo };
};

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

/** The line an owner ends its turn with. */
function said(text: string | null): { kind: "needs"; what: string } | { kind: "ready"; head: string } | { kind: "other" } {
  const needs = /STATUS:\s*needs\s+(.+)/i.exec(text ?? "");
  if (needs) return { kind: "needs", what: needs[1]! };
  const ready = /STATUS:\s*ready\s+([0-9a-f]{7,40})\b/i.exec(text ?? "");
  return ready ? { kind: "ready", head: ready[1]!.toLowerCase() } : { kind: "other" };
}

async function repos(): Promise<{ slug: string; id: string | null }[]> {
  const registered = (await agentbox.state()).repos;
  const slugs = cfg.repos.length ? cfg.repos : registered.map((r) => r.fullName).filter((x): x is string => !!x);
  return [...new Set(slugs)].map((slug) => ({ slug, id: registered.find((r) => r.fullName?.toLowerCase() === slug.toLowerCase())?.id ?? null }));
}

const live = (s: Session | undefined) => !!s && s.status !== "closed" && s.status !== "stopped";

/** `owner/name#N`, from that or a pull request's URL. */
function prRef(v: unknown): string {
  const s = String(v ?? "").trim();
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s) ?? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(s);
  if (!m) throw new ActionError("tend needs pr: owner/name#N or the PR's URL");
  return `${m[1]!.toLowerCase()}#${m[2]}`;
}

/** Take a hand-off. A newer one of the same PR replaces what it says; an owner at work on it is told at the next pass. */
function tend(pr: string, head: string, note: string | null, sender: string): string {
  if (cfg.repos.length && !cfg.repos.some((r) => r.toLowerCase() === pr.split("#")[0])) throw new ActionError(`the steward looks after ${cfg.repos.join(", ")}, not ${pr}`, 403);
  const had = tendOf(pr);
  if (had && had.state === "owned") {
    db.run("UPDATE tends SET head = ?, note = ?, sender = ?, at = ?, given = NULL, answered = NULL, told = 0 WHERE pr = ?", [head, note, sender, Date.now(), pr]);
    log(`${pr} handed again by ${sender}: its owner ${had.session} is told`);
    return `${pr} goes back to its owner ${had.session}`;
  }
  db.run(
    `INSERT INTO tends (pr, head, note, sender, at, state) VALUES (?, ?, ?, ?, ?, 'open')
     ON CONFLICT (pr) DO UPDATE SET head = excluded.head, note = excluded.note, sender = excluded.sender, at = excluded.at, session = NULL, given = NULL, answered = NULL, told = 0, state = 'open'`,
    [pr, head, note, sender, Date.now()],
  );
  log(`${pr} handed over by ${sender} on ${head.slice(0, 10)}${note ? `: ${note.slice(0, 200)}` : ""}`);
  return `the steward has ${pr}: it gives it an owner now`;
}

async function pass(): Promise<void> {
  if (kv("paused")) return;
  const state = await agentbox.state(false);
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const main = (await agentbox.self()).main;
  const known = await repos();

  // Its own scan: each open PR by `author` that needs work and has nobody on it is handed to it.
  const prs: typeof last.prs = [];
  if (discover) {
    for (const r of known) {
      const out = await gh(["pr", "list", "--repo", r.slug, "--author", cfg.author, "--state", "open", "--limit", "100", "--json", FIELDS]);
      for (const p of JSON.parse(out) as Omit<Pr, "repo">[]) {
        const pr = { ...p, repo: r.slug };
        const ref = `${r.slug.toLowerCase()}#${p.number}`;
        const holder = (await agentbox.prWho(ref).catch(() => null))?.claim?.sessionId ?? null;
        const st = stateOf(pr);
        prs.push({ ...pr, ...st, owner: holder && live(byId.get(holder)) ? holder : null });
        const t = tendOf(ref);
        if (st.state === "needs-work" && !(holder && live(byId.get(holder))) && t?.state !== "open" && t?.state !== "owned" && t?.head !== p.headRefOid) tend(ref, p.headRefOid, st.why, "its scan");
      }
    }
  }
  last = { at: Date.now(), prs, error: null };

  const owners = () => tends("owned").filter((t) => live(byId.get(t.session ?? ""))).length;
  let started = 0;
  for (const t of tends("open", "owned")) {
    let pr: Pr;
    try {
      pr = await view(t.pr);
    } catch (e) {
      log(`could not read ${t.pr}: ${(e as Error).message}`);
      continue;
    }
    if (pr.state && pr.state.toUpperCase() !== "OPEN") {
      db.run("UPDATE tends SET state = 'closed' WHERE pr = ?", [t.pr]);
      log(`${t.pr} is ${pr.state.toLowerCase()}: nothing more to do`);
      continue;
    }
    if (t.state === "open") {
      if (started < cfg.owners.perPass && owners() + started < cfg.owners.running && (await giveOwner(t, pr, byId, main, known))) started++;
    } else await follow(t, pr, byId);
  }

  // What its owners asked: one item per question, said to the main conversation once.
  for (const t of tends("owned")) {
    const s = byId.get(t.session ?? "");
    const ask = s && s.status !== "running" ? said(s.lastMessage) : null;
    if (ask?.kind === "needs") item(`question:${s!.id}:${s!.lastActivityAt}`, `${s!.id} (${t.pr}) asks: ${ask.what.slice(0, 400)}`, s!.id);
  }
  await tellMain(main, byId);
}

/** What an owner is told when a PR comes to it. */
function handoff(t: Tend, pr: Pr): string {
  return [
    `${pr.url} ("${pr.title}") was handed to the steward to take to ready, by ${t.sender}, on head ${t.head.slice(0, 10)}.`,
    t.note ? `What it needs:\n${t.note}` : "No findings came with it: find what keeps it from ready (checks, review threads, conflicts) and fix that.",
    `When it is green and clean on a head and you have verified that yourself, end your turn with \`STATUS: ready <that SHA>\`. When only a person can decide something, end it with \`STATUS: needs <who> — <the question and your recommendation>\`.`,
  ].join("\n\n");
}

/** The session that holds the PR, else a new one: true when one was started. */
async function giveOwner(t: Tend, pr: Pr, byId: Map<string, Session>, main: string | null, known: { slug: string; id: string | null }[]): Promise<boolean> {
  const holder = (await agentbox.prWho(t.pr).catch(() => null))?.claim?.sessionId ?? null;
  const given = Date.now();
  if (holder && live(byId.get(holder))) {
    try {
      await agentbox.send(holder, `[steward] You hold ${t.pr}, so it stays yours; the steward follows it from now on.\n\n${handoff(t, pr)}`, { wake: true });
      db.run("UPDATE tends SET state = 'owned', session = ?, given = ? WHERE pr = ?", [holder, given, t.pr]);
      log(`${t.pr}: its holder ${holder} has it`);
    } catch (e) {
      log(`could not tell ${holder} about ${t.pr}: ${(e as Error).message}`);
    }
    return false;
  }
  if (holder) return false; // held by a session that is not live: resumed, it has it; closed, the claim goes
  const template = readFileSync(join(import.meta.dir, cfg.owners.prompt), "utf8");
  const prompt = [["{{url}}", pr.url], ["{{title}}", pr.title], ["{{number}}", String(pr.number)], ["{{handoff}}", handoff(t, pr)]].reduce((p, [k, v]) => p.replaceAll(k!, () => v!), template);
  const repoId = known.find((r) => r.slug.toLowerCase() === pr.repo.toLowerCase())?.id;
  try {
    const s = await agentbox.start({ provider: cfg.owners.provider, prompt, claim: t.pr, ...(repoId ? { repoId, branch: pr.headRefName } : {}), ...(main ? { parent: main } : {}) });
    db.run("UPDATE tends SET state = 'owned', session = ?, given = ? WHERE pr = ?", [s.id, given, t.pr]);
    log(`started owner ${s.id} for ${t.pr}`);
    return true;
  } catch (e) {
    // Claimed by another session a moment ago, or no account has room: the next pass looks again.
    log(`could not start an owner for ${t.pr}: ${(e as Error).message}`);
    return false;
  }
}

/** An owned PR: told what came since, and ready once its owner's answer holds up on GitHub. */
async function follow(t: Tend, pr: Pr, byId: Map<string, Session>): Promise<void> {
  const s = byId.get(t.session ?? "");
  if (!live(s)) {
    db.run("UPDATE tends SET state = 'lost' WHERE pr = ?", [t.pr]);
    item(`lost:${t.pr}:${t.at}`, `${t.pr}: its owner ${t.session} stopped before it was ready. Resume it, or hand the PR over again with ${me.bin} agent call ${me.name} tend --set pr=${t.pr}`, t.session);
    return;
  }
  // Handed again while it worked: the new findings go to it.
  if (t.given === null) {
    try {
      await agentbox.send(s!.id, `[steward] ${t.pr} came back to you.\n\n${handoff(t, pr)}`, { wake: true });
      db.run("UPDATE tends SET given = ? WHERE pr = ?", [Date.now(), t.pr]);
    } catch (e) {
      log(`could not tell ${s!.id} about ${t.pr}: ${(e as Error).message}`);
    }
    return;
  }
  // Only a reply to the hand-off counts, each read once.
  if (s!.status === "running" || s!.lastPromptAt < t.given || s!.lastActivityAt <= s!.lastPromptAt || t.answered === s!.lastActivityAt) return;
  const answer = said(s!.lastMessage);
  if (answer.kind !== "ready") return;
  const head = pr.headRefOid.toLowerCase();
  const st = stateOf(pr);
  if (head.startsWith(answer.head) && st.state === "pending") return; // read again when its checks end
  db.run("UPDATE tends SET answered = ? WHERE pr = ?", [s!.lastActivityAt, t.pr]);
  if (head.startsWith(answer.head) && st.state === "ready") {
    db.run("UPDATE tends SET state = 'ready', head = ? WHERE pr = ?", [head, t.pr]);
    item(`ready:${t.pr}:${head}`, `${t.pr} is ready on ${head.slice(0, 10)} (${s!.id})`, s!.id);
    log(`${t.pr} is ready on ${head.slice(0, 10)}`);
    return;
  }
  const shows = head.startsWith(answer.head) ? `${st.state}: ${st.why}` : `its head as ${head.slice(0, 10)}, not ${answer.head.slice(0, 10)}`;
  if (t.told < 1) {
    db.run("UPDATE tends SET told = told + 1 WHERE pr = ?", [t.pr]);
    await agentbox
      .send(s!.id, `[steward] GitHub shows ${pr.url} with ${shows}. Take it to green and clean on its head, then end with \`STATUS: ready <SHA>\`.`, { wake: true })
      .catch((e) => log(`could not tell ${s!.id}: ${(e as Error).message}`));
  } else item(`stuck:${t.pr}:${head}`, `${t.pr}: ${s!.id} says ready again, but GitHub shows ${shows}`, s!.id);
}

/** New items go to the main conversation in one message; a main that is working hears it at its next pass. */
async function tellMain(main: string | null, byId: Map<string, Session>): Promise<void> {
  const fresh = db.query("SELECT key, line FROM items WHERE done_at IS NULL AND told IS NULL ORDER BY at").all() as { key: string; line: string }[];
  if (!fresh.length) return;
  const text = `[steward] ${fresh.length} item${fresh.length === 1 ? "" : "s"} to judge:\n${fresh.map((i) => `- ${i.key}: ${i.line}`).join("\n")}`;
  try {
    if (main) {
      if (byId.get(main)?.status === "running") return;
      await agentbox.send(main, text, { wake: true });
    } else {
      await call("POST", `/api/agents/${me.name}/chat`, { text, sendId: crypto.randomUUID() });
    }
    db.run(`UPDATE items SET told = ? WHERE key IN (${fresh.map(() => "?").join(",")})`, [Date.now(), ...fresh.map((i) => i.key)]);
  } catch (e) {
    log(`could not tell the main conversation: ${(e as Error).message}`);
  }
}

const run = () =>
  pass().catch((e) => {
    last = { ...last, error: (e as Error).message };
    throw e;
  });
every(cfg.every * 1000, run);

serve({
  async action({ action, values, caller }) {
    switch (action) {
      case "tend": {
        const pr = prRef(values.pr);
        const head = typeof values.head === "string" && /^[0-9a-f]{7,40}$/i.test(values.head) ? values.head.toLowerCase() : (await view(pr)).headRefOid.toLowerCase();
        const note = typeof values.note === "string" && values.note.trim() ? values.note.trim() : null;
        const message = tend(pr, head, note, caller.session ?? "a person");
        void run().catch((e) => log(`pass failed: ${(e as Error).message}`));
        return { message };
      }
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
    const handed = tends("open", "owned", "lost", "ready").slice(-50);
    const tabs = [
      { id: "prs", title: "Pull requests", badge: tends("open", "lost").length },
      { id: "inbox", title: "Inbox", badge: open.length },
      { id: "log", title: "Log" },
    ];
    const paused = kv("paused");
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
        {
          type: "fields",
          items: [
            { label: "Repositories", value: (cfg.repos.length ? cfg.repos : ["every registered GitHub repository"]).join(", ") },
            { label: "Takes", value: discover ? `what is handed to it, and every open PR by ${cfg.author} that needs work` : "only what is handed to it" },
            { label: "Last pass", value: last.at ? new Date(last.at).toLocaleTimeString() : "not yet" },
            { label: "State", value: paused ? "paused" : last.error ? `failing: ${md(last.error)}` : "running" },
          ],
        },
        { type: "actions", actions: [paused ? { id: "resume", label: "Resume", style: "primary" } : { id: "pause", label: "Pause" }] },
        ...(handed.length
          ? [
              { type: "heading", text: `Handed to it (${handed.length})` } as AgentBlock,
              ...handed.map(
                (t): AgentBlock => ({
                  type: "item",
                  status: t.state === "ready" ? "ok" : t.state === "lost" ? "warn" : t.state === "owned" ? "busy" : "idle",
                  title: `${t.pr} ${t.state}`,
                  subtitle: `from ${t.sender} on ${t.head.slice(0, 10)}`,
                  ...(t.note ? { body: md(t.note.slice(0, 2000)) } : {}),
                  sessions: t.session ? [t.session] : [],
                  links: [{ label: "Pull request", url: `https://github.com/${t.pr.replace("#", "/pull/")}` }],
                }),
              ),
            ]
          : [{ type: "markdown", text: `Nothing handed to it. Hand it a PR with \`${me.bin} agent call ${me.name} tend --set pr=<owner/name#N> --set note=<findings>\`.` } as AgentBlock]),
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
console.log(`steward ${me.name}: every ${cfg.every}s over ${cfg.repos.join(", ") || "every registered GitHub repository"}${discover ? "" : ", only what it is handed"}`);
