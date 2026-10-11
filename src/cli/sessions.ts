/** The session verbs of the CLI, shaped like Unix tools so an agent can drive
 *  the fleet with pipes: plain text out, the session id first on every line,
 *  and every verb that takes ids also reads them from stdin with `-`. */

import type { Api } from "../client";
import { CHANGE_KINDS, ChangeWatcher, changeLine, rowsVersion, type ChangeKind, type ChangeRow } from "../core/changes";
import { accountProvider } from "../core/providers/account";
import { agentAncestor, stillRunning } from "../core/providers/procs";
import type { AppState, GrepHit, Session, SessionDiff, TimelineEvent, TimelinePage, Wait } from "../core/types";
import { describe } from "../core/waits";

type Row = AppState["sessions"][number];

/** `--key value`, `--key=value`, `-q` style; `valued` says which keys take a
 *  value and `bare` which do not. Any other option is an error: a mistyped
 *  filter that is quietly ignored lists everything, and that output gets piped
 *  into close or stop. */
export function parseArgs(args: string[], valued: string[], bare: string[] = []): { flags: Map<string, string | true>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    const m = /^--?([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const [, key, inline] = m;
    if (!valued.includes(key!) && !bare.includes(key!)) {
      const known = [...valued, ...bare].map((k) => (k.length === 1 ? `-${k}` : `--${k}`));
      throw new Error(`unknown option ${a}${known.length ? ` (takes ${known.join(", ")})` : ""}`);
    }
    if (valued.includes(key!) && inline === undefined && args[i + 1] === undefined) throw new Error(`${a} needs a value`);
    if (inline !== undefined) flags.set(key!, inline);
    else if (valued.includes(key!) && args[i + 1] !== undefined) flags.set(key!, args[++i]!);
    else flags.set(key!, true);
  }
  return { flags, rest };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** The session this command runs in, or null from a terminal of your own:
 *  what "you" means in what the CLI prints. A session reads its own id like
 *  anyone else's, so every line that names the caller says so in words;
 *  j2g254q4 read "#8154 is j2g254q4's" as another session's claim and left
 *  four pull requests it held with nobody on them. */
export async function me(api: Api): Promise<string | null> {
  return process.env.AGENTBOX_SESSION || (await api<{ id: string | null }>("POST", "/api/whoami", { callerPid: process.pid })).id;
}

/** An id, and "(you)" after it when it is the caller's. */
export const idYou = (id: string, you: string | null): string => (id === you ? `${id} (you)` : id);

async function state(api: Api): Promise<AppState> {
  return api<AppState>("GET", "/api/state");
}

/** Ids from args, or from stdin when an arg is `-`: the first word of each line,
 *  so `agentbox ls ... | agentbox close -` works on ls's own output. Unique
 *  prefixes are accepted. */
async function resolveIds(api: Api, args: string[]): Promise<{ ids: string[]; sessions: Row[] }> {
  let raw = args.filter((a) => a !== "-");
  if (args.includes("-")) {
    const text = await new Response(Bun.stdin.stream()).text();
    raw = raw.concat(text.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean));
  }
  const s = await state(api);
  const ids = raw.map((r) => {
    const exact = s.sessions.find((x) => x.id === r);
    if (exact) return exact.id;
    const pre = s.sessions.filter((x) => x.id.startsWith(r));
    if (pre.length === 1) return pre[0]!.id;
    throw new Error(pre.length ? `"${r}" matches ${pre.length} sessions` : `no session "${r}"`);
  });
  return { ids, sessions: s.sessions };
}

// -------------------------------------------------------------- formatting

/** "4m", "3h", "2d". */
export function ageOf(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** `>2h`, `<30m`, `1d` (= at least). */
function idleTest(spec: string): (idleMs: number) => boolean {
  const m = /^([<>])?(\d+(?:\.\d+)?)(m|h|d)$/.exec(spec.trim());
  if (!m) throw new Error(`--idle: expected something like ">2h" or "<30m", got "${spec}"`);
  const ms = Number(m[2]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[3] as "m" | "h" | "d"];
  return m[1] === "<" ? (x) => x < ms : (x) => x >= ms;
}

const STATUSES = ["running", "blocked", "waiting", "stopped", "closed"] as const;
const PROVIDERS = ["claude", "codex", "devin", "omp", "opencode"] as const;

function oneOf<T extends string>(flag: string, given: string[] | undefined, known: readonly T[]): T[] | undefined {
  if (!given) return undefined;
  const bad = given.filter((g) => !known.includes(g as T));
  if (bad.length) throw new Error(`--${flag}: unknown ${bad.map((b) => `"${b}"`).join(", ")} (one of ${known.join(", ")})`);
  return given as T[];
}

const repoName = (s: Session) => (s.repoRoot ?? s.cwd).split("/").filter(Boolean).pop() ?? "-";

/**
 * Rows in tree order: each row whose parent is not among them, followed by
 * the sessions it started, depth first, every level in the order given.
 */
export function nested<T extends Pick<Session, "id" | "parent">>(rows: T[]): { row: T; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, T[]>();
  for (const r of rows) {
    if (r.parent && r.parent !== r.id && ids.has(r.parent)) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
  }
  const out: { row: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (r: T, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ row: r, depth });
    for (const k of kids.get(r.id) ?? []) walk(k, depth + 1);
  };
  for (const r of rows) if (!r.parent || !ids.has(r.parent)) walk(r, 0);
  // Parents that loop have no root; list them rather than lose them.
  for (const r of rows) walk(r, 0);
  return out;
}

function clock(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toTimeString().slice(0, 5);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return today ? hm : `${md} ${hm}`;
}

// ------------------------------------------------------------------ verbs

/** `agentbox ls [--status a,b] [--idle >2h] [--repo x] [--provider p] [--all] [--roots] [-q] [--json]`
 *
 * A session another one started is listed right after it, its title
 * indented; `--roots` leaves those out when their parent is on the board. */
export async function ls(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["status", "idle", "repo", "provider"], ["all", "roots", "q", "json"]);
  if (rest.length) throw new Error(`unexpected argument "${rest[0]}" (filters are options: --repo, --status, …)`);
  // "archived" is what closed used to be called.
  const statuses = oneOf("status", str(flags.get("status"))?.split(",").map((x) => (x === "archived" ? "closed" : x)), STATUSES);
  const idle = str(flags.get("idle")) ? idleTest(str(flags.get("idle"))!) : null;
  const repo = str(flags.get("repo"))?.toLowerCase();
  const provider = oneOf("provider", str(flags.get("provider"))?.split(","), PROVIDERS);
  const s = await state(api);
  const now = s.serverTime;
  const board = s.sessions.filter((x) => flags.has("all") || x.status !== "closed");
  const onBoard = new Set(board.map((x) => x.id));
  const sorted = board
    .filter((x) => !flags.has("roots") || !x.parent || !onBoard.has(x.parent))
    .filter((x) => !statuses || statuses.includes(x.status))
    .filter((x) => !idle || idle(now - x.lastActivityAt))
    // By name, not path: every agentbox worktree's path contains "agentbox".
    .filter((x) => !repo || repoName(x).toLowerCase().includes(repo))
    .filter((x) => !provider || provider.includes(x.provider))
    .sort((a, b) => a.attention.rank - b.attention.rank || b.lastActivityAt - a.lastActivityAt);
  const tree = nested(sorted);
  const you = flags.has("q") ? null : await me(api);
  if (flags.has("json")) {
    console.log(JSON.stringify(tree.map((t) => (t.row.id === you ? { ...t.row, you: true } : t.row)), null, 2));
    return 0;
  }
  for (const { row: x, depth } of tree) {
    if (flags.has("q")) {
      console.log(x.id);
      continue;
    }
    const host = x.host === "tmux" ? "box" : x.host === "external" ? "ext" : x.host === "subagent" ? "sub" : "-";
    const where = `${repoName(x)}${x.branch ? `@${x.branch}` : ""}`;
    console.log(
      [idYou(x.id, you), x.status.padEnd(8), ageOf(now - x.lastActivityAt).padStart(4), host.padEnd(3), x.provider.padEnd(6), where.slice(0, 40).padEnd(40), (depth ? `${"  ".repeat(depth - 1)}└ ` : "") + (x.label ?? x.title).replace(/\s+/g, " ").slice(0, 90)].join("  "),
    );
  }
  return 0;
}

