/**
 * Who has a piece of work: claims keyed by a source (an issue's link, a
 * deployment environment), for any superagent program or session to take.
 * Core names no agent and knows no kind of work: a key is a canonical source,
 * and the rules below are the whole service.
 *
 * - One holder per (scope, key). A claim of several sources takes all of them
 *   or none, in one transaction.
 * - The fence is an integer that grows on every change of holder: the claim,
 *   an attach of a session, a takeover, a handover. Every later change must
 *   give the current fence; a stale one is refused, so a holder that was
 *   replaced cannot act as if it still held the key.
 * - Core renews the lease while the holder session runs, on the scheduler's
 *   tick; a program never renews. A lease past its end makes the claim
 *   `uncertain`, and an uncertain claim still excludes everyone else: expiry
 *   never frees work. Nothing knows that a session without a heartbeat
 *   stopped its writes.
 * - Only `release` by the holder, with the current fence, frees a key, and
 *   only a takeover or a handover moves it.
 * - A takeover stops the holder session itself, then proves the stop (no
 *   process and no pane), and only then moves the key. A caller cannot
 *   submit that proof. When the stop cannot be proven, the claim stays
 *   `takeover_requested` and the old holder still excludes.
 *
 * The state is in box.db (`LocalClaims`). A superagent that is a shared team
 * instance keeps its claims in the cloud instead: the same calls go to
 * another `ClaimsBackend` (`WorkClaims.backendOf`).
 */
import { getDb } from "./db";
import type { Session } from "./types";

export type ClaimScope = "work" | "env";
export type ClaimState = "active" | "uncertain" | "takeover_requested" | "released";
/** Who holds a claim: a superagent's program, the session doing the work, or both. Both null: a person. */
export type ClaimHolder = { superagent: string | null; session: string | null };
export type WorkClaim = {
  key: string;
  /** The link it was claimed by, canonical: what a page shows. */
  source: string;
  scope: ClaimScope;
  fence: number;
  leaseUntil: number;
  state: ClaimState;
  holder: ClaimHolder;
  note: string | null;
};
export type ClaimFilter = { superagent?: string; session?: string; key?: string; scope?: ClaimScope; released?: boolean };

/** How long a lease runs past its last renewal: six scheduler ticks. */
export const LEASE_MS = 90_000;
const MAX_SOURCES = 50;
const MAX_NOTE = 2_000;

/** A refusal with its status; a conflict names the key, its holder and its state. */
export class ClaimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: { key: string; holder: ClaimHolder; state: ClaimState } | null = null,
  ) {
    super(message);
  }
}

/**
 * One key for one thing. GitHub issues and pull requests share one number
 * space, so host casing, repository casing, fragments, query strings and
 * /issues against /pull make no second key; another http(s) link is its link
 * without a fragment and with its query sorted. `env:<repo>:<environment>` is
 * a deployment environment, case-insensitive. `owner/repo#12` is the issue's
 * link. Any other `scheme:id` is its own key, as given.
 */
export function canonicalSource(raw: string): { key: string; source: string } {
  const t = raw.trim();
  if (!t || t.length > 2048) throw new ClaimError(400, "a source is a link or a key of at most 2048 characters");
  const env = /^env:([^:\s]+):(\S+)$/i.exec(t);
  if (env) {
    const key = `env:${env[1]!.toLowerCase()}:${env[2]!.toLowerCase()}`;
    return { key, source: key };
  }
  const short = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(t);
  if (short) return github(short[1]!, short[2]!);
  if (/^https?:/i.test(t)) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw new ClaimError(400, `${t} is not a link`);
    }
    if (u.username || u.password) throw new ClaimError(400, "use a source link without credentials");
    const gh = u.hostname.toLowerCase() === "github.com" && /^\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/([1-9]\d*)\/?$/.exec(u.pathname);
    if (gh) return github(`${gh[1]}/${gh[2]}`, gh[3]!);
    u.hash = "";
    u.searchParams.sort();
    return { key: u.href, source: u.href };
  }
  // `github:owner/repo#n` is the key itself: made canonical like the rest.
  const gk = /^github:([\w.-]+\/[\w.-]+)#([1-9]\d*)$/i.exec(t);
  if (gk) return github(gk[1]!, gk[2]!);
  // A scheme is one key whatever its case: `GitHub:x` is `github:x`.
  const scheme = /^([a-z][a-z0-9+.-]*):(\S+)$/i.exec(t);
  if (scheme) return { key: `${scheme[1]!.toLowerCase()}:${scheme[2]}`, source: t };
  throw new ClaimError(400, `${t} is not a source: give a link, owner/repo#number, env:<repo>:<environment>, or scheme:id`);
}

