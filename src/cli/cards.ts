/** Cards from the CLI (src/core/cards.ts): a session hands the user something
 *  to decide or to know, and reads what came back. Plain text out, the card's
 *  id first on every line. */

import { readFileSync } from "node:fs";
import type { Api } from "../client";
import { parseWhen } from "../core/schedule";
import type { Card } from "../core/types";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export async function card(api: Api, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "add":
      return add(api, rest);
    case "list":
    case "ls":
    case undefined:
      return list(api, rest);
    case "show":
      return show(api, rest);
    case "ack":
      return each(api, rest, "ack", "acknowledged");
    case "close":
      return close(api, rest);
    default:
      throw new Error(`card takes add, list, show, ack or close: not "${verb}"`);
  }
}

async function add(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["kind", "title", "short", "long", "long-file", "pr", "recommend", "default", "default-at", "key", "for"], []);
  if (rest.length) throw new Error(`unexpected argument "${rest[0]}": a card's parts are options (--title, --short, …)`);
  const need = (k: string): string => {
    const v = str(flags.get(k));
    if (!v?.trim()) throw new Error(`card add needs --${k}`);
    return v;
  };
  const file = str(flags.get("long-file"));
  let defaultAt: number | undefined;
  const at = str(flags.get("default-at"));
  if (at) {
    if (!str(flags.get("default"))) throw new Error("--default-at needs --default: what happens then");
    const p = parseWhen(at);
    if ("error" in p) throw new Error(`--default-at: ${p.error}`);
    if (p.rule.kind !== "once") throw new Error(`--default-at is one time, as in "in 24 hours" or "tomorrow at 9am": not "${at}"`);
    defaultAt = p.rule.at;
  }
  const c = await api<Card>("POST", "/api/cards", {
    kind: need("kind"),
    title: need("title"),
    short: need("short"),
    long: file ? readFileSync(file === "-" ? 0 : file, "utf8") : str(flags.get("long")),
    pr: str(flags.get("pr")),
    recommend: str(flags.get("recommend")),
    default: str(flags.get("default")),
    defaultAt,
    key: str(flags.get("key")),
    session: process.env.AGENTBOX_SESSION,
    about: str(flags.get("for")),
    callerPid: process.pid,
  });
  console.log(String(c.id));
  return 0;
}

async function list(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["session"], ["open", "later", "answered", "closed", "unread", "json"]);
  if (rest.length) throw new Error(`unexpected argument "${rest[0]}"`);
  const state = (["open", "later", "answered", "closed"] as const).filter((s) => flags.has(s));
  if (state.length > 1) throw new Error("one of --open, --later, --answered, --closed");
  const q = new URLSearchParams();
  if (state[0]) q.set("state", state[0]);
  if (flags.has("unread")) q.set("unread", "1");
  const session = str(flags.get("session"));
  if (session) q.set("session", session);
  const cards = await api<Card[]>("GET", `/api/cards?${q}`);
  if (flags.has("json")) console.log(JSON.stringify(cards, null, 2));
  else if (cards.length === 0) console.error("no cards");
  else for (const c of cards) console.log(line(c));
  return 0;
}

async function show(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, [], ["json"]);
  if (rest.length === 0) throw new Error("card show needs a card id");
  for (const id of rest) {
    const c = await api<Card>("GET", `/api/cards/${encodeURIComponent(id)}`);
    if (flags.has("json")) {
      console.log(JSON.stringify(c, null, 2));
      continue;
    }
    const out: [string, string | null][] = [
      ["card", `${c.id} · ${c.kind} · ${status(c)}`],
      ["title", c.title],
      ["from", c.sessionId ? `${c.sessionId}${c.about ? ` (about ${c.about})` : ""}` : null],
      ["pr", c.pr],
      ["added", when(c.createdAt)],
      ["short", c.short],
      ["recommend", c.recommend],
      ["default", c.default ? `${c.default}${c.defaultAt ? ` (${c.defaultAt <= Date.now() ? "passed" : "at"} ${when(c.defaultAt)})` : ""}` : null],
      ["answer", c.state === "answered" ? (c.answer ? c.answer : "(seen, nothing said)") : null],
      ["answered", c.answeredAt && c.state === "answered" ? when(c.answeredAt) : null],
      ["withdrawn", c.state === "closed" ? (c.closedWhy ?? "yes") : null],
    ];
    for (const [k, v] of out) if (v) console.log(`${`${k}:`.padEnd(11)}${v.replace(/\n/g, "\n           ")}`);
    if (c.long) console.log(`\n${c.long}`);
  }
  return 0;
}

async function each(api: Api, ids: string[], action: string, done: string): Promise<number> {
  if (ids.length === 0) throw new Error(`card ${action} needs card ids`);
  let failed = 0;
  for (const id of ids) {
    try {
      await api("POST", `/api/cards/${encodeURIComponent(id)}/${action}`, {});
      console.log(`${id}  ${done}`);
    } catch (e) {
      failed++;
      console.error(`${id}  ${action} failed: ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

async function close(api: Api, args: string[]): Promise<number> {
  const [id, ...why] = args;
  if (!id || why.length === 0) throw new Error("card close needs a card id and why: agentbox card close 12 the PR merged without it");
  await api("POST", `/api/cards/${encodeURIComponent(id)}/close`, { why: why.join(" ") });
  console.log(`${id}  withdrawn`);
  return 0;
}

const when = (at: number): string => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Where it stands, in a word or two. */
function status(c: Card): string {
  if (c.state === "answered") return !c.answer ? "seen" : c.unread ? "answered, unread" : "answered";
  if (c.state === "closed") return "withdrawn";
  const passed = c.defaultAt !== null && c.defaultAt <= Date.now() ? ", default passed" : "";
  return `${c.state}${passed}`;
}

/** `id  status  kind  title [→ answer]`. */
function line(c: Card): string {
  const answer = c.state === "answered" && c.answer ? `  → ${c.answer.replace(/\s+/g, " ").slice(0, 200)}` : "";
  return `${String(c.id).padEnd(4)}  ${status(c).padEnd(16)}  ${c.kind.padEnd(8)}  ${c.title}${answer}`;
}