/** `agentbox show <id>...` */
export async function show(api: Api, args: string[]): Promise<number> {
  const { ids, sessions } = await resolveIds(api, args);
  const s0 = await state(api);
  const acct = new Map(s0.accounts.map((a) => [a.id, a.label]));
  const now = s0.serverTime;
  const waits = await api<Wait[]>("GET", "/api/waits");
  const you = await me(api);
  for (const [n, id] of ids.entries()) {
    const x = sessions.find((s) => s.id === id)!;
    const ctx = x.contextUsed && x.contextLimit ? `${Math.round((100 * x.contextUsed) / x.contextLimit)}% of ${Math.round(x.contextLimit / 1000)}k` : "-";
    const pr = s0.prs.find((p) => p.sessionId === x.id);
    const lines: [string, string | null][] = [
      ["id", id === you ? `${id} (you: the session this command runs in)` : x.id],
      ["title", x.label ?? x.title],
      ["status", `${x.status} — ${x.attention.reason}`],
      ["replaced by", x.successor],
      ["parent", x.parent],
      ["children", sessions.filter((c) => c.parent === x.id).map((c) => c.id).join(" ") || null],
      ["host", x.host + (x.tmux ? ` (${x.tmux})` : "") + (x.pid ? ` pid ${x.pid}` : "")],
      ["provider", `${x.provider}${x.model ? ` · ${x.model}` : ""}`],
      ["account", x.accountId ? acct.get(x.accountId) ?? x.accountId : null],
      // Stopped there until moved (`agentbox move`) or the limit lifts.
      ["limit", x.limitHit ? `${x.limitHit.detail}${x.limitHit.hopped ? " — agentbox has moved it once already" : ""}` : null],
      ["cwd", x.cwd],
      ["branch", x.branch],
      ["worktree", x.worktree],
      ["pr", pr ? `#${pr.number} ${pr.title} (${pr.url})` : null],
      ["holds", s0.prClaims.filter((c) => c.sessionId === x.id).map((c) => `${c.repo}#${c.number} (${c.how === "said" ? "claimed" : "its branch"})`).join(" ") || null],
      ["waiting on", waits.filter((w) => w.sessionId === id && !w.ended).map((w) => `${describe(w.spec)} [wait ${w.id}: ${w.seen ?? "not looked at yet"}]`).join(" ⏎ ") || null],
      ["context", ctx],
      ["started", `${clock(x.startedAt)} (${ageOf(now - x.startedAt)} ago)`],
      ["active", `${clock(x.lastActivityAt)} (${ageOf(now - x.lastActivityAt)} ago)`],
      ["first prompt", x.firstPrompt],
      ["last prompt", x.lastPrompt !== x.firstPrompt ? x.lastPrompt : null],
      ["last reply", x.lastMessage],
    ];
    if (n > 0) console.log("");
    for (const [k, v] of lines) if (v) console.log(`${(k + ":").padEnd(14)}${v.replace(/\s*\n\s*/g, " ⏎ ")}`);
  }
  return 0;
}

