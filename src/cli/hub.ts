/** `agentbox hub …` (docs/hub.md): make this machine a hub, join one, lend,
 *  approve and leave. Each runs on loopback, so as this machine's owner. */

import type { Api } from "../client";
import type { HubMember, HubNodeView, HubStatus, Lend } from "../core/types";
import { parseArgs } from "./sessions";

export const HUB_USAGE = `agentbox hub [status]                        this machine's part in a hub: none, the hub (members, nodes) or a node (its link)
agentbox hub init [--owner <login>]          make this machine a hub, owned by <login> (default: its own tailnet login)
agentbox hub join <hub> [--name n] [--no-wait]
                                             join the hub at <hub> (tailnet name, IP or URL); waits for its owner to approve
agentbox hub leave [<node>]                  on a node: end its link; on the hub: remove <node>
agentbox hub approve <node>                  on the hub: let <node> join
agentbox hub member add <login> [--owner] [--name n] | rm <login>
agentbox hub lend [--max <n|none>] [--accounts <id,id|all>] [--starts on|off] [--headroom on|off]
                                             on a node: what the hub may use`;

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const ago = (t: number | null): string => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : "never");

function lendLine(l: Lend): string {
  return `lends ${l.accounts === "all" ? "every account" : l.accounts.join(", ") || "no account"}; starts ${l.acceptStarts ? "on" : "off"}${l.maxSessions === null ? "" : `, at most ${l.maxSessions}`}; headroom ${l.shareHeadroom ? "shared" : "kept"}`;
}

function nodeLine(n: HubNodeView): string {
  const state = n.approvedAt === null ? "waiting for approval" : n.reachable ? `reachable, ${n.sessions} sessions` : `away (last seen ${ago(n.lastSeen)}${n.error ? `: ${n.error}` : ""})`;
  return `${n.id}\t${n.name}\t${n.url} (${n.ip})\t${n.login ?? (n.tags.join(",") || "-")}\t${state}`;
}

function print(s: HubStatus): void {
  if (s.error) console.error(`agentbox: ${s.error}`);
  if (s.role === "none") {
    console.log("not a hub and not joined to one (agentbox hub init, or agentbox hub join <hub>)");
    return;
  }
  if (s.role === "hub") {
    console.log(`hub${s.self ? ` ${s.self.name} (${s.self.url ?? s.self.ip})` : " (not on a tailnet yet)"}`);
    for (const m of s.members ?? []) console.log(`member\t${m.login}\t${m.role}${m.name ? `\t${m.name}` : ""}`);
    for (const n of s.nodes ?? []) console.log(`node\t${nodeLine(n)}`);
    return;
  }
  const l = s.link!;
  console.log(`node ${l.name} of hub ${l.hub.name} (${l.hub.url}, ${l.hub.ip}); joined ${new Date(l.joinedAt).toLocaleString()}`);
  console.log(l.lastHubAt ? `the hub last asked ${ago(l.lastHubAt)}` : "the hub has not asked anything since this server started (approved yet?)");
  console.log(lendLine(l.lend));
}

export async function hub(api: Api, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const { flags: f, rest: positional } = parseArgs(rest, ["owner", "name", "max", "accounts", "starts", "headroom"], ["no-wait"]);
  const flags = Object.fromEntries(f) as Record<string, string | true | undefined>;
  switch (verb) {
    case undefined:
    case "status":
      print(await api<HubStatus>("GET", "/api/hub"));
      return 0;
    case "init":
      print(await api<HubStatus>("POST", "/api/hub/init", { owner: str(flags.owner) }));
      return 0;
    case "join": {
      const address = positional[0];
      if (!address) throw new Error("hub join needs the hub's address: its tailnet name, IP or URL");
      const s = await api<HubStatus>("POST", "/api/hub/link", { hub: address, name: str(flags.name) });
      console.log(`asked ${s.link!.hub.name} to let ${s.link!.name} join; its owner approves it on Team › Nodes (or \`agentbox hub approve ${s.link!.name}\` there)`);
      if (flags["no-wait"]) return 0;
      console.log("waiting for the hub's first request (Ctrl-C stops waiting; the request stands)…");
      for (;;) {
        await Bun.sleep(2_000);
        const now = await api<HubStatus>("GET", "/api/hub");
        if (now.role !== "node") {
          console.log("the link is gone: the hub removed this node, or it left");
          return 1;
        }
        if (now.link?.lastHubAt) {
          console.log(`approved: ${now.link.hub.name} is connected`);
          return 0;
        }
      }
    }
    case "leave": {
      const s = await api<HubStatus>("GET", "/api/hub");
      if (s.role === "hub") {
        const node = positional[0];
        if (!node) throw new Error("on the hub, name the node to remove: agentbox hub leave <node>");
        print(await api<HubStatus>("DELETE", `/api/hub/nodes/${encodeURIComponent(node)}`));
        return 0;
      }
      const out = await api<HubStatus & { told: boolean }>("DELETE", "/api/hub/link");
      console.log(out.told ? "left the hub" : "left the hub (it could not be told; it will find this node refusing it)");
      return 0;
    }
    case "approve": {
      const node = positional[0];
      if (!node) throw new Error("hub approve needs the node's name or id");
      print(await api<HubStatus>("POST", `/api/hub/nodes/${encodeURIComponent(node)}/approve`));
      return 0;
    }
    case "member":
    case "members": {
      const s = await api<HubStatus>("GET", "/api/hub");
      if (s.role !== "hub") throw new Error("this machine is not a hub");
      const [sub, login] = positional;
      let members: HubMember[] = s.members ?? [];
      if (sub === undefined || sub === "ls") {
        for (const m of members) console.log(`${m.login}\t${m.role}${m.name ? `\t${m.name}` : ""}`);
        return 0;
      }
      if (!login) throw new Error(`hub member ${sub} needs a login`);
      const l = login.toLowerCase();
      if (sub === "add") {
        const role = flags.owner ? "owner" : "member";
        members = members.filter((m) => m.login !== l).map((m) => (role === "owner" && m.role === "owner" ? { ...m, role: "member" as const } : m));
        members.push({ login: l, role, ...(str(flags.name) ? { name: str(flags.name)! } : {}) });
      } else if (sub === "rm" || sub === "remove") {
        members = members.filter((m) => m.login !== l);
      } else throw new Error(`hub member ${sub}: add or rm`);
      print(await api<HubStatus>("PUT", "/api/hub/members", { members }));
      return 0;
    }
    case "lend": {
      const lend: Partial<Lend> = {};
      if (flags.max !== undefined) lend.maxSessions = flags.max === "none" ? null : Number(flags.max);
      if (typeof flags.accounts === "string") lend.accounts = flags.accounts === "all" ? "all" : flags.accounts.split(",").map((a) => a.trim()).filter(Boolean);
      if (typeof flags.starts === "string") lend.acceptStarts = flags.starts === "on";
      if (typeof flags.headroom === "string") lend.shareHeadroom = flags.headroom === "on";
      print(await api<HubStatus>("PATCH", "/api/hub/link", { lend }));
      return 0;
    }
    default:
      console.error(HUB_USAGE);
      return 2;
  }
}
