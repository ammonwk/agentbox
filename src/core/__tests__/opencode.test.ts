import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeOpencode,
  createOpencodeAdapter,
  isOpencodeTui,
  modelRef,
  newSessionId,
  parseOpencodeArgv,
} from "../providers/opencode";
import { closeOpencodeDbs } from "../providers/opencode-db";
import type { Account } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-opencode-"));
const dbFile = join(dir, "opencode.db");
const adapter = createOpencodeAdapter({ dataDir: () => dir });
const account: Account = { id: "omp", provider: "omp", label: "omp", email: null, plan: null, home: "/nowhere", isDefault: false, enabled: true, createdAt: 0 };
const savedHome = process.env.AGENTBOX_HOME;

const S = "ses_f382f776effeH5gVsCj2bcC40x";
const CHILD = "ses_f3821c0b4ffen3C6IoQiSZioTN";
const T0 = 1_790_000_000_000;
const MODEL = { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" };

let w: Database;
let seq = 0;

function session(id: string, over: Record<string, unknown> = {}) {
  const r = { id, parent_id: null, directory: "/w", title: null, model: JSON.stringify(MODEL), time_created: T0, time_updated: T0, time_idle: null, time_viewed: null, time_archived: null, tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0, ...over };
  w.query(
    `INSERT OR REPLACE INTO session_v2 (id, parent_id, directory, title, model, time_created, time_updated, time_idle, time_viewed, time_archived, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write)
     VALUES ($id, $parent_id, $directory, $title, $model, $time_created, $time_updated, $time_idle, $time_viewed, $time_archived, $tokens_input, $tokens_output, $tokens_cache_read, $tokens_cache_write)`,
  ).run(Object.fromEntries(Object.entries(r).map(([k, v]) => [`$${k}`, v])) as any);
}

function bump(id: string): number {
  seq++;
  w.query("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq").run(id, seq);
  return seq;
}

function message(id: string, type: string, data: object, at = T0 + seq * 1000): number {
  const s = bump(id);
  w.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(`msg_${s}`, id, type, s, at, at, JSON.stringify(data));
  return s;
}

function rewrite(id: string, at: number, data: object) {
  bump(id);
  w.query("UPDATE session_message SET data = ?, time_updated = ? WHERE session_id = ? AND seq = ?").run(JSON.stringify(data), T0 + seq * 1000, id, at);
}

const tokens = { input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 0 } };