async function allEvents(api: Api, id: string, max = Infinity): Promise<TimelineEvent[]> {
  const pages: TimelineEvent[][] = [];
  let before: string | null = null;
  let n = 0;
  do {
    const q: string = before ? `&before=${encodeURIComponent(before)}` : "";
    const page: TimelinePage = await api<TimelinePage>("GET", `/api/sessions/${id}/timeline?limit=1000${q}`);
    pages.unshift(page.events);
    n += page.events.length;
    before = page.before;
  } while (before && n < max);
  return pages.flat();
}

/** `agentbox log <id> [-n turns] [--tools] [--thinking]` — oldest first. */
export async function log(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["n"], ["tools", "thinking"]);
  const { ids } = await resolveIds(api, rest);
  if (ids.length !== 1) throw new Error("log takes one session id");
  let events = await allEvents(api, ids[0]!);
  const turns = str(flags.get("n"));
  if (turns && !/^[1-9]\d*$/.test(turns)) throw new Error(`-n: expected a number of turns, got "${turns}"`);
  if (turns) {
    // The last N user turns and everything after each.
    const starts = events.flatMap((e, i) => (e.kind === "user" ? [i] : []));
    const from = starts[Math.max(0, starts.length - Number(turns))] ?? 0;
    events = events.slice(from);
  }
  const tools = flags.has("tools");
  const thinking = flags.has("thinking");
  for (const e of events) {
    if (e.kind === "user") console.log(`\n── you · ${clock(e.at)}\n${e.text}`);
    else if (e.kind === "assistant") console.log(`\n── agent · ${clock(e.at)}\n${e.text}`);
    else if (e.kind === "thinking" && thinking) console.log(`\n── thinking · ${clock(e.at)}\n${e.text}`);
    else if (e.kind === "tool") {
      const mark = e.status === "error" ? " ✗" : e.status === "running" ? " …" : "";
      console.log(`  ▸ ${e.name}: ${e.summary}${mark}`);
      if (tools && e.output) console.log(e.output.split("\n").slice(0, 40).map((l) => `    ${l}`).join("\n"));
    } else if (e.kind === "meta") console.log(`  · ${e.text}`);
  }
  return 0;
}

