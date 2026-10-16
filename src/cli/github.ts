/** `agentbox github …` (src/core/github/, docs/superagents.md "GitHub actions"):
 *  the host owner pins a superagent's GitHub policy and approves its actions;
 *  a superagent's session requests and reads. The request id is first on
 *  every action line. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Api } from "../client";
import type { GitHubActionView } from "../core/github/actions";
import type { Pin } from "../core/github/policy";
import { parseArgs } from "./sessions";

export const GITHUB_USAGE = `agentbox github policy <superagent>          what its manifest proposes, what is pinned, and whether they match
agentbox github pin <superagent> [--key <pem>]   pin what it proposes now (a person, from their own terminal);
                                             --key: the App's private key, absolute, mode 0600 (needed the first time)
agentbox github unpin <superagent>           its GitHub actions stop
agentbox github actions [<request>] [--json] the actions superagents requested, or one (read again from GitHub when uncertain)
agentbox github approve|decline <request>    a prepared action: approve sends it once
agentbox github request <file|-> [--request <uuid>]   from a superagent's session: {action, claim?, cwd?}
agentbox github read <owner/repo> <n> issue|pull|reviews|checks   from a superagent's session, as its App`;

type PolicyView = { superagent: string; proposed: { policy: unknown; digest: string } | null; proposalError: string | null; pinned: Pin | null; current: boolean };

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const path = (name: string) => `/api/github/policies/${encodeURIComponent(name)}`;

export async function github(api: Api, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const arg = (what: string): string => {
    const v = rest.find((a) => !a.startsWith("-"));
    if (!v) throw new Error(`github ${verb} needs ${what}`);
    return v;
  };
  switch (verb) {
    case "policy": {
      showPolicy(await api<PolicyView>("GET", path(arg("a superagent's name"))));
      return 0;
    }
    case "pin": {
      const { flags, rest: names } = parseArgs(rest, ["key"]);
      const name = names[0];
      if (!name) throw new Error("github pin needs a superagent's name");
      const seen = await api<PolicyView>("GET", path(name));
      if (!seen.proposed) throw new Error(seen.proposalError ?? `${name}'s superagent.json proposes no github policy`);
      const key = str(flags.get("key"));
      showPolicy(await api<PolicyView>("POST", path(name), { digest: seen.proposed.digest, ...(key ? { appKeyPath: resolve(key) } : {}) }));
      return 0;
    }
    case "unpin": {
      const name = arg("a superagent's name");
      await api("DELETE", path(name));
      console.log(`${name} unpinned: its GitHub actions are refused`);
      return 0;
    }
    case "actions": {
      const { flags, rest: ids } = parseArgs(rest, [], ["json"]);
      const out = ids[0] ? [await api<GitHubActionView>("GET", `/api/github/actions/${encodeURIComponent(ids[0])}`)] : await api<GitHubActionView[]>("GET", "/api/github/actions");
      if (flags.has("json")) console.log(JSON.stringify(ids[0] ? out[0] : out, null, 2));
      else for (const a of out) console.log(line(a));
      return 0;
    }
    case "approve":
    case "decline": {
      console.log(line(await api<GitHubActionView>("POST", `/api/github/actions/${encodeURIComponent(arg("a request id"))}/${verb}`)));
      return 0;
    }
    case "request": {
      const { flags, rest: files } = parseArgs(rest, ["request"]);
      const file = files[0];
      if (!file) throw new Error("github request needs a JSON file, or - for stdin");
      const body = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")) as Record<string, unknown>;
      const request = str(flags.get("request")) ?? (typeof body.request === "string" ? body.request : randomUUID());
      const out = await api<{ request: string; state: string; result: unknown; card?: number }>("POST", "/api/github/actions", { ...body, request });
      console.log(`${out.request} ${out.state}${out.card ? ` card ${out.card}` : ""}${out.result ? ` ${JSON.stringify(out.result)}` : ""}`);
      return 0;
    }
    case "read": {
      const [repo, n, kind] = rest;
      if (!repo || !n || !kind) throw new Error("github read needs <owner/repo> <number> issue|pull|reviews|checks");
      console.log(JSON.stringify(await api("POST", "/api/github/read", { repo, number: Number(n), kind }), null, 2));
      return 0;
    }
    case undefined:
    case "help":
      console.log(GITHUB_USAGE);
      return 0;
    default:
      throw new Error(`github takes policy, pin, unpin, actions, approve, decline, request or read: not "${verb}"`);
  }
}

function showPolicy(v: PolicyView): void {
  console.log(`${v.superagent}  ${v.current ? "pinned, current" : v.pinned ? "pinned, but the manifest changed: pin it again" : "not pinned"}`);
  if (v.proposalError) console.log(`  manifest: ${v.proposalError}`);
  if (v.proposed) console.log(`  proposed ${v.proposed.digest.slice(0, 12)}:\n${JSON.stringify(v.proposed.policy, null, 2).replace(/^/gm, "    ")}`);
  if (v.pinned) console.log(`  pinned ${v.pinned.digest.slice(0, 12)} on ${new Date(v.pinned.pinnedAt).toISOString()}, key ${v.pinned.appKeyPath}`);
}

function line(a: GitHubActionView): string {
  const r = a.result;
  const what = r?.url ?? r?.message ?? "";
  return `${a.request}  ${a.state}  ${a.superagent}  ${a.action.kind} ${a.action.repo}${"number" in a.action ? `#${a.action.number}` : ""}${a.card ? `  card ${a.card}` : ""}${r?.status ? `  ${r.status}` : ""}${what ? `  ${what}` : ""}`;
}