function github(repo: string, number: string) {
  const r = repo.toLowerCase();
  return { key: `github:${r}#${number}`, source: `https://github.com/${r}/issues/${number}` };
}

/**
 * Where claims are kept. Every method is async so that a cloud backend can
 * satisfy it; each one checks the fence it is given against the one it
 * holds, in the same step as the change.
 */
export interface ClaimsBackend {
  get(scope: ClaimScope, key: string, now: number): Promise<WorkClaim | null>;
  list(filter: ClaimFilter, now: number): Promise<WorkClaim[]>;
  /** Every key or none. A held key is refused whoever holds it, the asker too: a program that lost the answer reads its claims back with `list`. */
  claim(items: readonly { key: string; source: string }[], scope: ClaimScope, holder: ClaimHolder, note: string | null, now: number): Promise<WorkClaim[]>;
  /** The session doing the work: fence + 1, lease from now. */
  attach(scope: ClaimScope, key: string, fence: number, session: string, now: number): Promise<WorkClaim>;
  release(scope: ClaimScope, key: string, fence: number, now: number): Promise<WorkClaim>;
  /** Marks it `takeover_requested`; the holder and the fence stay. */
  requestTakeover(scope: ClaimScope, key: string, fence: number, by: ClaimHolder, now: number): Promise<WorkClaim>;
  /** After core proved the old holder stopped: fence + 1, the new holder. */
  completeTakeover(scope: ClaimScope, key: string, fence: number, holder: ClaimHolder, now: number): Promise<WorkClaim>;
  /** Leases of claims held by the `live` sessions run on; any other active lease past its end is uncertain. */
  renew(live: ReadonlySet<string>, now: number): Promise<void>;
  /** What `from` holds goes to `to`, each with fence + 1. */
  handOver(from: string, to: string, now: number): Promise<number>;
}

type Row = {
  scope: ClaimScope;
  key: string;
  source: string;
  fence: number;
  state: ClaimState;
  superagent: string | null;
  session: string | null;
  note: string | null;
  lease_until: number;
};

const toClaim = (r: Row, now: number): WorkClaim => ({
  key: r.key,
  source: r.source,
  scope: r.scope,
  fence: r.fence,
  leaseUntil: r.lease_until,
  // Read as uncertain the moment its lease ends, before a tick writes it.
  state: r.state === "active" && r.lease_until < now ? "uncertain" : r.state,
  holder: { superagent: r.superagent, session: r.session },
  note: r.note,
});

const conflict = (c: WorkClaim) =>
  new ClaimError(
    409,
    `${c.key} is held by ${c.holder.superagent ?? "a person"}${c.holder.session ? ` (session ${c.holder.session})` : ""}, ${c.state}`,
    { key: c.key, holder: c.holder, state: c.state },
  );

/** This machine's claims, in box.db. Each method is one synchronous transaction in the server's single writer. */
export class LocalClaims implements ClaimsBackend {
  private row(scope: ClaimScope, key: string): Row | null {
    return getDb().query("SELECT * FROM work_claims WHERE scope = ? AND key = ?").get(scope, key) as Row | null;
  }

  private event(r: Pick<Row, "scope" | "key" | "fence" | "superagent" | "session" | "note">, kind: string, now: number): void {
    getDb().run("INSERT INTO work_claim_events (scope, key, kind, fence, superagent, session, note, at) VALUES (?,?,?,?,?,?,?,?)", [r.scope, r.key, kind, r.fence, r.superagent, r.session, r.note, now]);
  }

