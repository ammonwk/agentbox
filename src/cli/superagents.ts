/** `agentbox superagent …` (src/core/superagents.ts, docs/superagents.md): add
 *  one from its directory, see them, and call one from a session. The name is
 *  first on every line. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Api } from "../client";
import type { AppState, SuperagentInfo } from "../core/types";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export const SUPERAGENT_USAGE = `agentbox superagent [ls] [--project P] [--json]  the superagents, their programs and main conversations
agentbox superagent add <dir>                add the one in <dir> (its superagent.json), or read it again
agentbox superagent rm <name>                forget it; its directory and state stay
agentbox superagent restart|enable|disable <name>
agentbox superagent log <name>               the end of its program's output
agentbox superagent main <name> <id|none>    say which session is its main conversation
agentbox superagent chat <name> <text…>      say it to its main conversation (started from its manifest if there is none)
agentbox superagent send <name> <text…|->    the same, as this session's message, with its sender recorded
agentbox superagent memory <name> [search <words…> | show <id> | note|handoff --request <uuid> --file <json>
                                 | prefer --key <k> (--text <t> | --file <f>) | forget --key <k>]
                                             its memory journal (manifest "memory": true)
agentbox superagent loop <name> [ls | set <id> --when <w> (--prompt <t> | --file <f>) [--check <cmd>] | rm <id>]
                                             prompts said to its main on a schedule
agentbox superagent sweeps <name>            what its daily sweeps closed and kept
agentbox superagent view <name> [--tab t]    its page, as JSON
agentbox superagent call <name> <action> [--json <file|->] [--set key=value …]
                                             an action on it, as the session you run it in`;

export async function superagent(api: Api, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const name = (): string => {
    const n = rest[0];
    if (!n) throw new Error(`superagent ${verb} needs a name`);
    return n;
  };
  switch (verb) {
    case undefined:
    case "ls":
    case "list": {
      const { flags } = parseArgs(rest, ["project"], ["json"]);
      let all = await api<SuperagentInfo[]>("GET", "/api/superagents");
      const project = str(flags.get("project"));
      if (project) {
        const repos = (await api<AppState>("GET", "/api/state")).repos;
        const id = repos.find((r) => r.id === project || r.displayName.toLowerCase() === project.toLowerCase() || r.fullName?.toLowerCase() === project.toLowerCase())?.id;
        if (!id) throw new Error(`no project "${project}"`);
        all = all.filter((s) => s.projects === null || s.projects.includes(id));
      }
      if (flags.has("json")) console.log(JSON.stringify(all, null, 2));
      else if (!all.length) console.log("no superagents: add one with `agentbox superagent add <dir>`");
      else for (const s of all) console.log(line(s));
      return 0;
    }
    case "add": {
      const dir = rest[0];
      if (!dir) throw new Error("superagent add needs the superagent's directory");
      console.log(line(await api<SuperagentInfo>("POST", "/api/superagents", { dir: resolve(dir) })));
      return 0;
    }
    case "rm":
    case "remove":
      await api("DELETE", `/api/superagents/${encodeURIComponent(name())}`);
      console.log(`${name()} removed`);
      return 0;
    case "restart":
      console.log(line(await api<SuperagentInfo>("POST", `/api/superagents/${encodeURIComponent(name())}/restart`)));
      return 0;
    case "enable":
    case "disable":
      console.log(line(await api<SuperagentInfo>("PATCH", `/api/superagents/${encodeURIComponent(name())}`, { enabled: verb === "enable" })));
      return 0;
    case "log": {
      const { text } = await api<{ text: string }>("GET", `/api/superagents/${encodeURIComponent(name())}/log`);
      process.stdout.write(text);
      return 0;
    }
    case "main": {
      const id = rest[1];
      if (!id) throw new Error("superagent main needs a session id, or none");
      console.log(line(await api<SuperagentInfo>("PATCH", `/api/superagents/${encodeURIComponent(name())}`, { main: id === "none" ? null : id })));
      return 0;
    }
    case "chat": {
      const text = rest.slice(1).join(" ");
      if (!text.trim()) throw new Error("superagent chat needs what to say");
      const out = await api<{ session: string; started: boolean }>("POST", `/api/superagents/${encodeURIComponent(name())}/chat`, { text, sendId: randomUUID() });
      console.log(`${out.session} ${out.started ? "started" : "sent"}`);
      return 0;
    }
    case "send": {
      const words = rest.slice(1);
      const text = words.length === 1 && words[0] === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : words.join(" ");
      if (!text.trim()) throw new Error("superagent send <name> <text…|->");
      const s = await api<SuperagentInfo>("GET", `/api/superagents/${encodeURIComponent(name())}`);
      if (!s.enabled) throw new Error(`${s.title} is disabled; enable it first`);
      if (s.main) {
        // Waking it is the point of messaging an agent, so --wake is implied.
        const sent = await api<{ to: string } | null>("POST", `/api/sessions/${s.main}/send`, { text, from: "agent", wake: true, fromSession: process.env.AGENTBOX_SESSION, callerPid: process.pid });
        console.log(`sent to ${s.title} (${s.name}): its main ${sent?.to ?? s.main} took it`);
        return 0;
      }
      const out = await api<{ session: string; started: boolean }>("POST", `/api/superagents/${encodeURIComponent(s.name)}/chat`, { text, sendId: randomUUID() });
      console.log(`sent to ${s.title} (${s.name}): it had no main, so this started one, session ${out.session}`);
      return 0;
    }
    case "memory":
      return memory(api, name(), rest.slice(1));
    case "loop":
    case "loops":
      return loop(api, name(), rest.slice(1));
    case "sweeps": {
      const sweeps = await api<{ at: number; closed: { id: string; title: string }[]; kept: { id: string; title: string; why: string }[] }[]>("GET", `/api/superagents/${encodeURIComponent(name())}/sweeps`);
      if (!sweeps.length) console.log(`${name()} has no sweeps yet`);
      for (const w of sweeps) {
        console.log(`${new Date(w.at).toLocaleString()}: closed ${w.closed.length}, kept ${w.kept.length}`);
        for (const c of w.closed) console.log(`  closed ${c.id}  ${c.title}`);
        for (const k of w.kept) console.log(`  kept   ${k.id}  ${k.title}: ${k.why}`);
      }
      return 0;
    }
    case "view": {
      const { flags } = parseArgs(rest.slice(1), ["tab"]);
      const tab = str(flags.get("tab"));
      console.log(JSON.stringify(await api("GET", `/api/superagents/${encodeURIComponent(name())}/view${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`), null, 2));
      return 0;
    }
    case "call": {
      const action = rest[1];
      if (!action) throw new Error("superagent call needs an action");
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
      const out = await api("POST", `/api/superagents/${encodeURIComponent(name())}/action`, { action, values, tab: str(flags.get("tab")) ?? null });
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
      return 0;
    }
    case "help":
      console.log(SUPERAGENT_USAGE);
      return 0;
    default:
      throw new Error(`superagent takes ls, add, rm, restart, enable, disable, log, main, chat, send, memory, loop, sweeps, view or call: not "${verb}"`);
  }
}

function setValue(values: Record<string, unknown>, kv: string): void {
  const at = kv.indexOf("=");
  if (at < 1) throw new Error(`--set takes key=value: not "${kv}"`);
  values[kv.slice(0, at)] = kv.slice(at + 1);
}

const clock = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

function line(s: SuperagentInfo): string {
  const proc = s.process ? `${s.process.state}${s.process.pid ? ` pid ${s.process.pid}` : ""}${s.process.restarts ? ` restarts ${s.process.restarts}` : ""}` : "no program";
  const loops = s.loops.map((l) => `loop ${l.id} ${l.when}, next ${l.nextAt ? clock(l.nextAt) : "never"}`);
  return [s.name, s.enabled ? proc : "disabled", `main ${s.main ?? (s.canStart ? "(on first message)" : "none")}`, s.dir, ...loops, ...(s.error ? [`ERROR ${s.error}`] : [])].join("  ");
}

/** `agentbox superagent memory <name> …`: its journal (src/core/superagent/memory-view.ts). */
async function memory(api: Api, name: string, args: string[]): Promise<number> {
  const [verb, ...more] = args;
  const base = `/api/superagents/${encodeURIComponent(name)}/memory`;
  const { flags, rest } = parseArgs(more, ["request", "file", "key", "text"], ["json"]);
  const get = (k: string) => str(flags.get(k)) ?? "";
  const print = (out: unknown) => console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  switch (verb) {
    case undefined:
    case "view":
      print(await api("GET", base));
      return 0;
    case "search":
      if (!rest.length) throw new Error("superagent memory <name> search <words…>");
      print((await api<{ results: unknown }>("GET", `${base}?q=${encodeURIComponent(rest.join(" "))}`)).results);
      return 0;
    case "show":
      if (!rest[0]) throw new Error("superagent memory <name> show <record id>");
      print(await api("GET", `${base}/${encodeURIComponent(rest[0])}`));
      return 0;
    case "note":
    case "handoff": {
      if (!get("file")) throw new Error(`superagent memory <name> ${verb} --request <uuid> --file <json>`);
      const body = JSON.parse(readFileSync(get("file") === "-" ? 0 : get("file"), "utf8"));
      const rec = await api<{ id: string }>("POST", `${base}/${verb}`, { ...(get("request") ? { request: get("request") } : {}), body });
      console.log(`${verb} ${rec.id} saved`);
      return 0;
    }
    case "prefer":
    case "forget": {
      const key = get("key");
      if (!key) throw new Error(`superagent memory <name> ${verb} --key <key>${verb === "prefer" ? " (--text <text> | --file <file>)" : ""}`);
      const text = verb === "forget" ? "" : get("file") ? readFileSync(get("file"), "utf8").trim() : get("text");
      if (verb === "prefer" && !text) throw new Error("a preference needs --text or --file");
      await api("POST", `${base}/prefer`, { key, text });
      console.log(verb === "forget" ? `${key} forgotten` : `${key} saved`);
      return 0;
    }
    default:
      throw new Error(`superagent memory takes search, show, note, handoff, prefer or forget: not "${verb}"`);
  }
}

