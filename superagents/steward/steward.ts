/**
 * Steward: every `every` seconds, one pass over the pull requests it looks
 * after and the sessions it has on them. A session that ends on `STATUS:
 * needs …` becomes an item for the steward's main conversation, which judges.
 *
 * Which pull requests: with `discover` (the default), every open one by
 * `author` in its repositories, and one that needs work and has nobody on it
 * gets an owner session. With `discover: false`, only those handed to it
 * with the `pr.tend` event (`agentbox pr tend`): it gives each one owner,
 * the session that already holds it when there is one, else a fresh one, and
 * the owner hands it to the project's judge with `agentbox pr ready` once it
 * has verified it ready. It never looks for work of its own then.
 *
 * The pass holds nothing between runs but its store, so a restart picks up
 * where it was, and every start is keyed so it never happens twice.
 */
import type { Database } from "bun:sqlite";
import { ActionError, AgentboxError, md, type Caller, type SuperagentBlock, type SuperagentView } from "../lib/sdk";
import type { Repo, Session } from "../../src/core/types";

export type Config = {
  repos: string[];
  author: string;
  every: number;
  /** False: only pull requests handed to it (`pr.tend`); no scan of its own. */
  discover?: boolean;
  owners: { provider: string; running: number; perPass: number; prompt: string };
};

/** What the steward needs from agentbox: the SDK in main.ts, a fake in its tests. */
export type Box = {
  state(): Promise<{ sessions: Session[]; repos: Repo[] }>;
  prWho(pr: string): Promise<{ claim: { sessionId: string } | null } | null>;
  start(spec: { provider: string; prompt: string; claim: string; repoId?: string; branch?: string; parent?: string }): Promise<{ id: string }>;
  send(id: string, text: string, opts: { wake?: boolean }): Promise<unknown>;
  main(): Promise<string | null>;
  /** Into its main conversation as a message, starting one when it has none. */
  chat(text: string): Promise<unknown>;
};
export type Gh = (args: string[]) => Promise<string>;
/** Who it is: `me` from the SDK. `template` reads the owner prompt (its directory's, else this code's). */
export type Me = { name: string; title: string; project: string | null; bin: string; template: (file: string) => string };

type Check = { conclusion?: string | null; state?: string | null; status?: string | null; name?: string; context?: string };
export type Pr = {
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
  /** OPEN, CLOSED or MERGED: `gh pr view` says; `gh pr list --state open` lists only open ones. */
  state?: string;
};
export type State = "draft" | "needs-work" | "pending" | "ready";
type Seen = Pr & { state: State; why: string; owner: string | null };

/** A pull request handed to it, one row per hand-off (PR, head and sender). */
type Tend = { key: string; pr: string; repo: string; number: number; head: string; sender: string; from: string | null; note: string | null; at: number; session: string | null; how: string | null; given: number | null; state: TendState };
/** open: no owner yet; owned: an owner has it; ready: its owner verified it ready; closed: merged, closed or superseded; lost: its owner stopped first. */
type TendState = "open" | "owned" | "ready" | "closed" | "lost";

const FIELDS = "number,title,url,headRefName,headRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup";
const live = (s: Session | undefined) => !!s && s.status !== "closed" && s.status !== "stopped";