  /** The claim as it is now, if `fence` is still its fence and it is not released. */
  private current(scope: ClaimScope, key: string, fence: number, now: number): Row {
    const r = this.row(scope, key);
    if (!r || r.state === "released") throw new ClaimError(404, `nobody holds ${key}`);
    if (r.fence !== fence) throw new ClaimError(409, `stale fence for ${key}: ${fence}, and it is ${r.fence} now; its holder changed`, { key, holder: { superagent: r.superagent, session: r.session }, state: toClaim(r, now).state });
    return r;
  }

  async get(scope: ClaimScope, key: string, now: number): Promise<WorkClaim | null> {
    const r = this.row(scope, key);
    return r ? toClaim(r, now) : null;
  }

  async list(f: ClaimFilter, now: number): Promise<WorkClaim[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (!f.released) where.push("state != 'released'");
    for (const [col, v] of [["superagent", f.superagent], ["session", f.session], ["key", f.key], ["scope", f.scope]] as const) {
      if (v !== undefined) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    }
    const rows = getDb().query(`SELECT * FROM work_claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY claimed_at, key`).all(...args) as Row[];
    return rows.map((r) => toClaim(r, now));
  }

  async claim(items: readonly { key: string; source: string }[], scope: ClaimScope, holder: ClaimHolder, note: string | null, now: number): Promise<WorkClaim[]> {
    const db = getDb();
    return db.transaction(() => {
      const out: WorkClaim[] = [];
      for (const { key, source } of items) {
        const old = this.row(scope, key);
        if (old && old.state !== "released") throw conflict(toClaim(old, now));
        const r: Row = { scope, key, source, fence: (old?.fence ?? 0) + 1, state: "active", superagent: holder.superagent, session: holder.session, note, lease_until: now + LEASE_MS };
        db.run(
          `INSERT INTO work_claims (scope, key, source, fence, state, superagent, session, note, lease_until, claimed_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(scope, key) DO UPDATE SET source = excluded.source, fence = excluded.fence, state = excluded.state,
             superagent = excluded.superagent, session = excluded.session, note = excluded.note,
             lease_until = excluded.lease_until, claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`,
          [scope, key, source, r.fence, r.state, r.superagent, r.session, note, r.lease_until, now, now],
        );
        this.event(r, "claim", now);
        out.push(toClaim(r, now));
      }
      return out;
    })();
  }

  async attach(scope: ClaimScope, key: string, fence: number, session: string, now: number): Promise<WorkClaim> {
    const db = getDb();
    return db.transaction(() => {
      const r = this.current(scope, key, fence, now);
      if (r.state === "takeover_requested") throw new ClaimError(409, `${key} is being taken over`, { key, holder: { superagent: r.superagent, session: r.session }, state: r.state });
      const next: Row = { ...r, fence: r.fence + 1, session, state: "active", lease_until: now + LEASE_MS };
      db.run("UPDATE work_claims SET fence = ?, session = ?, state = 'active', lease_until = ?, updated_at = ? WHERE scope = ? AND key = ?", [next.fence, session, next.lease_until, now, scope, key]);
      this.event(next, "attach", now);
      return toClaim(next, now);
    })();
  }

  async release(scope: ClaimScope, key: string, fence: number, now: number): Promise<WorkClaim> {
    const db = getDb();
    return db.transaction(() => {
      const r = this.current(scope, key, fence, now);
      db.run("UPDATE work_claims SET state = 'released', updated_at = ? WHERE scope = ? AND key = ?", [now, scope, key]);
      this.event(r, "release", now);
      return toClaim({ ...r, state: "released" }, now);
    })();
  }

  async requestTakeover(scope: ClaimScope, key: string, fence: number, by: ClaimHolder, now: number): Promise<WorkClaim> {
    const db = getDb();
    return db.transaction(() => {
      const r = this.current(scope, key, fence, now);
      if (r.state !== "takeover_requested") {
        db.run("UPDATE work_claims SET state = 'takeover_requested', updated_at = ? WHERE scope = ? AND key = ?", [now, scope, key]);
        this.event({ ...r, superagent: by.superagent, session: by.session }, "takeover_requested", now);
      }
      return toClaim({ ...r, state: "takeover_requested" }, now);
    })();
  }

