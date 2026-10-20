/** The org, as this machine takes part in it (docs/org.md): its accounts kept
 *  in step with the store, its org sessions published as rows, messages to
 *  them delivered, and the org's skills pulled. Everything here calls out to
 *  the store; with it unreachable, org sessions already running go on and
 *  personal ones never notice. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getAccount } from "../db";
import type { Account, OrgSessionView, OrgStatus, Session } from "../types";
import { machineName, personName, readOrg } from "./config";
import { isOrgAccount, loginKey, storeKey, syncOrgAccounts } from "./accounts";
import { orgSkillsDir, syncOrgSkills } from "./skills";
import { storeAccounts, storeSessions, type OrgMessage, type OrgSessionRow, type StoreAccount } from "./store";

/** A row unseen this long shows its session away. */
export const AWAY_MS = 3 * 60_000;
const ACCOUNTS_MS = 60_000;
const ROWS_MS = 15_000;
const INBOX_MS = 5_000;
const SKILLS_MS = 10 * 60_000;
/** How long `send` waits for the other machine to say what came of a message. */
const SEND_WAIT_MS = 30_000;

export interface OrgDeps {
  /** This machine's sessions. */
  sessions: () => readonly Session[];
  /** The PRs each of its sessions holds, `owner/repo#n`. */
  prsOf: (sessionId: string) => string[];
  /** Deliver a message from another machine, as an agent's: what came of it. */
  deliver: (to: string, from: string, text: string, wake: boolean) => Promise<{ to: string } | { refused: string }>;
  /** Something the board shows changed. */
  changed: () => void;
}

export class Org {
  private timers: ReturnType<typeof setInterval>[] = [];
  private reachedAt: number | null = null;
  private error: string | null = null;
  private others: OrgSessionView[] = [];
  private accounts: StoreAccount[] = [];

  constructor(private deps: OrgDeps) {}

