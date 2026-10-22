/** `agentbox agent …` (src/core/agents.ts, docs/agents.md): add
 *  one from its directory, see them, and call one from a session. The name is
 *  first on every line. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Api } from "../client";
import type { AgentInfo } from "../core/types";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export const AGENT_USAGE = `agentbox agent [ls]                     the agents, their programs and main conversations
agentbox agent add <dir>                add the one in <dir> (its agent.json), or read it again
agentbox agent rm <name>                forget it; its directory and state stay
agentbox agent restart|enable|disable <name>
agentbox agent log <name>               the end of its program's output
agentbox agent main <name> <id|none>    say which session is its main conversation
agentbox agent chat <name> <text…>      say it to its main conversation (started from its manifest if there is none)
agentbox agent view <name> [--tab t]    its page, as JSON
agentbox agent call <name> <action> [--json <file|->] [--set key=value …]
                                             an action on it, as the session you run it in`;

export async function agent(api: Api, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const name = (): string => {
    const n = rest[0];
    if (!n) throw new Error(`agent ${verb} needs a name`);
    return n;
  };
  switch (verb) {
    case undefined:
    case "ls":
    case "list": {
      const all = await api<AgentInfo[]>("GET", "/api/agents");
      if (!all.length) console.log("no agents: add one with `agentbox agent add <dir>`");
      for (const s of all) console.log(line(s));
      return 0;
    }
    case "add": {
      const dir = rest[0];
      if (!dir) throw new Error("agent add needs the agent's directory");
      console.log(line(await api<AgentInfo>("POST", "/api/agents", { dir: resolve(dir) })));
      return 0;
    }
    case "rm":
    case "remove":
      await api("DELETE", `/api/agents/${encodeURIComponent(name())}`);
      console.log(`${name()} removed`);
      return 0;
    case "restart":
      console.log(line(await api<AgentInfo>("POST", `/api/agents/${encodeURIComponent(name())}/restart`)));
      return 0;
    case "enable":
    case "disable":
      console.log(line(await api<AgentInfo>("PATCH", `/api/agents/${encodeURIComponent(name())}`, { enabled: verb === "enable" })));
      return 0;
    case "log": {
      const { text } = await api<{ text: string }>("GET", `/api/agents/${encodeURIComponent(name())}/log`);
      process.stdout.write(text);
      return 0;
    }
    case "main": {
      const id = rest[1];
      if (!id) throw new Error("agent main needs a session id, or none");
      console.log(line(await api<AgentInfo>("PATCH", `/api/agents/${encodeURIComponent(name())}`, { main: id === "none" ? null : id })));
      return 0;
    }
    case "chat": {
      const text = rest.slice(1).join(" ");
      if (!text.trim()) throw new Error("agent chat needs what to say");
      const out = await api<{ session: string; started: boolean }>("POST", `/api/agents/${encodeURIComponent(name())}/chat`, { text, sendId: randomUUID() });
      console.log(`${out.session} ${out.started ? "started" : "sent"}`);
      return 0;
    }
    case "view": {
      const { flags } = parseArgs(rest.slice(1), ["tab"]);
      const tab = str(flags.get("tab"));
      console.log(JSON.stringify(await api("GET", `/api/agents/${encodeURIComponent(name())}/view${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`), null, 2));
      return 0;
    }
    case "call": {
      const action = rest[1];
      if (!action) throw new Error("agent call needs an action");
      // --set may come more than once: take those out before the rest are read.
      const sets: string[] = [];
      const others: string[] = [];
      for (let i = 2; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--set") {
          if (rest[i + 1] === undefined) throw new Error("--set needs key=value");
          sets.push(rest[++i]!);
        } else if (a.startsWith("--set=")) sets.push(a.slice(6));
        else others.push(a);
      }
      const { flags, rest: extra } = parseArgs(others, ["json", "tab"], []);
      if (extra.length) throw new Error(`unexpected argument "${extra[0]}": values go in --json or --set`);
      const file = str(flags.get("json"));
      const values: Record<string, unknown> = file ? JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")) : {};
      for (const kv of sets) setValue(values, kv);
      const out = await api("POST", `/api/agents/${encodeURIComponent(name())}/action`, { action, values, tab: str(flags.get("tab")) ?? null });
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
      return 0;
    }
    case "help":
      console.log(AGENT_USAGE);
      return 0;
    default:
      throw new Error(`agent takes ls, add, rm, restart, enable, disable, log, main, chat, view or call: not "${verb}"`);
  }
}

function setValue(values: Record<string, unknown>, kv: string): void {
  const at = kv.indexOf("=");
  if (at < 1) throw new Error(`--set takes key=value: not "${kv}"`);
  values[kv.slice(0, at)] = kv.slice(at + 1);
}

function line(s: AgentInfo): string {
  const proc = s.process ? `${s.process.state}${s.process.pid ? ` pid ${s.process.pid}` : ""}${s.process.restarts ? ` restarts ${s.process.restarts}` : ""}` : "no program";
  return `${s.name}  ${s.enabled ? proc : "disabled"}  main ${s.main ?? (s.canStart ? "(on first message)" : "none")}  ${s.dir}${s.error ? `  ERROR ${s.error}` : ""}`;
}

/** `agentbox handover <from> <to> [--close]`: what `from` holds goes to `to`. */
export async function handover(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, [], ["close"]);
  const [from, to] = rest;
  if (!from || !to) throw new Error("handover needs the session handing over and the one taking over: agentbox handover <from> <to> [--close]");
  const out = await api<{ children: string[]; cards: number; claims: number; closed: boolean }>("POST", `/api/sessions/${encodeURIComponent(from)}/handover`, { to, close: flags.has("close") });
  console.log(`${from} → ${to}: ${out.children.length} sessions, ${out.cards} cards, ${out.claims} pull requests${out.closed ? "; closed" : ""}`);
  return 0;
}