  async completeTakeover(scope: ClaimScope, key: string, fence: number, holder: ClaimHolder, now: number): Promise<WorkClaim> {
    const db = getDb();
    return db.transaction(() => {
      const r = this.current(scope, key, fence, now);
      if (r.state !== "takeover_requested") throw new ClaimError(409, `no takeover of ${key} was requested`);
      const next: Row = { ...r, fence: r.fence + 1, state: "active", superagent: holder.superagent, session: holder.session, lease_until: now + LEASE_MS };
      db.run("UPDATE work_claims SET fence = ?, state = 'active', superagent = ?, session = ?, lease_until = ?, updated_at = ? WHERE scope = ? AND key = ?", [next.fence, holder.superagent, holder.session, next.lease_until, now, scope, key]);
      this.event(next, "takeover", now);
      return toClaim(next, now);
    })();
  }

  async renew(live: ReadonlySet<string>, now: number): Promise<void> {
    const db = getDb();
    db.transaction(() => {
      const rows = db.query("SELECT * FROM work_claims WHERE state IN ('active', 'uncertain')").all() as Row[];
      for (const r of rows) {
        if (r.session && live.has(r.session)) {
          db.run("UPDATE work_claims SET state = 'active', lease_until = ? WHERE scope = ? AND key = ?", [now + LEASE_MS, r.scope, r.key]);
          if (r.state === "uncertain") this.event(r, "active", now);
        } else if (r.state === "active" && r.lease_until < now) {
          db.run("UPDATE work_claims SET state = 'uncertain', updated_at = ? WHERE scope = ? AND key = ?", [now, r.scope, r.key]);
          this.event(r, "uncertain", now);
        }
      }
    })();
  }

  async handOver(from: string, to: string, now: number): Promise<number> {
    const db = getDb();
    return db.transaction(() => {
      const rows = db.query("SELECT * FROM work_claims WHERE session = ? AND state != 'released'").all(from) as Row[];
      for (const r of rows) {
        // A takeover in flight is for the session that held it; the successor holds it from here.
        const state = r.state === "takeover_requested" ? "active" : r.state;
        db.run("UPDATE work_claims SET fence = fence + 1, session = ?, state = ?, lease_until = ?, updated_at = ? WHERE scope = ? AND key = ?", [to, state, now + LEASE_MS, now, r.scope, r.key]);
        this.event({ ...r, fence: r.fence + 1, session: to }, "handover", now);
      }
      return rows.length;
    })();
  }
}

/** What the takeover needs of the fleet: `Fleet` itself, or a test's stand-in. */
export interface SessionControl {
  sessions(): readonly Session[];
  stopSession(id: string): Promise<void>;
  tick(): Promise<void>;
}

/** A process or a pane of it runs. The opposite is the proof a takeover waits for. */
const runs = (s: Session | undefined): boolean => !!s && (s.host !== "none" || !!s.pid);

/** Who asks: a program by its token, a session by its capability, or neither (a person on this machine). */
export type ClaimCaller = { superagent: string | null; session: string | null };

/** The holder itself: its superagent, its session, or a person for a person's claim. */
function isHolder(c: ClaimCaller, h: ClaimHolder): boolean {
  if (c.superagent) return c.superagent === h.superagent;
  if (c.session) return c.session === h.session;
  return h.superagent === null && h.session === null;
}

/** The claims service: who may do what, the stop and its proof, and the lease tick. The backends keep the state. */
/** The keys a session holds in box.db, now: for checks that must not wait
 *  (the daily sweep's, inside a close). Released ones are not held. */
export function localClaimsOf(session: string): string[] {
  return (getDb().query("SELECT key FROM work_claims WHERE session = ? AND state != 'released' ORDER BY key").all(session) as { key: string }[]).map((r) => r.key);
}

/** The scope a key is claimed in: an environment lock or a work item. */
export const scopeOfKey = (key: string): ClaimScope => (key.startsWith("env:") ? "env" : "work");