/** `agentbox grep <regex> [-i] [--all]` → `id  time  who  line` */
export async function grep(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, [], ["i", "all"]);
  const q = rest[0];
  if (!q) throw new Error("grep needs a pattern");
  const params = new URLSearchParams({ q, ...(flags.has("i") ? { i: "1" } : {}), ...(flags.has("all") ? { all: "1" } : {}) });
  const hits = await api<GrepHit[]>("GET", `/api/grep?${params}`);
  const who: Record<string, string> = { user: "you", assistant: "agent", thinking: "think", tool: "tool", meta: "meta" };
  for (const h of hits) console.log(`${h.sessionId}  ${clock(h.at)}  ${(who[h.kind] ?? h.kind).padEnd(5)}  ${h.line}`);
  return hits.length ? 0 : 1;
}

export async function screen(api: Api, args: string[]): Promise<number> {
  const { ids } = await resolveIds(api, args);
  for (const id of ids) {
    const { text } = await api<{ text: string }>("GET", `/api/sessions/${id}/screen`);
    if (ids.length > 1) console.log(`==> ${id} <==`);
    console.log(text.replace(/\s+$/, ""));
  }
  return 0;
}

export async function diff(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, [], ["stat"]);
  const { ids } = await resolveIds(api, rest);
  for (const id of ids) {
    const d = await api<SessionDiff>("GET", `/api/sessions/${id}/diff`);
    if (d.unavailable) {
      console.error(`${id}: no diff (no worktree or repo)`);
      continue;
    }
    if (flags.has("stat")) {
      for (const f of d.files) console.log(`${id}  ${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.path}`);
      continue;
    }
    for (const f of d.files) if (f.patch) console.log(f.patch);
  }
  return 0;
}

/** `agentbox watch [<id>...|-] [--status blocked,waiting,running,stopped] [--once] [--now]`
 *
 * Runs until killed, or until the agent CLI it runs under exits (no one is
 * left to read it), one line per change as it happens: a session started
 * asking something (blocked, with what), finished its turn (waiting, with the
 * end of its last message), started working (running), stopped. Nothing for
 * the board as it is when it starts, unless `--now`: then a session already
 * blocked, waiting or stopped is reported first, so a re-armed watch cannot
 * miss a turn that ended while it was down. `--once` exits after the first
 * line, so `agentbox watch <id> --once --now` returns when that session is
 * idle, at once if it already is. Default: blocked, waiting and stopped,
 * every session. */
export async function watch(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["status"], ["once", "now"]);
  const kinds: readonly ChangeKind[] = oneOf("status", str(flags.get("status"))?.split(","), CHANGE_KINDS) ?? ["blocked", "waiting", "stopped"];
  const only = rest.length ? new Set((await resolveIds(api, rest)).ids) : null;
  const watcher = new ChangeWatcher({ current: flags.has("now") });
  // Only what a change line reads, not the whole board: watches run for days.
  const query = only ? `ids=${[...only].join(",")}` : "";
  // A watch an agent armed is for that agent: once it is gone, no one reads the lines.
  const owner = agentAncestor();
  let after: string | null = null;
  for (;;) {
    if (owner && !stillRunning(owner)) return 0;
    let rows: ChangeRow[] | null = null;
    try {
      const q = [query, after === null ? "" : `after=${after}`].filter(Boolean).join("&");
      rows = await api<ChangeRow[]>("GET", `/api/sessions/changes${q ? `?${q}` : ""}`);
    } catch {
      // The server restarting is not the end of a watch.
    }
    if (!rows) {
      await Bun.sleep(5_000);
      continue;
    }
    for (const c of watcher.next(rows)) {
      if (!kinds.includes(c.kind)) continue;
      console.log(changeLine(c));
      if (flags.has("once")) return 0;
    }
    const version = rowsVersion(rows);
    // The server holds a request until the rows change; an unchanged answer is its wait running out.
    if (version === after) await Bun.sleep(2_000);
    after = version;
  }
}

