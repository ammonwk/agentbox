/** The org's store (docs/org.md, The model): one MongoDB database every
 *  member's machine calls out to. Two collections: the org's accounts, and
 *  its live sessions with their mailboxes. */

import { MongoClient, type Collection, type Db } from "mongodb";
import type { AccountProvider, ClaimView, ProviderId } from "../types";
import { readOrg } from "./config";

/** An org account. Its id is its account id on every member's machine. */
export interface StoreAccount {
  _id: string;
  provider: AccountProvider;
  label: string;
  email: string | null;
  plan: string | null;
  /** The provider's own name for the login where an email holds several
   *  (omp: one OpenCode account in one workspace); null otherwise. */
  externalId?: string | null;
  /** The login, sealed with the org key (seal.ts); null while it needs logging in again. */
  login: string | null;
  /** Moves on every new login: machines rewrite their homes' files when it does. */
  version: number;
  /** When the provider last issued it. */
  refreshedAt: Date | null;
  /** The machine refreshing it now, and until when the others leave it be. */
  lease: { by: string; until: Date } | null;
  /** Why it needs logging in again, once a refresh was refused. */
  problem: string | null;
  addedBy: string;
  addedAt: Date;
}

/** A message for an org session from one on another machine. */
export interface OrgMessage {
  id: string;
  from: { person: string; machine: string; session: string | null };
  text: string;
  /** Whether waking a cold or stopped session is the point (`agentbox send --wake`). */
  wake: boolean;
  at: Date;
  /** `new` until the target's machine takes it; then what came of it. */
  state: "new" | "taken" | "delivered" | "refused";
  why: string | null;
}

/** A live org session, as its machine publishes it. */
export interface OrgSessionRow {
  _id: string;
  machine: string;
  person: string;
  provider: ProviderId;
  title: string;
  repo: string | null;
  branch: string | null;
  status: string;
  accountId: string | null;
  /** The PRs it holds: `owner/repo#n`. */
  prs: string[];
  /** What it still claims on its account, as its machine works it out. */
  claim?: ClaimView | null;
  seenAt: Date;
  inbox: OrgMessage[];
}

let client: { uri: string; c: MongoClient; db: Db } | null = null;

/** The store's database, connected on first use; null outside an org. */
export async function storeDb(): Promise<Db | null> {
  const org = readOrg();
  if (!org) {
    await closeStore();
    return null;
  }
  if (client?.uri === org.store) return client.db;
  await closeStore();
  const c = new MongoClient(org.store, { serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 8_000, appName: "agentbox" });
  await c.connect();
  const db = c.db();
  client = { uri: org.store, c, db };
  // A machine that dies takes its rows with it, a day later.
  await db.collection<OrgSessionRow>("sessions").createIndex({ seenAt: 1 }, { expireAfterSeconds: 86_400 }).catch(() => undefined);
  return db;
}

export async function closeStore(): Promise<void> {
  const c = client;
  client = null;
  await c?.c.close().catch(() => undefined);
}

export async function storeAccounts(): Promise<Collection<StoreAccount> | null> {
  return (await storeDb())?.collection<StoreAccount>("accounts") ?? null;
}

export async function storeSessions(): Promise<Collection<OrgSessionRow> | null> {
  return (await storeDb())?.collection<OrgSessionRow>("sessions") ?? null;
}