export class WorkClaims {
  readonly backends: ClaimsBackend[];
  /** Where a superagent's claims are kept: box.db, unless it is a shared team instance. */
  backendOf: (superagent: string | null) => ClaimsBackend;
  /** The superagent a session acts for (`Superagents.ownerOf` with authority), so a
   *  session's claims are kept where its superagent's are. */
  ownerOf: (session: string) => string | null = () => null;

  constructor(
    private readonly fleet: SessionControl,
    readonly local: ClaimsBackend = new LocalClaims(),
  ) {
    this.backends = [local];
    this.backendOf = () => local;
  }

  private session(id: string): Session | undefined {
    return this.fleet.sessions().find((s) => s.id === id);
  }

  private known(id: string): void {
    if (!this.session(id)) throw new ClaimError(404, `no session ${id}`);
  }

  private async held(caller: ClaimCaller, scope: ClaimScope, source: string, now: number): Promise<{ backend: ClaimsBackend; claim: WorkClaim }> {
    const { key } = canonicalSource(source);
    const first = this.backendFor(caller);
    // Its own backend first; then the others, for a claim made before it was
    // shared or after it was unshared, which stays where it was made.
    for (const backend of [first, ...this.backends.filter((b) => b !== first)]) {
      const claim = await backend.get(scope, key, now);
      if (claim && claim.state !== "released") return { backend, claim };
    }
    throw new ClaimError(404, `nobody holds ${key}`);
  }

  private queue: Promise<unknown> = Promise.resolve();
  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Where the caller's claims go: its superagent's backend, a session's by the superagent it acts for. */
  private backendFor(caller: ClaimCaller): ClaimsBackend {
    return this.backendOf(caller.superagent ?? (caller.session ? this.ownerOf(caller.session) : null));
  }

  async claim(caller: ClaimCaller, req: { sources: readonly string[]; scope?: ClaimScope; session?: string | null; note?: string | null }, now = Date.now()): Promise<WorkClaim[]> {
    if (!req.sources.length || req.sources.length > MAX_SOURCES) throw new ClaimError(400, `give 1 to ${MAX_SOURCES} sources`);
    const items = [...new Map(req.sources.map((s) => canonicalSource(s)).map((c) => [c.key, c])).values()];
    // The scope is the key's: an environment is always `env`, everything else `work`,
    // so one key can never be held twice under two scopes.
    const scopes = new Set(items.map((i) => scopeOfKey(i.key)));
    if (scopes.size > 1) throw new ClaimError(400, "claim environments (env:…) and work items in separate calls");
    const scope = [...scopes][0]!;
    if (req.scope && req.scope !== scope) throw new ClaimError(400, `${items[0]!.key} is claimed in scope ${scope}, not ${req.scope}`);
    let session = req.session ?? null;
    if (caller.session) {
      if (session && session !== caller.session) throw new ClaimError(403, "a session claims for itself");
      session = caller.session;
    } else if (session) this.known(session);
    const note = req.note?.trim().slice(0, MAX_NOTE) || null;
    // One holder for each key across every backend: a key held in box.db is not
    // claimed again in the cloud, nor the other way. Claims run one at a time
    // here, so the look and the claim are one step on this machine.
    const target = this.backendFor(caller);
    // A session's claim names the superagent it acts for, so the cloud keeps it for that one.
    const holder = { superagent: caller.superagent ?? (caller.session ? this.ownerOf(caller.session) : null), session };
    return this.serially(async () => {
      for (const other of this.backends.filter((b) => b !== target))
        for (const i of items) {
          const held = await other.get(scope, i.key, now);
          if (held && held.state !== "released") throw new ClaimError(409, `${i.key} is held (${held.holder.superagent ?? held.holder.session ?? "a person"})`, { key: i.key, holder: held.holder, state: held.state });
        }
      return target.claim(items, scope, holder, note, now);
    });
  }