/** `agentbox send [--wake] <id> <text…>` or `… | agentbox send <id> -`. From
 *  an agent, the server refuses one that would wake a cold or stopped session
 *  without `--wake`, or is one too many (src/core/sendguard.ts). */
export async function send(api: Api, args: string[]): Promise<number> {
  // Only as a flag of its own before the text: a message may hold the word.
  const at = [0, 1, args.length - 1].find((i) => args[i] === "--wake");
  const wake = at !== undefined;
  const [target, ...words] = wake ? args.filter((_, i) => i !== at) : args;
  if (!target) throw new Error("send needs a session id and text");
  const { ids } = await resolveIds(api, [target]);
  const text = words.length === 1 && words[0] === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : words.join(" ");
  if (!text) throw new Error("nothing to send");
  // Agents are who use this; you type in the app or the terminal. Voice mode
  // is the exception: what it sends is you, spoken (AGENTBOX_SEND_AS=you).
  if (process.env.AGENTBOX_SEND_AS === "you") {
    await api("POST", `/api/sessions/${ids[0]}/send`, { text });
    return 0;
  }
  const sent = await api<{ to: string } | null>("POST", `/api/sessions/${ids[0]}/send`, { text, from: "agent", wake, fromSession: process.env.AGENTBOX_SESSION, callerPid: process.pid });
  // Said only once the session has taken it: no line, no send.
  if (sent && sent.to !== ids[0]) console.log(`sent to ${sent.to}: it has taken over from ${ids[0]}, so send to it from now on`);
  else console.log(`sent: ${ids[0]} took it`);
  return 0;
}

const DONE = { close: "closed", reopen: "reopened", stop: "stopped", resume: "resumed", adopt: "adopted" } as const;

/** Verbs that act on each id in turn, and say what happened to each. */
export async function each(api: Api, verb: "close" | "reopen" | "stop" | "resume" | "adopt", args: string[]): Promise<number> {
  const { rest } = parseArgs(args, []);
  const { ids } = await resolveIds(api, rest);
  if (ids.length === 0) throw new Error(`${verb} needs session ids (or - to read them from stdin)`);
  let failed = 0;
  for (const id of ids) {
    try {
      if (verb === "close" || verb === "reopen") await api("POST", `/api/sessions/${id}/close`, { closed: verb === "close" });
      else await api("POST", `/api/sessions/${id}/${verb}`, {});
      console.log(`${id}  ${DONE[verb]}`);
    } catch (e) {
      failed++;
      console.error(`${id}  ${verb} failed: ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

/**
 * `agentbox move <id> [--account NAME] [--force] [text…]`: continue a session
 * on another account, with its conversation: the limit banner's button, for
 * an agent. The account is the one named, else where the fleet's own move
 * would send it. The refusals are the server's.
 */
export async function move(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["account"], ["force"]);
  const [target, ...words] = rest;
  if (!target) throw new Error("move needs a session id");
  const { ids } = await resolveIds(api, [target]);
  const s = await state(api);
  const row = s.sessions.find((x) => x.id === ids[0]);
  const mine = s.accounts.filter((a) => row && a.provider === accountProvider(row.provider));
  const wanted = str(flags.get("account"));
  const to = wanted ? mine.find((a) => a.id === wanted || a.label === wanted || a.email === wanted) : null;
  if (wanted && !to) throw new Error(`no ${row ? accountProvider(row.provider) : ""} account "${wanted}" — have: ${mine.map((a) => a.label).join(", ") || "none"}`);
  const by = process.env.AGENTBOX_SESSION;
  const prompt = words.join(" ") || `[agentbox: you have been moved to another account${by ? ` by session ${by}` : ""}${row?.limitHit ? ", because the one you were on reached its usage limit" : ""}. Carry on where you left off.]`;
  const moved = await api<Session>("POST", `/api/sessions/${ids[0]}/move`, { accountId: to?.id ?? "auto", prompt, must: true, force: flags.has("force") });
  console.log(`${ids[0]}  moved to ${s.accounts.find((a) => a.id === moved.accountId)?.label ?? moved.accountId}`);
  return 0;
}

export async function label(api: Api, args: string[]): Promise<number> {
  const [target, ...words] = args;
  if (!target) throw new Error("label needs a session id and a name (empty clears it)");
  const { ids } = await resolveIds(api, [target]);
  await api("PATCH", `/api/sessions/${ids[0]}`, { label: words.join(" ") || null });
  return 0;
}
