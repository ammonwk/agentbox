/** The hub's and the node's files (docs/hub.md, Configuration files).
 *
 * A machine is a hub when `<agentbox home>/hub/members.json` exists and a
 * node when `link.json` does; with neither, nothing in the hub code runs and
 * the machine is what docs/v2.md says. Each file is 0600 in a 0700 directory,
 * read again when it changes, and one that cannot be read counts as absent:
 * a broken file never admits more than no file would.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { agentboxHome } from "./paths";
import type { HubMember, Lend } from "./types";

export const hubDir = (): string => join(agentboxHome(), "hub");
const membersPath = (): string => join(hubDir(), "members.json");
const nodesPath = (): string => join(hubDir(), "nodes.json");
const linkPath = (): string => join(hubDir(), "link.json");
const auditPath = (): string => join(hubDir(), "audit.jsonl");

/** A node that asked to join, approved or not. */
export interface NodeRecord {
  id: string;
  name: string;
  ip: string;
  port: number;
  token: string;
  device: string | null;
  login: string | null;
  tags: string[];
  requestedAt: number;
  approvedAt: number | null;
  approvedBy: string | null;
}

/** A node's link to its hub. */
export interface Link {
  hub: { url: string; ip: string; name: string };
  name: string;
  token: string;
  joinedAt: number;
  lend: Lend;
}

export const DEFAULT_LEND: Lend = { maxSessions: null, accounts: "all", acceptStarts: false, shareHeadroom: true };

const LOGIN = /^[^\s@]+(@[^\s@]+)?$/;
const TOKEN = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A name fit for a badge and an id prefix: lowercase letters, digits, dashes. */
export function nodeName(raw: string): string {
  const n = raw.toLowerCase().replace(/\..*$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return n || "node";
}

export const newToken = (): string => randomBytes(32).toString("hex");

export function sameToken(a: string, b: string | null | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ------------------------------------------------------------- validation

export function parseMembers(v: unknown): HubMember[] {
  const list = (v as { members?: unknown })?.members;
  if (!Array.isArray(list)) throw new Error("members.json has no members list");
  const seen = new Set<string>();
  const members = list.map((m: Record<string, unknown>) => {
    const login = typeof m?.login === "string" ? m.login.trim().toLowerCase() : "";
    if (!LOGIN.test(login)) throw new Error(`not a tailnet login: ${JSON.stringify(m?.login)}`);
    if (seen.has(login)) throw new Error(`${login} is listed twice`);
    seen.add(login);
    if (m.role !== "owner" && m.role !== "member") throw new Error(`${login}'s role is neither owner nor member`);
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 80) : undefined;
    return { login, role: m.role, ...(name ? { name } : {}) } as HubMember;
  });
  if (members.filter((m) => m.role === "owner").length !== 1) throw new Error("a hub has exactly one owner");
  return members;
}

export function parseLend(v: unknown, base: Lend = DEFAULT_LEND): Lend {
  const o = (v ?? {}) as Record<string, unknown>;
  const out = { ...base };
  if (o.maxSessions !== undefined) {
    if (o.maxSessions !== null && !(Number.isInteger(o.maxSessions) && (o.maxSessions as number) >= 0)) throw new Error("maxSessions is a whole number, or null for no limit");
    out.maxSessions = o.maxSessions as number | null;
  }
  if (o.accounts !== undefined) {
    if (o.accounts !== "all" && !(Array.isArray(o.accounts) && o.accounts.every((a) => typeof a === "string" && /^[\w-]{1,64}$/.test(a)))) {
      throw new Error('accounts is "all" or a list of account ids');
    }
    out.accounts = o.accounts === "all" ? "all" : [...new Set(o.accounts as string[])];
  }
  if (o.acceptStarts !== undefined) {
    if (typeof o.acceptStarts !== "boolean") throw new Error("acceptStarts is true or false");
    out.acceptStarts = o.acceptStarts;
  }
  if (o.shareHeadroom !== undefined) {
    if (typeof o.shareHeadroom !== "boolean") throw new Error("shareHeadroom is true or false");
    out.shareHeadroom = o.shareHeadroom;
  }
  return out;
}

function parseNodes(v: unknown): NodeRecord[] {
  const list = (v as { nodes?: unknown })?.nodes;
  if (!Array.isArray(list)) throw new Error("nodes.json has no nodes list");
  return list.map((n: Record<string, unknown>) => {
    if (typeof n?.id !== "string" || typeof n.name !== "string" || !NAME.test(n.name)) throw new Error(`a node without a usable id or name: ${JSON.stringify(n?.name)}`);
    if (typeof n.ip !== "string" || !Number.isInteger(n.port) || typeof n.token !== "string" || !TOKEN.test(n.token)) throw new Error(`node ${n.name} has no usable address or token`);
    return {
      id: n.id,
      name: n.name,
      ip: n.ip,
      port: n.port as number,
      token: n.token,
      device: typeof n.device === "string" ? n.device : null,
      login: typeof n.login === "string" ? n.login : null,
      tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : [],
      requestedAt: Number(n.requestedAt) || 0,
      approvedAt: typeof n.approvedAt === "number" ? n.approvedAt : null,
      approvedBy: typeof n.approvedBy === "string" ? n.approvedBy : null,
    };
  });
}

function parseLink(v: unknown): Link {
  const o = v as Record<string, unknown>;
  const hub = o?.hub as Record<string, unknown> | undefined;
  if (!hub || typeof hub.url !== "string" || typeof hub.ip !== "string" || !hub.ip) throw new Error("link.json names no hub address");
  if (typeof o.token !== "string" || !TOKEN.test(o.token)) throw new Error("link.json has no usable token");
  if (typeof o.name !== "string" || !NAME.test(o.name)) throw new Error("link.json has no usable node name");
  return {
    hub: { url: hub.url, ip: hub.ip, name: typeof hub.name === "string" ? hub.name : hub.ip },
    name: o.name,
    token: o.token,
    joinedAt: Number(o.joinedAt) || 0,
    lend: parseLend(o.lend),
  };
}

// -------------------------------------------------------------- the files

/** One file, read again when its mtime moves. */
function cached<T>(path: () => string, parse: (v: unknown) => T) {
  let last: { path: string; mtime: number; value: T | null; error: string | null } | null = null;
  return (): { value: T | null; error: string | null } => {
    const p = path();
    let mtime = -1;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      /* absent */
    }
    if (last && last.path === p && last.mtime === mtime) return last;
    let value: T | null = null;
    let error: string | null = null;
    if (mtime >= 0) {
      try {
        value = parse(JSON.parse(readFileSync(p, "utf8")));
      } catch (e) {
        error = `${p}: ${(e as Error).message}`;
        console.error(`agentbox: hub: ${error} — treated as absent`);
      }
    }
    last = { path: p, mtime, value, error };
    return last;
  };
}