  /** The session that does the work, once the program has started it. The one before must have stopped: a running one is replaced by a handover or a takeover. */
  async attach(caller: ClaimCaller, req: { key: string; scope?: ClaimScope; fence: number; session: string }, now = Date.now()): Promise<WorkClaim> {
    const { backend, claim } = await this.held(caller, req.scope ?? scopeOfKey(canonicalSource(req.key).key), req.key, now);
    if (!isHolder(caller, claim.holder)) throw new ClaimError(403, `only the holder of ${claim.key} attaches a session to it`);
    this.known(req.session);
    const old = claim.holder.session;
    if (old && old !== req.session && runs(this.session(old)))
      throw new ClaimError(409, `${claim.key} is held by session ${old}, which still runs: hand it over or take it over`, { key: claim.key, holder: claim.holder, state: claim.state });
    return backend.attach(claim.scope, claim.key, req.fence, req.session, now);
  }

  async release(caller: ClaimCaller, req: { key: string; scope?: ClaimScope; fence: number }, now = Date.now()): Promise<WorkClaim> {
    const { backend, claim } = await this.held(caller, req.scope ?? scopeOfKey(canonicalSource(req.key).key), req.key, now);
    if (!isHolder(caller, claim.holder)) throw new ClaimError(403, `only the holder of ${claim.key} releases it`);
    return backend.release(claim.scope, claim.key, req.fence, now);
  }

  /**
   * Stop the holder session, prove it stopped, then move the key to `to`
   * (or to the holder's superagent alone). A person or the holder's own
   * superagent asks; a session hands over instead. Asked again, it stops
   * and checks again.
   */
  async takeover(caller: ClaimCaller, req: { key: string; scope?: ClaimScope; to?: string | null }, now = Date.now()): Promise<WorkClaim> {
    const { backend, claim } = await this.held(caller, req.scope ?? scopeOfKey(canonicalSource(req.key).key), req.key, now);
    if (caller.session && !caller.superagent) throw new ClaimError(403, "a session hands its work over (POST /api/sessions/:id/handover); a takeover is a person's or the holder's program's");
    if (caller.superagent && caller.superagent !== claim.holder.superagent) throw new ClaimError(403, `${claim.key} is not ${caller.superagent}'s to take over`);
    const to = req.to ?? null;
    if (to) this.known(to);
    const old = claim.holder.session;
    if (to && to === old) throw new ClaimError(400, `session ${to} already holds ${claim.key}`);
    const asked = await backend.requestTakeover(claim.scope, claim.key, claim.fence, caller, now);
    if (old && runs(this.session(old))) {
      try {
        await this.fleet.stopSession(old);
      } catch {
        /* refused (a subagent's, paused for cleanup): the proof below fails */
      }
      await this.fleet.tick();
    }
    if (old && runs(this.session(old)))
      throw new ClaimError(409, `session ${old} could not be proven stopped: ${claim.key} stays with it, takeover_requested; ask again once it has stopped`, { key: claim.key, holder: claim.holder, state: "takeover_requested" });
    return backend.completeTakeover(claim.scope, claim.key, asked.fence, { superagent: claim.holder.superagent, session: to }, now);
  }

  async list(f: ClaimFilter, now = Date.now()): Promise<WorkClaim[]> {
    const key = f.key === undefined ? undefined : canonicalSource(f.key).key;
    // A backend that cannot answer (the cloud, offline) leaves the others' claims readable.
    const all = await Promise.allSettled(this.backends.map((b) => b.list({ ...f, key }, now)));
    for (const r of all) if (r.status === "rejected") console.error("agentbox: claims: a backend did not answer:", (r.reason as Error).message);
    return all.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  /** A handover's part (`Fleet.handOver`): `from`'s claims go to `to`. */
  async handOver(from: string, to: string, now = Date.now()): Promise<number> {
    let moved = 0;
    // Each backend on its own: one that fails (the cloud, offline) does not stop
    // the others or the rest of the handover; its claims stay with `from`, and
    // the lease tick reports them.
    for (const b of this.backends) {
      try {
        moved += await b.handOver(from, to, now);
      } catch (e) {
        console.error(`agentbox: claims: ${from}'s claims in one backend did not move to ${to}:`, (e as Error).message);
      }
    }
    return moved;
  }

  /** The scheduler's tick: renew the leases of claims whose session runs. */
  async tick(now = Date.now()): Promise<void> {
    const live = new Set(this.fleet.sessions().filter(runs).map((s) => s.id));
    for (const b of this.backends) await b.renew(live, now);
  }
}