  start(): void {
    const every = (ms: number, f: () => Promise<unknown>) => {
      const run = () => void f().catch((e: unknown) => this.failed(e));
      setTimeout(run, 2_000).unref?.();
      this.timers.push(setInterval(run, ms));
      this.timers.at(-1)!.unref?.();
    };
    every(ACCOUNTS_MS, () => this.syncAccounts());
    every(ROWS_MS, () => this.publish());
    every(INBOX_MS, () => this.takeInbox());
    every(SKILLS_MS, () => syncOrgSkills());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private failed(e: unknown): void {
    const msg = (e as Error).message ?? String(e);
    if (msg !== this.error) console.error(`agentbox: org: ${msg}`);
    this.error = msg;
  }

  private reached(): void {
    this.reachedAt = Date.now();
    this.error = null;
  }

  /** The org's accounts made to match the store here; at once after a share. */
  async syncAccounts(): Promise<void> {
    if (!readOrg()) return;
    const changed = await syncOrgAccounts();
    // A machine new to the org has its skills at once, not at the next pull.
    if (!existsSync(orgSkillsDir())) await syncOrgSkills();
    this.accounts = (await (await storeAccounts())?.find().toArray()) ?? [];
    this.reached();
    if (changed) this.deps.changed();
  }

  /** This machine's live org sessions. */
  private mine(): Session[] {
    return this.deps.sessions().filter((s) => s.status !== "closed" && !!s.accountId && isOrgAccount(getAccount(s.accountId) ?? { home: "" }));
  }

  /** Publish this machine's org sessions, forget the ones that ended, and
   *  read everyone else's. */
  private async publish(): Promise<void> {
    const col = await storeSessions();
    if (!col) {
      this.others = [];
      return;
    }
    const me = machineName();
    const person = personName();
    const now = new Date();
    const mine = this.mine();
    if (mine.length) {
      await col.bulkWrite(
        mine.map((s) => ({
          updateOne: {
            filter: { _id: s.id },
            update: {
              $set: {
                machine: me,
                person,
                provider: s.provider,
                title: s.title,
                repo: s.prRepo,
                branch: s.branch,
                status: s.status,
                accountId: s.accountId,
                prs: this.deps.prsOf(s.id),
                seenAt: now,
              },
              $setOnInsert: { inbox: [] },
            },
            upsert: true,
          },
        })),
      );
    }
    await col.deleteMany({ machine: me, _id: { $nin: mine.map((s) => s.id) } });
    const rows = await col.find({ machine: { $ne: me } }, { projection: { inbox: 0 } }).toArray();
    const labels = new Map(this.accounts.map((a) => [a._id, a.label]));
    const next = rows.map((r) => viewOf(r, labels, now.getTime())).sort((a, b) => b.seenAt - a.seenAt);
    this.reached();
    if (JSON.stringify(next) !== JSON.stringify(this.others)) {
      this.others = next;
      this.deps.changed();
    }
  }

  /** Messages for this machine's org sessions: each taken once, delivered as
   *  an agent's message is, and what came of it written back for the sender. */
  private async takeInbox(): Promise<void> {
    const col = await storeSessions();
    if (!col) return;
    const rows = await col.find({ machine: machineName(), "inbox.state": "new" }).toArray();
    for (const row of rows) {
      for (const m of row.inbox.filter((x) => x.state === "new")) {
        // Taken before it is typed: a crash in between loses it, never sends it twice.
        const took = await col.updateOne({ _id: row._id, inbox: { $elemMatch: { id: m.id, state: "new" } } }, { $set: { "inbox.$.state": "taken" } });
        if (!took.modifiedCount) continue;
        let out: { state: OrgMessage["state"]; why: string | null };
        try {
          const r = await this.deps.deliver(row._id, m.from.session ?? "", `[from ${m.from.person}'s session on ${m.from.machine}] ${m.text}`, m.wake);
          out = "refused" in r ? { state: "refused", why: r.refused } : { state: "delivered", why: null };
        } catch (e) {
          out = { state: "refused", why: (e as Error).message };
        }
        await col.updateOne({ _id: row._id, "inbox.id": m.id }, { $set: { "inbox.$.state": out.state, "inbox.$.why": out.why } });
      }
      // Answered messages a minute old are done with.
      await col.updateOne({ _id: row._id }, { $pull: { inbox: { state: { $in: ["delivered", "refused"] }, at: { $lt: new Date(Date.now() - 60_000) } } } });
    }
    this.reached();
  }

  /** Whether a session runs in the org (its account is the org's). */
  isOrgSession(id: string): boolean {
    return this.mine().some((s) => s.id === id);
  }

  /** The other machine's org session an id (or a unique prefix of one) names. */
  async find(id: string): Promise<OrgSessionRow | null> {
    const col = await storeSessions().catch((e: Error) => {
      throw new Error(`no session ${id} here, and the org's store cannot be reached to look there: ${e.message}`);
    });
    if (!col) return null;
    const rows = await col.find({ _id: { $regex: `^${id.replace(/[^\w-]/g, "")}` }, machine: { $ne: machineName() } }, { projection: { inbox: 0 } }).limit(2).toArray();
    return rows.length === 1 ? (rows[0] as OrgSessionRow) : null;
  }

  /** An org session's message to one on another machine: into its mailbox,
   *  then the other machine's answer, waited for. */
  async send(to: OrgSessionRow, from: string, text: string, wake: boolean): Promise<{ to: string } | { refused: string }> {
    const col = await storeSessions();
    if (!col) return { refused: "the org's store cannot be reached" };
    if (Date.now() - to.seenAt.getTime() > AWAY_MS) return { refused: `${to._id} is away: ${to.machine} was last heard from ${Math.round((Date.now() - to.seenAt.getTime()) / 60_000)}m ago` };
    const m: OrgMessage = { id: randomUUID(), from: { person: personName(), machine: machineName(), session: from }, text, wake, at: new Date(), state: "new", why: null };
    const put = await col.updateOne({ _id: to._id }, { $push: { inbox: m } });
    if (!put.matchedCount) return { refused: `${to._id} is no longer live` };
    const until = Date.now() + SEND_WAIT_MS;
    while (Date.now() < until) {
      await Bun.sleep(1_000);
      const row = await col.findOne({ _id: to._id }, { projection: { inbox: { $elemMatch: { id: m.id } } } });
      const got = row?.inbox?.[0];
      if (got?.state === "delivered") return { to: to._id };
      if (got?.state === "refused") return { refused: got.why ?? "refused" };
    }
    return { refused: `${to.machine} did not say within ${SEND_WAIT_MS / 1000}s whether it delivered the message; it may still` };
  }

  /** The live org session on another machine that holds a PR, if one does. */
  holderOf(pr: string): OrgSessionView | null {
    const key = pr.toLowerCase();
    return this.others.find((s) => !s.away && s.prs.some((p) => p.toLowerCase() === key)) ?? null;
  }

  /** Whether one of your accounts is shared with the org, as of the last sync. */
  shares(a: Pick<Account, "provider" | "email" | "home">): boolean {
    const key = !isOrgAccount(a) && readOrg() ? loginKey(a) : null;
    return !!key && this.accounts.some((d) => storeKey(d) === key);
  }

  status(): OrgStatus | null {
    const org = readOrg();
    if (!org) return null;
    return {
      name: org.name,
      machine: machineName(),
      person: personName(),
      skills: org.skills,
      reachedAt: this.reachedAt,
      error: this.error,
      accounts: this.accounts.map((a) => ({ id: a._id, provider: a.provider, label: a.label, problem: a.problem, refreshedAt: a.refreshedAt?.getTime() ?? null, addedBy: a.addedBy })),
      sessions: this.others,
    };
  }

  /** Other members' live org sessions, for the board. */
  sessions(): OrgSessionView[] {
    return readOrg() ? this.others : [];
  }
}

function viewOf(r: OrgSessionRow, labels: Map<string, string>, now: number): OrgSessionView {
  return {
    id: r._id,
    person: r.person,
    machine: r.machine,
    provider: r.provider,
    title: r.title,
    repo: r.repo,
    branch: r.branch,
    status: r.status,
    accountId: r.accountId,
    account: r.accountId ? (labels.get(r.accountId) ?? null) : null,
    prs: r.prs ?? [],
    seenAt: r.seenAt.getTime(),
    away: now - r.seenAt.getTime() > AWAY_MS,
  };
}