beforeAll(() => {
  process.env.AGENTBOX_HOME = dir;
  w = new Database(dbFile);
  w.exec("PRAGMA journal_mode = WAL");
  w.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, parent_id text, directory text NOT NULL, title text, model text,
    time_created integer NOT NULL, time_updated integer NOT NULL, time_idle integer, time_viewed integer, time_archived integer,
    tokens_input integer DEFAULT 0, tokens_output integer DEFAULT 0, tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0)`);
  w.exec(`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`);
  w.exec("CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq)");
  w.exec("CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)");
  w.exec("CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text)");
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = savedHome;
  closeOpencodeDbs();
  w.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode reader", () => {
  test("folds a session: prompts, tokens with its subagents', the turn, and a timeline that follows rewrites", async () => {
    session(S, { title: "Fix the thing" });
    session(CHILD, { parent_id: S, tokens_input: 50, tokens_output: 5 });
    message(S, "agent-switched", { agent: "build" });
    message(S, "user", { time: { created: T0 + 1 }, text: "Fix https://github.com/acme/app/pull/12 please", files: [] });
    const step = message(S, "assistant", {
      time: { created: T0 + 2 },
      model: MODEL,
      content: [
        { type: "reasoning", text: "Let me look." },
        { type: "tool", id: "call_1", name: "shell", state: { status: "running", input: { command: "ls", description: "List files" } }, time: { created: T0 + 3 } },
      ],
    });

    const [ref] = await adapter.listTranscripts(account, T0 - 1);
    expect(ref).toMatchObject({ provider: "opencode", accountId: "omp", agentSessionId: S, path: `${dbFile}#${S}` });
    const reader = adapter.reader(ref!);
    let { facts } = await reader.refresh();
    expect(facts).toMatchObject({ title: "Fix the thing", cwd: "/w", resumeCwd: "/w", turnOpen: true, model: "opencode-go/deepseek-v4.1-flash", prRepo: "acme/app", isSubagent: false });
    expect(facts.firstPrompt).toBe("Fix https://github.com/acme/app/pull/12 please");
    expect(facts.tokens.input).toBe(50);

    const page = await reader.timeline({ limit: 10 });
    expect(page.events.map((e) => [e.id, e.kind])).toEqual([
      [`${step - 1}.0`, "user"],
      [`${step}.0`, "thinking"],
      [`${step}.1`, "tool"],
    ]);
    expect(page.events[2]).toMatchObject({ name: "shell", summary: "ls", title: "List files", status: "running" });

    // The step finishes in place, then the turn ends.
    rewrite(S, step, {
      time: { created: T0 + 2, completed: T0 + 9 },
      model: MODEL,
      tokens,
      finish: "stop",
      content: [
        { type: "reasoning", text: "Let me look." },
        { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a b" }] }, time: { created: T0 + 3, completed: T0 + 5 } },
        { type: "text", text: "Done." },
      ],
    });
    message(S, "idle", { outcome: "succeeded" });
    ({ facts } = await reader.refresh());
    expect(facts).toMatchObject({ turnOpen: false, lastMessage: "Done.", contextUsed: 1115, lastTurnAt: T0 + 9 });
    expect(facts.tokens.input).toBe(150);
    expect(facts.tokens.output).toBe(20);
    expect(facts.tokens.cacheRead).toBe(1000);

    const next = await reader.since(page.cursor);
    expect(next.reset).toBe(false);
    expect(next.events.map((e) => e.id)).toEqual([`${step}.0`, `${step}.1`, `${step}.2`]);
    expect(next.events[1]).toMatchObject({ status: "ok", output: "a b", endedAt: T0 + 5 });
    expect((await reader.since(next.cursor)).events).toEqual([]);
  });

  test("a quota error is a limit hit on its provider, and so is a Go key out of funds; other funds are a fatal turn error", async () => {
    const id = "ses_eedb6e092ffftZsxnpAdAADkJg";
    session(id);
    message(id, "user", { text: "hi" });
    message(id, "assistant", { time: { created: T0 + 5, completed: T0 + 6 }, model: { id: "space-bunny-free", providerID: "opencode" }, content: [], finish: "error", error: { type: "provider.quota", message: "Rate limit exceeded. Please try again later.", status: 429 } });
    message(id, "idle", { outcome: "failed" });
    message(id, "user", { text: "Continue." });
    message(id, "assistant", { time: { created: T0 + 7, completed: T0 + 8 }, model: MODEL, content: [], finish: "error", error: { type: "provider.quota", message: "Upstream request failed: Insufficient account funds", status: 402 } });
    message(id, "idle", { outcome: "failed" });
    const ref = await adapter.findTranscript(account, id);
    const { facts } = await adapter.reader(ref!).refresh();
    expect(facts.rateLimitHits).toEqual([
      { at: T0 + 5, detail: "opencode/space-bunny-free: Rate limit exceeded. Please try again later.", provider: "opencode" },
      { at: T0 + 7, detail: "opencode-go/deepseek-v4.1-flash: Upstream request failed: Insufficient account funds", provider: "opencode-go" },
    ]);
    expect(facts.turnError).toBeNull();

    message(id, "user", { text: "Continue." });
    message(id, "assistant", { time: { created: T0 + 9, completed: T0 + 10 }, model: { id: "big", providerID: "anthropic" }, content: [], finish: "error", error: { type: "api", message: "Insufficient account funds", status: 402 } });
    message(id, "idle", { outcome: "failed" });
    const after = (await adapter.reader(ref!).refresh()).facts;
    expect(after.rateLimitHits).toHaveLength(2);
    expect(after.turnError).toMatchObject({ kind: "fatal", detail: "Insufficient account funds" });
  });

  test("a question still waiting is the pending ask; its answer shows on the event", async () => {
    const id = "ses_eedb85938ffftBtU4cQIxTJVuo";
    session(id);
    message(id, "user", { text: "pick" });
    const questions = [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }];
    const at = message(id, "assistant", { model: MODEL, content: [{ type: "tool", id: "call_q", name: "question", state: { status: "running", input: { questions } } }] });
    const ref = await adapter.findTranscript(account, id);
    const reader = adapter.reader(ref!);
    expect((await reader.refresh()).facts.pendingAsk).toEqual({ id: "call_q", questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] });
    rewrite(id, at, { time: { completed: T0 + 99 }, model: MODEL, content: [{ type: "tool", id: "call_q", name: "question", state: { status: "completed", input: { questions }, metadata: { answers: [["B"]] } } }] });
    expect((await reader.refresh()).facts.pendingAsk).toBeNull();
    const ev = (await reader.timeline({ limit: 5 })).events.at(-1)!;
    expect(ev).toMatchObject({ kind: "tool", ask: { id: "call_q", answers: { "Which?": "B" } } });
  });
});