const membersFile = cached(membersPath, parseMembers);
const nodesFile = cached(nodesPath, parseNodes);
const linkFile = cached(linkPath, parseLink);

/** The hub's members, or null when this machine is not a hub. */
export const readMembers = (): HubMember[] | null => membersFile().value;
export const readNodes = (): NodeRecord[] => (readMembers() ? (nodesFile().value ?? []) : []);
/** This node's link, or null. A hub has none, whatever the file says. */
export const readLink = (): Link | null => (readMembers() ? null : linkFile().value);
export const hubFileError = (): string | null => membersFile().error ?? nodesFile().error ?? linkFile().error;

export function hubRole(): "none" | "hub" | "node" {
  if (readMembers()) return "hub";
  if (readLink()) return "node";
  return "none";
}

/** Written whole, 0600, through a rename so a reader never sees half. */
function writePrivate(path: string, value: unknown): void {
  mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  chmodSync(hubDir(), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writeMembers(members: HubMember[]): void {
  writePrivate(membersPath(), { members: parseMembers({ members }) });
}

export function writeNodes(nodes: NodeRecord[]): void {
  writePrivate(nodesPath(), { nodes });
}

export function writeLink(link: Link): void {
  writePrivate(linkPath(), link);
}

export function removeLink(): void {
  rmSync(linkPath(), { force: true });
}

export const linkExists = (): boolean => existsSync(linkPath());

/** One line per action a hub request took on this node. */
export function audit(entry: { person: unknown; method: string; path: string }): void {
  try {
    mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
    writeFileSync(auditPath(), JSON.stringify({ at: Date.now(), ...entry }) + "\n", { flag: "a", mode: 0o600 });
  } catch (e) {
    console.error(`agentbox: hub: could not write the audit line: ${(e as Error).message}`);
  }
}