export function stateOf(pr: Pr): { state: State; why: string } {
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

/** The line an owner ends its turn with: what it says it is. */
export function statusOf(text: string | null): { kind: "needs"; what: string } | { kind: "ready"; head: string } | { kind: "done" } | null {
  const t = text ?? "";
  const needs = /STATUS:\s*needs\s+(.+)/i.exec(t);
  if (needs) return { kind: "needs", what: needs[1]! };
  const ready = /STATUS:\s*ready\s+([0-9a-f]{7,40})\b/i.exec(t);
  if (ready) return { kind: "ready", head: ready[1]!.toLowerCase() };
  return /STATUS:\s*done\b/i.test(t) ? { kind: "done" } : null;
}

export class Steward {
  last: { at: number; prs: Seen[]; error: string | null } = { at: 0, prs: [], error: null };
  private running = false;
  private again = false;

  constructor(
    readonly db: Database,
    readonly cfg: Config,
    readonly box: Box,
    readonly gh: Gh,
    readonly me: Me,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS started (key TEXT PRIMARY KEY, session TEXT NOT NULL, pr TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, line TEXT NOT NULL, session TEXT, at INTEGER NOT NULL, told INTEGER, done_at INTEGER, note TEXT);
      CREATE TABLE IF NOT EXISTS log (at INTEGER NOT NULL, what TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tends (key TEXT PRIMARY KEY, pr TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, sender TEXT NOT NULL,
        "from" TEXT, note TEXT, at INTEGER NOT NULL, session TEXT, how TEXT, given INTEGER, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nudges (key TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  }

  get discover(): boolean {
    return this.cfg.discover !== false;
  }

  log(what: string) {
    this.db.run("INSERT INTO log VALUES (?, ?)", [Date.now(), what]);
  }
  kv(k: string): string | null {
    return (this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
  }
  setKv(k: string, v: string | null) {
    if (v === null) this.db.run("DELETE FROM kv WHERE k = ?", [k]);
    else this.db.run("INSERT OR REPLACE INTO kv VALUES (?, ?)", [k, v]);
  }
  tends(states: TendState[]): Tend[] {
    return this.db.query(`SELECT * FROM tends WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY at`).all(...states) as Tend[];
  }

  /** Its repositories: the manifest's, else its project's when it is an instance in one, else every registered one. */
  repos(registered: Repo[]): { slug: string; id: string | null }[] {
    const own = this.me.project ? registered.find((r) => r.id === this.me.project) : undefined;
    const slugs = this.cfg.repos.length ? this.cfg.repos : this.me.project ? [own?.fullName].filter((x): x is string => !!x) : registered.map((r) => r.fullName).filter((x): x is string => !!x);
    // Its own project first: two projects can be checkouts of one repository.
    const idOf = (slug: string) => (own?.fullName?.toLowerCase() === slug.toLowerCase() ? own.id : (registered.find((r) => r.fullName?.toLowerCase() === slug.toLowerCase())?.id ?? null));
    return [...new Set(slugs)].map((slug) => ({ slug, id: idOf(slug) }));
  }
  get everywhere(): string {
    return this.me.project ? "its project's repository" : "every registered GitHub repository";
  }

  /** One pass, never two at once: a pass asked for meanwhile runs right after. */
  async pass(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
      this.last.error = null;
    } catch (e) {
      this.last = { ...this.last, error: (e as Error).message };
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async once(): Promise<void> {
    if (this.kv("paused")) return;
    const state = await this.box.state();
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    const main = await this.box.main();
    const repos = this.repos(state.repos);
    const prs: Seen[] = [];

    if (this.discover) {
      for (const r of repos) {
        const out = await this.gh(["pr", "list", "--repo", r.slug, "--author", this.cfg.author, "--state", "open", "--limit", "100", "--json", FIELDS]);
        for (const p of JSON.parse(out) as Omit<Pr, "repo">[]) {
          const pr = { ...p, repo: r.slug };
          const who = await this.box.prWho(`${r.slug}#${p.number}`).catch(() => null);
          prs.push({ ...pr, ...stateOf(pr), owner: who?.claim?.sessionId ?? null });
        }
      }
    }
    await this.tendAll(byId, main, repos, prs);
    this.last = { at: Date.now(), prs, error: null };

    if (this.discover) await this.ownNeedsWork(byId, main, repos, prs);

    // What its sessions asked: one item per question, said to the main conversation once.
    for (const r of this.db.query("SELECT session, pr FROM started").all() as { session: string; pr: string | null }[]) {
      const s = byId.get(r.session);
      if (!s || s.status === "running") continue;
      const st = statusOf(s.lastMessage);
      if (st?.kind !== "needs") continue;
      this.item(`question:${s.id}:${s.lastActivityAt}`, `${s.id}${r.pr ? ` (${r.pr})` : ""} asks: ${st.what.slice(0, 400)}`, s.id);
    }
    await this.tellMain(main, byId);
  }

  private item(key: string, line: string, session: string | null) {
    this.db.run("INSERT OR IGNORE INTO items (key, line, session, at) VALUES (?, ?, ?, ?)", [key, line, session, Date.now()]);
  }

  /** Live sessions it started (not those it adopted): what the `running` dial counts. */
  private runningOwners(byId: Map<string, Session>): number {
    return (this.db.query("SELECT session FROM started WHERE key NOT LIKE 'adopt:%'").all() as { session: string }[]).filter((r) => live(byId.get(r.session))).length;
  }

  private ownerPrompt(pr: Pr, why: string, handoff: string): string {
    return this.me
      .template(this.cfg.owners.prompt)
      .replaceAll("{{url}}", pr.url)
      .replaceAll("{{title}}", pr.title)
      .replaceAll("{{number}}", String(pr.number))
      .replaceAll("{{why}}", why)
      .replaceAll("{{handoff}}", handoff)
      .replace(/\n{3,}/g, "\n\n");
  }

  /** Owners for what needs work and has nobody, a few a pass, up to the dial. */
  private async ownNeedsWork(byId: Map<string, Session>, main: string | null, repos: { slug: string; id: string | null }[], prs: Seen[]): Promise<void> {
    let room = Math.min(this.cfg.owners.perPass, this.cfg.owners.running - this.runningOwners(byId));
    for (const pr of prs) {
      if (room <= 0) break;
      if (pr.state !== "needs-work" || pr.owner) continue;
      const key = `owner:${pr.repo}#${pr.number}:${pr.headRefOid.slice(0, 10)}`;
      if (this.db.query("SELECT 1 FROM started WHERE key = ?").get(key)) continue;
      const repoId = repos.find((r) => r.slug === pr.repo)?.id;
      try {
        const s = await this.box.start({
          provider: this.cfg.owners.provider,
          prompt: this.ownerPrompt(pr, pr.why, ""),
          claim: `${pr.repo}#${pr.number}`,
          ...(repoId ? { repoId, branch: pr.headRefName } : {}),
          ...(main ? { parent: main } : {}),
        });
        this.db.run("INSERT INTO started VALUES (?, ?, ?, ?)", [key, s.id, `${pr.repo}#${pr.number}`, Date.now()]);
        this.log(`started owner ${s.id} for ${pr.repo}#${pr.number}: ${pr.why}`);
        room--;
      } catch (e) {
        // Another session took it a moment ago, or no account has room: next pass looks again.
        this.log(`could not start an owner for ${pr.repo}#${pr.number}: ${(e as Error).message}`);
        if (!(e instanceof AgentboxError) || e.status !== 409) break;
      }
    }
  }

  // ---- pull requests handed to it (the pr.tend event)

  /** Take one hand-off: kept in the store first, given an owner by the next pass. */
  tend(values: Record<string, unknown>, caller: Caller): { message: string; key: string; already: boolean } {
    const repo = String(values.repo ?? "");
    const number = Number(values.number);
    const head = String(values.head ?? "").toLowerCase();
    const note = typeof values.note === "string" && values.note.trim() ? values.note.trim() : null;
    const from = typeof values.from === "string" && values.from ? values.from : (caller.session ?? null);
    const agent = typeof values.agent === "string" && values.agent ? values.agent : null;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) throw new ActionError("pr.tend needs {repo: owner/name, number}");
    if (!/^[0-9a-f]{7,40}$/.test(head)) throw new ActionError("pr.tend needs the PR's head commit as head");
    const pr = `${repo}#${number}`;
    // Its repositories only: the event is routed by project, a direct call is not.
    // The manifest's are known here; its project's, when it has no list, the pass checks.
    if (this.cfg.repos.length && !this.cfg.repos.some((r) => r.toLowerCase() === repo.toLowerCase()))
      throw new ActionError(`${this.me.title} looks after ${this.cfg.repos.join(", ")}, not ${repo}`, 403);
    const sender = agent ?? from ?? "person";
    const key = `pr.tend:${pr.toLowerCase()}@${head}:${sender}`;
    const fresh = this.db.run(`INSERT OR IGNORE INTO tends (key, pr, repo, number, head, sender, "from", note, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`, [key, pr, repo, number, head, sender, from, note, Date.now()]).changes === 1;
    if (!fresh) return { message: `${this.me.title} already has ${pr} on ${head.slice(0, 10)} from ${sender}`, key, already: true };
    // A newer hand-off of the same PR is the one that counts.
    this.db.run("UPDATE tends SET state = 'closed' WHERE pr = ? COLLATE NOCASE AND key != ? AND state IN ('open', 'owned', 'ready', 'lost')", [pr, key]);
    this.log(`${pr} handed over on ${head.slice(0, 10)} by ${sender}${note ? `: ${note.slice(0, 200)}` : ""}`);
    return { message: `${this.me.title} has ${pr} on ${head.slice(0, 10)}: it gives it an owner now`, key, already: false };
  }

  /** The session of its own on a PR: a live one it started or adopted, the latest first. */
  private ownOwner(pr: string, byId: Map<string, Session>): string | null {
    const rows = this.db.query("SELECT session FROM started WHERE pr = ? COLLATE NOCASE ORDER BY at DESC").all(pr) as { session: string }[];
    return rows.find((r) => live(byId.get(r.session)))?.session ?? null;
  }

  private nudgeOnce(key: string): boolean {
    return this.db.run("INSERT OR IGNORE INTO nudges VALUES (?, ?)", [key, Date.now()]).changes === 1;
  }

  /** What an owner is told when a PR comes to it: the findings, and how to hand it on when it is ready. */
  handoffText(t: Tend, pr: Pr): string {
    const who = t.sender === "person" ? "the person" : t.from && t.sender !== t.from ? `${t.sender} (session ${t.from})` : t.sender;
    return [
      `It was handed to ${this.me.title} (${this.me.name}) to take to ready, by ${who}, on head ${t.head}.`,
      t.note ? `What it needs:\n${t.note}` : "No findings came with it: find what keeps it from ready (checks, review threads, conflicts) and fix that.",
      `When it is green and clean on a head and you have verified that yourself, run \`${this.me.bin} pr ready ${pr.repo}#${pr.number} --head <SHA>\` to hand it to the project's judge, then end your turn with \`STATUS: ready <SHA>\`. A judge can send it back with more findings; they come to you here.`,
    ].join("\n\n");
  }

  /** Give each open hand-off an owner, and follow each owned one to ready. */
  private async tendAll(byId: Map<string, Session>, main: string | null, repos: { slug: string; id: string | null }[], prs: Seen[]): Promise<void> {
    for (const t of this.tends(["open", "owned"])) {
      const repo = repos.find((r) => r.slug.toLowerCase() === t.repo.toLowerCase());
      if (!repo) {
        this.db.run("UPDATE tends SET state = 'closed' WHERE key = ?", [t.key]);
        this.log(`${t.pr} is not in ${this.cfg.repos.length ? this.cfg.repos.join(", ") : this.everywhere}: not taken`);
        continue;
      }
      let pr: Pr;
      try {
        pr = { ...(JSON.parse(await this.gh(["pr", "view", String(t.number), "--repo", t.repo, "--json", `${FIELDS},state`])) as Omit<Pr, "repo">), repo: t.repo };
      } catch (e) {
        this.log(`could not read ${t.pr}: ${(e as Error).message}`);
        continue;
      }
      if (pr.state && pr.state.toUpperCase() !== "OPEN") {
        this.db.run("UPDATE tends SET state = 'closed' WHERE key = ?", [t.key]);
        this.log(`${t.pr} is ${pr.state.toLowerCase()}: nothing more to do`);
        continue;
      }
      const st = stateOf(pr);
      if (!this.discover) prs.push({ ...pr, ...st, owner: t.session });
      if (t.state === "open") await this.giveOwner(t, pr, st, byId, main, repo.id);
      else await this.follow(t, pr, st, byId);
    }
  }

  private async giveOwner(t: Tend, pr: Pr, st: { state: State; why: string }, byId: Map<string, Session>, main: string | null, repoId: string | null): Promise<void> {
    const text = this.handoffText(t, pr);
    // An owner already: its own from an earlier hand-off, else the session that holds the PR (its context is kept).
    const mine = this.ownOwner(t.pr, byId);
    const holder = mine ? null : ((await this.box.prWho(t.pr).catch(() => null))?.claim?.sessionId ?? null);
    const existing = mine ?? (holder && live(byId.get(holder)) && holder !== t.from ? holder : null);
    if (existing) {
      // Recorded first: a send that fails is put back for the next pass.
      this.db.run("UPDATE tends SET state = 'owned', session = ?, how = ?, given = ? WHERE key = ?", [existing, mine ? "sent" : "adopted", Date.now(), t.key]);
      if (!mine) this.db.run("INSERT OR IGNORE INTO started VALUES (?, ?, ?, ?)", [`adopt:${t.pr}:${existing}`, existing, t.pr, Date.now()]);
      try {
        const lead = mine
          ? `[${this.me.title}] ${pr.url} ("${pr.title}") came back to you.`
          : `[${this.me.title}] You hold ${pr.url} ("${pr.title}"), so you keep it: ${this.me.title} follows it from now on. Keep the rules you already work under.`;
        await this.box.send(existing, `${lead}\n\n${text}\n\nWhen only a person can decide something, end your turn with \`STATUS: needs <who> — <the question and your recommendation>\`.`, { wake: true });
        this.log(`${t.pr}: ${mine ? "sent the findings to its owner" : "adopted its holder"} ${existing}`);
      } catch (e) {
        this.db.run("UPDATE tends SET state = 'open', session = NULL, how = NULL, given = NULL WHERE key = ?", [t.key]);
        this.log(`could not tell ${existing} about ${t.pr}: ${(e as Error).message}`);
      }
      return;
    }
    if (this.cfg.owners.running - this.runningOwners(byId) <= 0) {
      if (this.nudgeOnce(`room:${t.key}`)) this.log(`${t.pr} waits for room: ${this.cfg.owners.running} owners already run`);
      return;
    }
    const key = `tend:${t.key}`;
    if (this.db.query("SELECT 1 FROM started WHERE key = ?").get(key)) return;
    const given = Date.now();
    try {
      const s = await this.box.start({
        provider: this.cfg.owners.provider,
        prompt: this.ownerPrompt(pr, `it was handed on to be taken to ready; GitHub shows ${st.why}`, text),
        claim: t.pr,
        ...(repoId ? { repoId, branch: pr.headRefName } : {}),
        ...(main ? { parent: main } : {}),
      });
      this.db.run("INSERT INTO started VALUES (?, ?, ?, ?)", [key, s.id, t.pr, Date.now()]);
      this.db.run("UPDATE tends SET state = 'owned', session = ?, how = 'started', given = ? WHERE key = ?", [s.id, given, t.key]);
      this.log(`started owner ${s.id} for ${t.pr}`);
    } catch (e) {
      // Held by another session a moment ago, or no account has room: the next pass looks again.
      this.log(`could not start an owner for ${t.pr}: ${(e as Error).message}`);
    }
  }

  /** An owned hand-off: done when its owner says ready on the head GitHub shows ready; its owner told once when not. */
  private async follow(t: Tend, pr: Pr, st: { state: State; why: string }, byId: Map<string, Session>): Promise<void> {
    const s = t.session ? byId.get(t.session) : undefined;
    if (!live(s)) {
      this.db.run("UPDATE tends SET state = 'lost' WHERE key = ?", [t.key]);
      this.item(`lost:${t.key}`, `${t.pr}: its owner ${t.session} ${s ? s.status : "is gone"} before it was ready; hand it on again with ${this.me.bin} pr tend ${t.pr}, or resume ${t.session}`, t.session);
      return;
    }
    // Only an answer to the hand-off counts: a STATUS line from before it (an
    // adopted session's last turn, or the turn before findings came back) is
    // about another head. The hand-off is a prompt at or after `given`, and the
    // owner's reply comes after its last prompt.
    if (s!.status === "running" || s!.lastPromptAt < (t.given ?? 0) || s!.lastActivityAt <= s!.lastPromptAt) return;
    const said = statusOf(s!.lastMessage);
    if (!said || said.kind === "needs") return;
    const head = pr.headRefOid.toLowerCase();
    const nudge = async (text: string) => {
      if (!this.nudgeOnce(`said:${s!.id}:${s!.lastActivityAt}`)) return;
      await this.box.send(s!.id, `[${this.me.title}] ${text}`, { wake: true }).catch((e) => this.log(`could not tell ${s!.id}: ${(e as Error).message}`));
    };
    if (st.state !== "ready") return nudge(`You ended with STATUS: ${said.kind}, but GitHub shows ${pr.url} on ${head.slice(0, 10)} as ${st.state}: ${st.why}. Take it to green and clean, then run \`${this.me.bin} pr ready ${t.pr} --head <SHA>\` and end with \`STATUS: ready <SHA>\`.`);
    if (said.kind === "done" || !head.startsWith(said.head)) {
      return nudge(`GitHub shows ${pr.url} green and clean on ${head}. If you verified that head, run \`${this.me.bin} pr ready ${t.pr} --head ${head}\` (a second run of one head sends nothing) and end with \`STATUS: ready ${head}\`.`);
    }
    this.db.run("UPDATE tends SET state = 'ready' WHERE key = ?", [t.key]);
    this.log(`${t.pr} is ready on ${head.slice(0, 10)}: ${s!.id} handed it to the judge with pr ready`);
  }

  /** New items go to the main conversation in one message; a main that is working hears it at its next pass. */
  private async tellMain(main: string | null, byId: Map<string, Session>): Promise<void> {
    const fresh = this.db.query("SELECT key, line FROM items WHERE done_at IS NULL AND told IS NULL ORDER BY at").all() as { key: string; line: string }[];
    if (!fresh.length) return;
    const text = `[${this.me.name}] ${fresh.length} item${fresh.length === 1 ? "" : "s"} to judge:\n${fresh.map((i) => `- ${i.key}: ${i.line}`).join("\n")}`;
    try {
      if (main) {
        if (byId.get(main)?.status === "running") return;
        await this.box.send(main, text, { wake: true });
      } else {
        await this.box.chat(text);
      }
      this.db.run(`UPDATE items SET told = ? WHERE key IN (${fresh.map(() => "?").join(",")})`, [Date.now(), ...fresh.map((i) => i.key)]);
    } catch (e) {
      this.log(`could not tell the main conversation: ${(e as Error).message}`);
    }
  }

  // ---- its page and actions

  action({ action, values, caller }: { action: string; values: Record<string, unknown>; caller: Caller }): { message: string } {
    switch (action) {
      case "pr.tend": {
        const r = this.tend(values, caller);
        if (!r.already) void this.pass().catch((e) => this.log(`pass failed: ${(e as Error).message}`));
        return { message: r.message };
      }
      case "done": {
        const key = String(values.key ?? "");
        const n = this.db.run("UPDATE items SET done_at = ?, note = ? WHERE key = ? AND done_at IS NULL", [Date.now(), String(values.note ?? ""), key]).changes;
        if (!n) throw new ActionError(`no open item ${key}`, 404);
        this.log(`done ${key}: ${String(values.note ?? "")}`);
        return { message: "Done." };
      }
      case "pause":
        this.setKv("paused", String(Date.now()));
        this.log("paused");
        return { message: "Paused: no passes until you resume it." };
      case "resume":
        this.setKv("paused", null);
        this.log("resumed");
        return { message: "Resumed." };
      default:
        throw new ActionError(`${this.me.title} has no action ${action}`, 404);
    }
  }

  view(tab: string | null): SuperagentView {
    const open = this.db.query("SELECT key, line, session, at FROM items WHERE done_at IS NULL ORDER BY at").all() as { key: string; line: string; session: string | null; at: number }[];
    const tabs = [
      { id: "prs", title: "Pull requests", badge: this.last.prs.filter((p) => p.state === "needs-work" && !p.owner).length },
      { id: "inbox", title: "Inbox", badge: open.length },
      { id: "log", title: "Log" },
    ];
    const paused = this.kv("paused");
    const head: SuperagentBlock[] = [
      {
        type: "fields",
        items: [
          { label: "Repositories", value: (this.cfg.repos.length ? this.cfg.repos : [this.everywhere]).join(", ") },
          { label: "Takes", value: this.discover ? `every open PR by ${this.cfg.author}` : "only PRs handed to it (agentbox pr tend)" },
          { label: "Last pass", value: this.last.at ? new Date(this.last.at).toLocaleTimeString() : "not yet" },
          { label: "State", value: paused ? "paused" : this.last.error ? `failing: ${md(this.last.error)}` : "running" },
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
        blocks: [{ type: "markdown", text: (this.db.query("SELECT at, what FROM log ORDER BY at DESC LIMIT 80").all() as { at: number; what: string }[]).map((l) => `- ${new Date(l.at).toLocaleString()}: ${md(l.what)}`).join("\n") || "Nothing yet." }],
      };
    const handed = this.tends(["open", "owned", "ready", "lost"]);
    const order: State[] = ["needs-work", "pending", "ready", "draft"];
    return {
      tabs,
      refresh: 10,
      blocks: [
        ...head,
        ...(handed.length
          ? [
              { type: "heading", text: `Handed to ${this.me.title} (${handed.length})` } as SuperagentBlock,
              ...handed.map(
                (t): SuperagentBlock => ({
                  type: "item",
                  status: t.state === "ready" ? "ok" : t.state === "lost" ? "warn" : t.state === "owned" ? "busy" : "idle",
                  title: `${t.pr} ${t.state}`,
                  subtitle: `from ${t.sender} on ${t.head.slice(0, 10)}${t.how ? `, ${t.how}` : ""}`,
                  ...(t.note ? { body: md(t.note.slice(0, 2000)) } : {}),
                  sessions: t.session ? [t.session] : [],
                  links: [{ label: "Pull request", url: `https://github.com/${t.repo}/pull/${t.number}` }],
                }),
              ),
            ]
          : []),
        ...(this.discover
          ? order.flatMap((st) => {
              const these = this.last.prs.filter((p) => p.state === st);
              return these.length
                ? [
                    { type: "heading", text: `${st} (${these.length})` } as SuperagentBlock,
                    ...these.map(
                      (p): SuperagentBlock => ({
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
            })
          : handed.length
            ? []
            : [{ type: "markdown", text: `Nothing handed to it. Hand it a PR with \`${this.me.bin} pr tend <PR> --note-file <findings>\`.` } as SuperagentBlock]),
      ],
    };
  }
}
