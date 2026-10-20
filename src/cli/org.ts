/** `agentbox org …` (docs/org.md): start or join an org, hand on its invite,
 *  move accounts in and out, and see the other members' org sessions. */

import { existsSync } from "node:fs";
import type { Api } from "../client";
import { inviteOf, orgConfigPath, parseInvite, readOrg, writeOrg, type OrgConfig } from "../core/org/config";
import { newOrgKey } from "../core/org/seal";
import { closeStore, storeDb } from "../core/org/store";
import type { AppState, OrgStatus } from "../core/types";
import { parseArgs } from "./sessions";

export const ORG_USAGE = `agentbox org [status]                        the org, its store and its accounts
agentbox org ls [--json]                     the other members' live org sessions
agentbox org init <name> --store <mongodb uri> [--skills owner/repo]
                                             start an org (its store's database in the URI's path); prints its invite
agentbox org join <invite>                   join the org an invite is for
agentbox org default org|personal            where a session starts when it does not say (--org, --personal) and has no parent
agentbox org invite                          the invite for the next member: it is the org's store and key, send it privately
agentbox org add-account <account>           move an account's login into the org: every copy of it on this machine is logged out
agentbox org take-account <account>          move an org account's login back onto this machine, as your own`;

async function reach(org: OrgConfig): Promise<void> {
  try {
    await (await storeDb())!.command({ ping: 1 });
  } catch (e) {
    throw new Error(`${org.name}'s store cannot be reached: ${(e as Error).message}`);
  } finally {
    await closeStore();
  }
}

function ago(ms: number | null): string {
  if (ms === null) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 120 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export async function orgCommand(api: Api, ensureServer: () => Promise<void>, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const { flags, rest: words } = parseArgs(rest, ["store", "skills"], ["json"]);
  switch (verb) {
    case "init": {
      if (readOrg()) throw new Error(`this machine is already in ${readOrg()!.name} (${orgConfigPath()})`);
      const name = words.join(" ").trim();
      const store = flags.get("store");
      if (!name || typeof store !== "string") throw new Error("org init <name> --store <mongodb uri>");
      const skills = typeof flags.get("skills") === "string" ? (flags.get("skills") as string) : null;
      const org: OrgConfig = { name, store, key: newOrgKey(), skills };
      writeOrg(org);
      try {
        await reach(org);
      } catch (e) {
        Bun.spawnSync(["rm", "-f", orgConfigPath()]);
        throw e;
      }
      console.log(`${name} started. Its invite, for each member (send it privately: it is the store and the key):\n\n${inviteOf(org)}`);
      return 0;
    }
    case "join": {
      const org = parseInvite(words[0] ?? "");
      const had = readOrg();
      if (had && had.name !== org.name) throw new Error(`this machine is in ${had.name}; it is in one org at a time`);
      writeOrg(org);
      await reach(org);
      await ensureServer();
      console.log(`joined ${org.name}. Start a session in it with --org, or make that the default: agentbox org default org`);
      return 0;
    }
    case "default": {
      const scope = words[0];
      if (scope !== "org" && scope !== "personal") throw new Error("org default org|personal");
      await ensureServer();
      await api("PUT", "/api/settings", { scope });
      console.log(`sessions start ${scope === "org" ? `in ${readOrg()?.name ?? "the org"}` : "on your own accounts"} unless they say otherwise`);
      return 0;
    }
    case "invite": {
      const org = readOrg();
      if (!org) throw new Error(existsSync(orgConfigPath()) ? `${orgConfigPath()} cannot be read` : "this machine is in no org");
      console.log(inviteOf(org));
      return 0;
    }
    case "add-account":
    case "take-account": {
      await ensureServer();
      const want = words[0];
      if (!want) throw new Error(`org ${verb} <account>`);
      const state = await api<AppState>("GET", "/api/state");
      const match = state.accounts.filter((a) => a.id === want || a.label === want || a.email === want);
      if (match.length !== 1) throw new Error(match.length ? `${want} is ${match.length} accounts here: name it by id` : `no account ${want}`);
      const a = match[0]!;
      if (verb === "add-account") {
        const r = await api<{ id: string; label: string; loggedOut: string[] }>("POST", "/api/org/accounts", { accountId: a.id });
        console.log(`${r.label} is the org's now (${r.id}). Logged out here: ${r.loggedOut.join(", ")}.`);
      } else {
        const r = await api<{ id: string; label: string }>("DELETE", `/api/org/accounts/${encodeURIComponent(a.id)}`);
        console.log(`${r.label} is yours again, on this machine (${r.id}).`);
      }
      return 0;
    }
    case "ls":
    case undefined:
    case "status": {
      await ensureServer();
      const s = await api<OrgStatus | null>("GET", "/api/org");
      if (!s) {
        console.log("this machine is in no org: agentbox org join <invite>");
        return 1;
      }
      if (flags.has("json")) {
        console.log(JSON.stringify(verb === "ls" ? s.sessions : s, null, 2));
        return 0;
      }
      if (verb !== "ls") {
        console.log(`${s.name}: ${s.person} on ${s.machine}; the store answered ${ago(s.reachedAt)}${s.error ? ` (since then: ${s.error})` : ""}`);
        if (s.skills) console.log(`skills: github.com/${s.skills}`);
        for (const a of s.accounts) console.log(`  ${a.provider.padEnd(6)} ${a.label.padEnd(30)} ${a.problem ?? `refreshed ${ago(a.refreshedAt)}`}  (from ${a.addedBy})`);
        if (!s.accounts.length) console.log("  no accounts yet: agentbox org add-account <account>");
        console.log("");
      }
      for (const x of s.sessions) {
        console.log([x.id, x.status.padEnd(8), (x.away ? "away" : "").padEnd(4), x.provider.padEnd(6), `${x.person} on ${x.machine}`.padEnd(30), `${x.repo ?? ""}${x.branch ? `@${x.branch}` : ""}`.slice(0, 40).padEnd(40), x.title.replace(/\s+/g, " ").slice(0, 80)].join("  "));
      }
      if (!s.sessions.length) console.log("no org sessions on other machines");
      return 0;
    }
    default:
      throw new Error(`unknown org command "${verb}"\n${ORG_USAGE}`);
  }
}