/** `agentbox superagent loop <name> …`: prompts said to its main on a schedule (src/core/superagent/loops.ts). */
async function loop(api: Api, name: string, args: string[]): Promise<number> {
  const [verb, id, ...more] = args;
  const base = `/api/superagents/${encodeURIComponent(name)}`;
  const show = (s: SuperagentInfo) => {
    if (!s.loops.length) console.log(`${s.name} has no loops`);
    for (const l of s.loops)
      console.log(`${l.id}  ${l.source}  ${l.when}${l.check ? `, when \`${l.check}\` exits 0` : ""}; next ${l.nextAt ? clock(l.nextAt) : "never"}${l.due ? `, one due since ${clock(l.due)} (it waits for the turn to end)` : ""}${l.last ? `; last ${clock(l.last.at)}: ${l.last.result}${l.last.detail ? ` (${l.last.detail})` : ""}` : ""}`);
    return 0;
  };
  switch (verb) {
    case undefined:
    case "ls":
      return show(await api<SuperagentInfo>("GET", base));
    case "set": {
      const { flags } = parseArgs(more, ["when", "check", "prompt", "file"], []);
      const get = (k: string) => str(flags.get(k)) ?? "";
      const prompt = get("file") ? readFileSync(get("file"), "utf8").trim() : get("prompt");
      if (!id || !get("when") || !prompt) throw new Error('superagent loop <name> set <id> --when "every hour" (--prompt <text> | --file <file>) [--check <command: exit 0 runs, 1 skips>]');
      return show(await api<SuperagentInfo>("PUT", `${base}/loops/${encodeURIComponent(id)}`, { when: get("when"), check: get("check") || null, prompt }));
    }
    case "rm":
    case "off":
      if (!id) throw new Error("superagent loop <name> rm <id>");
      return show(await api<SuperagentInfo>("DELETE", `${base}/loops/${encodeURIComponent(id)}`));
    default:
      throw new Error(`superagent loop takes ls, set or rm: not "${verb}"`);
  }
}

/** `agentbox report --request <uuid> --file <text>`: from a superagent's
 *  session, a public issue on agentbox's tracker; its first line is the title. */
export async function report(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["request", "file"], []);
  const file = str(flags.get("file"));
  if (!file) throw new Error("report --request <stable uuid> --file <text file, first line the title>");
  const text = readFileSync(file === "-" ? 0 : file, "utf8").trim();
  const r = await api<{ state: string; result: string }>("POST", "/api/report", { request: str(flags.get("request")) ?? randomUUID(), text });
  console.log(r.result);
  return r.state === "sent" ? 0 : 1;
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
