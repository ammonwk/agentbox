/** `agentbox ext …` (src/core/extensions.ts, docs/extensions.md): link one
 *  in, see them, read a program's output, and call one from a session. The
 *  name is first on every line. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serverBase, type Api } from "../client";
import { sessionHeaders } from "../core/session-authority";
import type { ExtensionInfo } from "../core/types";
import { parseArgs } from "./sessions";

export const EXT_USAGE = `agentbox ext [ls]                       the extensions and their programs
agentbox ext add <dir> [--name n]       link the one in <dir> (its extension.json) in
agentbox ext rm <name>                  unlink it; its directory and state stay
agentbox ext restart <name>             stop its program; it starts again at once
agentbox ext log <name>                 the end of its program's output
agentbox ext call <name> <path> [--json <file|->]
                                        GET (or with --json, POST) its /<path>, as the session you run it in`;

export async function ext(api: Api, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const name = (): string => {
    const n = rest[0];
    if (!n) throw new Error(`ext ${verb} needs a name`);
    return encodeURIComponent(n);
  };
  switch (verb) {
    case undefined:
    case "ls":
    case "list": {
      const all = await api<ExtensionInfo[]>("GET", "/api/extensions");
      if (!all.length) console.log("no extensions: link one in with `agentbox ext add <dir>`");
      for (const x of all) console.log(`${x.name}  ${x.state}${x.pid ? ` pid ${x.pid}` : ""}${x.restarts ? ` restarts ${x.restarts}` : ""}  ${x.dir}${x.error ? `  ERROR ${x.error}` : ""}`);
      return 0;
    }
    case "add": {
      const { flags, rest: dirs } = parseArgs(rest, ["name"]);
      if (!dirs[0]) throw new Error("ext add needs the extension's directory");
      const n = flags.get("name");
      const out = await api<{ name: string }>("POST", "/api/extensions", { dir: resolve(dirs[0]), ...(typeof n === "string" ? { name: n } : {}) });
      console.log(`${out.name} added: its page is /x/${out.name}/`);
      return 0;
    }
    case "rm":
    case "remove":
      await api("DELETE", `/api/extensions/${name()}`);
      console.log(`${rest[0]} removed`);
      return 0;
    case "restart":
      await api("POST", `/api/extensions/${name()}/restart`);
      console.log(`${rest[0]} restarting`);
      return 0;
    case "log": {
      const { text } = await api<{ text: string }>("GET", `/api/extensions/${name()}/log`);
      process.stdout.write(text);
      return 0;
    }
    case "call": {
      const { flags, rest: pos } = parseArgs(rest.slice(1), ["json"]);
      const path = (pos[0] ?? "").replace(/^\/+/, "");
      const file = flags.get("json");
      const body = typeof file === "string" ? readFileSync(file === "-" ? 0 : file, "utf8") : undefined;
      // Its session's capability goes with it: the program is told which session asked.
      const res = await fetch(`${serverBase()}/x/${name()}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-agentbox": "1", "content-type": "application/json", ...sessionHeaders() },
        body,
      });
      const text = await res.text();
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return res.ok ? 0 : 1;
    }
    case "help":
      console.log(EXT_USAGE);
      return 0;
    default:
      throw new Error(`ext takes ls, add, rm, restart, log or call: not "${verb}"`);
  }
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
