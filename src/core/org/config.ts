/** This machine's org (docs/org.md): `<agentbox home>/org.json`, written by
 *  `agentbox org init` or `join`. Membership is the file: whoever has it has
 *  the store and the key, so it is 0600 and travels only as an invite. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { agentboxHome } from "../paths";
import { readUserIdentity } from "../user";

export interface OrgConfig {
  /** Its name, as the board shows it: "Plaibook". */
  name: string;
  /** The MongoDB URI of its store, with the database in its path. */
  store: string;
  /** The org key, base64: AES-256-GCM over every login at rest. */
  key: string;
  /** The GitHub repo of its skills, `owner/name`, or null. */
  skills: string | null;
}

export const orgConfigPath = (): string => join(agentboxHome(), "org.json");
/** Where the org's things live on this machine: its account homes and its skills. */
export const orgDir = (): string => join(agentboxHome(), "org");
export const orgAccountsRoot = (): string => join(orgDir(), "accounts");

let cached: { mtimeMs: number; org: OrgConfig | null } | null = null;

/** The org this machine is in, or null. Read again when the file changes. */
export function readOrg(): OrgConfig | null {
  const path = orgConfigPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cached = null;
    return null;
  }
  if (cached?.mtimeMs === mtimeMs) return cached.org;
  let org: OrgConfig | null = null;
  try {
    org = checkOrg(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    console.error(`agentbox: ${path}: ${(e as Error).message}`);
  }
  cached = { mtimeMs, org };
  return org;
}

export function writeOrg(org: OrgConfig): void {
  mkdirSync(agentboxHome(), { recursive: true });
  const path = orgConfigPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkOrg(org), null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const inOrg = (): boolean => existsSync(orgConfigPath()) && readOrg() !== null;

function checkOrg(v: unknown): OrgConfig {
  const o = v as Partial<OrgConfig> | null;
  if (!o || typeof o.name !== "string" || !o.name.trim()) throw new Error("an org has a name");
  if (typeof o.store !== "string" || !/^mongodb(\+srv)?:\/\/[^/]+\/[\w-]+/.test(o.store)) throw new Error("an org's store is a mongodb:// URI naming its database");
  if (typeof o.key !== "string" || Buffer.from(o.key, "base64").length !== 32) throw new Error("an org's key is 32 bytes, base64");
  if (o.skills != null && (typeof o.skills !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(o.skills))) throw new Error("an org's skills are a GitHub repo, owner/name");
  return { name: o.name.trim(), store: o.store, key: o.key, skills: o.skills ?? null };
}

const INVITE = "agentbox-org:";

/** What a member hands the next one: the whole of `org.json`. Treat it as a password. */
export const inviteOf = (org: OrgConfig): string => INVITE + Buffer.from(JSON.stringify(org)).toString("base64url");

export function parseInvite(s: string): OrgConfig {
  const t = s.trim();
  if (!t.startsWith(INVITE)) throw new Error(`an invite starts with ${INVITE}`);
  try {
    return checkOrg(JSON.parse(Buffer.from(t.slice(INVITE.length), "base64url").toString("utf8")));
  } catch (e) {
    throw new Error(`that invite cannot be read: ${(e as Error).message}`);
  }
}

/** This machine, as other members see it. */
export const machineName = (): string => `${userInfo().username}@${hostname().split(".")[0]}`;

/** The person this machine works for, as other members see them. */
export function personName(): string {
  const id = readUserIdentity();
  return id.name || id.email || userInfo().username;
}