describe("opencode processes", () => {
  test("the TUI is a session; servers, one-shots and other subcommands are not", () => {
    expect(isOpencodeTui(["/home/u/.opencode/bin/opencode", "--standalone", "-s", S, "--prompt=hi"])).toBe(true);
    expect(isOpencodeTui(["opencode", "/some/dir"])).toBe(true);
    expect(isOpencodeTui(["opencode", "mini"])).toBe(true);
    expect(isOpencodeTui(["opencode", "serve", "--stdio", "--port", "0"])).toBe(false);
    expect(isOpencodeTui(["opencode", "serve", "--service"])).toBe(false);
    expect(isOpencodeTui(["opencode", "run", "hello"])).toBe(false);
    expect(isOpencodeTui(["opencode", "api", "--standalone", "POST", "/api/session"])).toBe(false);
    expect(isOpencodeTui(["omp", "-r", "x"])).toBe(false);
    expect(parseOpencodeArgv(["opencode", "--prompt", "run", "proj"])).toEqual({ sub: null, dir: "proj", session: null });
    expect(parseOpencodeArgv(["opencode", "--session=ses_x"]).session).toBe("ses_x");
  });

  test("attribution: -s first, then the newest session touched in its directory since it started", () => {
    const rows = [
      { id: "a", parent_id: null, directory: "/w", title: null, model: null, time_created: 100, time_updated: 100, time_idle: null, time_viewed: null },
      { id: "b", parent_id: null, directory: "/w", title: null, model: null, time_created: 50_000, time_updated: 50_000, time_idle: null, time_viewed: null },
      { id: "c", parent_id: null, directory: "/x", title: null, model: null, time_created: 1, time_updated: 1, time_idle: 60_000, time_viewed: null },
    ];
    const ids = attributeOpencode(
      [
        { pid: 1, cwd: "/w", startedAt: 40_000, session: "a" },
        { pid: 2, cwd: "/w", startedAt: 45_000, session: null },
        { pid: 3, cwd: "/w", startedAt: 46_000, session: "gone" },
        { pid: 4, cwd: "/x", startedAt: 59_000, session: null },
      ],
      { exists: (id) => rows.some((r) => r.id === id), touchedSince: (ms) => rows.filter((r) => Math.max(r.time_created, r.time_idle ?? 0) >= ms) },
    );
    expect(Object.fromEntries(ids)).toEqual({ 1: "a", 2: null, 3: "b", 4: "c" });
  });
});

describe("opencode launching", () => {
  test("ids are opencode's: newest sorts first", () => {
    const a = newSessionId(T0);
    const b = newSessionId(T0 + 1000);
    expect(a).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(b < a).toBe(true);
  });

  test("spawn makes the session with its model and variant, then opens it standalone", () => {
    const briefingFile = join(dir, "briefing.md");
    const cmd = adapter.spawnCommand({ account, cwd: "/w", briefingFile, model: "opencode-go/deepseek-v4.1-flash", effort: "max", autoApprove: true });
    expect(cmd.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const [body, id, ...flags] = cmd.argv.slice(4);
    expect(id).toBe(cmd.agentSessionId!);
    expect(JSON.parse(body!)).toEqual({ id, location: { directory: "/w" }, model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" } });
    expect(flags).toEqual(["--standalone", "--auto"]);
    expect(JSON.parse(cmd.env.OPENCODE_CONFIG_CONTENT!).instructions).toEqual([briefingFile]);
  });

  test("resume opens the session, switching its model first only when asked for another", () => {
    expect(adapter.resumeCommand({ account, agentSessionId: S, cwd: "/w", autoApprove: false }).argv).toEqual(["opencode", "-s", S, "--standalone"]);
    expect(adapter.resumeCommand({ account, agentSessionId: S, cwd: "/w", autoApprove: false, effort: "high" }).argv[0]).toBe("opencode");
    const sw = adapter.resumeCommand({ account, agentSessionId: S, cwd: "/w", autoApprove: true, effort: "max" }).argv;
    expect(sw.slice(3)).toEqual(["opencode", S, JSON.stringify({ model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" } }), "--standalone", "--auto"]);
    expect(modelRef("opencode-go/mimo#low")).toEqual({ providerID: "opencode-go", id: "mimo", variant: "low" });
    expect(modelRef("bare")).toBeNull();
  });

  test("blockedOn reads the permission dialog, the question form and a missing login", () => {
    expect(adapter.blockedOn!("△ Permission required\n  Read file /etc/hostname\n Allow once   Always allow   Reject")).toBe("permission");
    expect(adapter.blockedOn!("Which?\n ↑↓ select enter choose tab next esc dismiss")).toBe("asking a question");
    expect(adapter.blockedOn!("Build · Connect a provider")).toBe("login");
    expect(adapter.blockedOn!("Build · DeepSeek V4.1 Flash OpenCode Go · high")).toBeNull();
  });
});
