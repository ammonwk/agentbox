import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../types";
import { createDevinAdapter, devinSessionProcs, devinSubcommand, heldLocks, windsurfKeyOf } from "../devin";
import { closeDevinDbs } from "../devin-db";
import { parseDevinRateLimits } from "../devin-transcript";
import { costEquiv } from "../../pricing";

afterAll(closeDevinDbs);

const T0 = Date.UTC(2026, 8, 22, 15, 0, 0); // ms
const sec = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

function fixture() {
  const data = mkdtempSync(join(tmpdir(), "devin-data-"));
  const cli = join(data, "devin", "cli");
  for (const d of ["transcripts", "session_locks", "logs"]) mkdirSync(join(cli, d), { recursive: true });
  const db = new Database(join(cli, "sessions.db"));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL DEFAULT 'windsurf',
      model TEXT NOT NULL, agent_mode TEXT NOT NULL DEFAULT 'bypass', created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, title TEXT, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL, is_shell INTEGER NOT NULL DEFAULT 0);
  `);
  const adapter = createDevinAdapter({ dataHome: () => data });
  const session = (id: string, created: number, activity: number, title = "A title", hidden = 0) =>
    db.query("INSERT OR REPLACE INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden) VALUES (?, '/work/proj', 'swe-2-max', ?, ?, ?, ?)").run(id, sec(created), sec(activity), title, hidden);
  const prompt = (id: string, content: string, at: number, shell = 0) =>
    db.query("INSERT INTO prompt_history (content, timestamp, session_id, is_shell) VALUES (?, ?, ?, ?)").run(content, sec(at), id, shell);
  const transcript = (id: string, steps: unknown[]) =>
    writeFileSync(join(cli, "transcripts", `${id}.json`), JSON.stringify({ schema_version: "ATIF-v1.7", session_id: id, agent: { name: "devin", model_name: "SWE-2 Max" }, steps }));
  return { data, cli, db, adapter, session, prompt, transcript };
}

function acct(home: string, isDefault = true, id = "devin-default"): Account {
  return { id, provider: "devin", label: id, email: null, plan: null, home, isDefault, enabled: true, createdAt: 0 };
}

const steps = [
  { step_id: 1, timestamp: iso(T0), source: "system", message: "You are Devin" },
  { step_id: 2, timestamp: iso(T0 + 2000), source: "user", message: "list the files" },
  {
    step_id: 3,
    timestamp: iso(T0 + 4000),
    source: "agent",
    message: "",
    model_name: "claude-fable-5-1-high",
    reasoning_content: "I should run ls",
    tool_calls: [{ tool_call_id: "call_1", function_name: "exec", arguments: { command: "ls -la" } }],
    observation: { results: [{ source_call_id: "call_1", content: "a.txt\nb.txt" }] },
    metrics: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 600, extra: { cache_creation_input_tokens: 100 } },
  },
  {
    step_id: 4,
    timestamp: iso(T0 + 6000),
    source: "agent",
    message: "Two files.",
    model_name: "claude-fable-5-1-high",
    tool_calls: [],
    metrics: { prompt_tokens: 1200, completion_tokens: 10, cached_tokens: 1100 },
  },
];

describe("devin transcripts", () => {
  test("lists sessions and folds an ATIF export into facts and events", async () => {
    const f = fixture();
    f.session("bristle-aerosteon", T0, T0 + 6000);
    f.session("gone-away", T0, T0 + 6000, "hidden", 1);
    f.prompt("bristle-aerosteon", "list the files", T0 + 2000);
    f.prompt("bristle-aerosteon", "!ls", T0 + 2500, 1);
    f.transcript("bristle-aerosteon", steps);
    const a = acct(f.data);

    const refs = await f.adapter.listTranscripts(a, T0 - 1000);
    expect(refs.map((r) => r.agentSessionId)).toEqual(["bristle-aerosteon"]);
    expect(refs[0]!.path).toBe(join(f.cli, "transcripts", "bristle-aerosteon.json"));
    expect(await f.adapter.listTranscripts(a, T0 + 60_000)).toEqual([]);
    // devin records no account per session; see devin.ts.
    expect(await f.adapter.listTranscripts(acct("/elsewhere", false, "other"), 0)).toEqual([]);

    const r = f.adapter.reader(refs[0]!);
    const { changed, facts } = await r.refresh();
    expect(changed).toBe(true);
    expect(facts.agentSessionId).toBe("bristle-aerosteon");
    expect(facts.cwd).toBe("/work/proj");
    expect(facts.resumeCwd).toBe("/work/proj");
    expect(facts.title).toBe("A title");
    expect(facts.firstPrompt).toBe("list the files");
    expect(facts.lastPrompt).toBe("list the files");
    expect(facts.lastMessage).toBe("Two files.");
    expect(facts.model).toBe("claude-fable-5-1-high");
    expect(facts.turnOpen).toBe(false);
    expect(facts.contextUsed).toBe(1210);
    expect(facts.startedAt).toBe(T0);
    // prompt_tokens includes cache reads and writes.
    expect(facts.tokens).toEqual({
      input: 300 + 100,
      output: 60,
      cacheRead: 1700,
      cacheWrite: 100,
      costEquiv:
        costEquiv("claude-fable-5-1-high", { input: 300, output: 50, cacheRead: 600, cacheWrite: 100 }) +
        costEquiv("claude-fable-5-1-high", { input: 100, output: 10, cacheRead: 1100, cacheWrite: 0 }),
    });
    expect((await r.refresh()).changed).toBe(false);

    const page = await r.timeline({ limit: 10 });
    expect(page.events.map((e) => `${e.id}:${e.kind}`)).toEqual(["s2.u:user", "s3.r:thinking", "s3.t0:tool", "s4.m:assistant"]);
    const tool = page.events[2]!;
    expect(tool.kind === "tool" && [tool.name, tool.summary, tool.output, tool.status]).toEqual(["exec", "ls -la", "a.txt\nb.txt", "ok"]);
    expect(page.before).toBeNull();
    expect(page.cursor).toBe("s4.m");
    const older = await r.timeline({ before: "s3.t0", limit: 1 });
    expect(older.events.map((e) => e.id)).toEqual(["s3.r"]);
    expect(older.before).toBe("s3.r");
  });

  test("a prompt newer than the export is a turn in progress", async () => {
    const f = fixture();
    f.session("peat-singer", T0, T0 + 6000);
    f.prompt("peat-singer", "list the files", T0 + 2000);
    f.transcript("peat-singer", steps);
    const [ref] = await f.adapter.listTranscripts(acct(f.data), 0);
    const r = f.adapter.reader(ref!);
    await r.refresh();
    const cursor = (await r.timeline({ limit: 50 })).cursor;

    f.prompt("peat-singer", "now delete them", T0 + 60_000);
    let { changed, facts } = await r.refresh();
    expect(changed).toBe(true);
    expect(facts.turnOpen).toBe(true);
    expect(facts.lastPrompt).toBe("now delete them");
    expect(facts.lastActivityAt).toBe(T0 + 60_000);
    const inc = await r.since(cursor);
    expect(inc.reset).toBe(false);
    expect(inc.events.map((e) => [e.kind, (e as { text: string }).text])).toEqual([["user", "now delete them"]]);

    // The turn ends: the export is rewritten and the pending prompt becomes a
    // real step, so the cursor pointing at the pending event is a reset.
    f.transcript("peat-singer", [
      ...steps,
      { step_id: 5, timestamp: iso(T0 + 60_500), source: "user", message: "now delete them" },
      { step_id: 6, timestamp: iso(T0 + 61_000), source: "agent", message: "Deleted.", metrics: { prompt_tokens: 10, completion_tokens: 1, cached_tokens: 0 } },
    ]);
    utimesSync(join(f.cli, "transcripts", "peat-singer.json"), new Date(), new Date(Date.now() + 5000));
    ({ facts } = await r.refresh());
    expect(facts.turnOpen).toBe(false);
    const after = await r.since(inc.cursor);
    expect(after.reset).toBe(true);
    expect(after.events.at(-1)!.id).toBe("s6.m");
  });

  test("a session with no export is read from the database", async () => {
    const f = fixture();
    f.session("aged-tumble", T0, T0);
    f.prompt("aged-tumble", "Reply with OK", T0);
    const a = acct("/other/home", false, "second");
    const ref = (await f.adapter.findTranscript(a, "aged-tumble"))!;
    expect(ref.accountId).toBe("second");
    expect(ref.path).toBe(join(f.cli, "sessions.db"));
    const { facts } = await f.adapter.reader(ref).refresh();
    expect(facts.firstPrompt).toBe("Reply with OK");
    expect(facts.model).toBe("swe-2-max");
    // Sent in the second the session was created: shown as possibly running;
    // the fleet decides with process liveness.
    expect(facts.turnOpen).toBe(true);
    const page = await f.adapter.reader(ref).timeline({ limit: 5 });
    expect(page.events.map((e) => e.kind)).toEqual(["user"]);
    expect(await f.adapter.findTranscript(a, "no-such-session")).toBeNull();
  });

  test("rate-limit hits come from the log of the process that held the lock", async () => {
    const f = fixture();
    f.session("lead-sandal", T0, T0 + 6000);
    f.transcript("lead-sandal", steps);
    writeFileSync(join(f.cli, "session_locks", "lead-sandal.lock"), "4242");
    const log = join(f.cli, "logs", "devin_20260922-090000_4242.log");
    const rl = "Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 3 seconds.";
    writeFileSync(
      log,
      [
        `2026-09-16T02:45:50.000000Z  WARN affogato::agent::control_loop: attempt=1 max=3 error=Inference(ServerError(message=${rl} (trace ID: a))) retrying`,
        `2026-09-16T02:45:56.459731Z ERROR affogato::agent::control_loop: attempts=3 error=Inference(ServerError(message=${rl} (trace ID: b))) Exhausted inference retries; stopping turn`,
        `2026-09-16T02:45:56.487632Z ERROR affogato::agent::control_loop: attempts=3 error=Inference(ServerError(message=${rl} (trace ID: c))) Exhausted inference retries; stopping turn`,
        `2026-09-16T02:46:00.000000Z ERROR chisel_api::telemetry::manager: failed to fetch plan info: Connection failed`,
        "",
      ].join("\n"),
    );
    const [ref] = await f.adapter.listTranscripts(acct(f.data), 0);
    const r = f.adapter.reader(ref!);
    let { facts } = await r.refresh();
    expect(facts.rateLimitHits).toEqual([{ at: Date.parse("2026-09-16T02:45:56.459Z"), detail: rl }]);

    writeFileSync(log, `2026-09-16T03:00:00.000000Z ERROR x: error=Inference(ServerError(message=Quota exhausted (trace ID: d)))\n`, { flag: "a" });
    ({ facts } = await r.refresh());
    expect(facts.rateLimitHits.map((h) => h.detail)).toEqual([rl, "Quota exhausted"]);
  });

  test("parseDevinRateLimits ignores retries and unrelated errors", () => {
    expect(parseDevinRateLimits("2026-09-16T02:45:50Z  WARN x: rate limit\n2026-09-16T02:45:50Z ERROR y: boom\n")).toEqual([]);
  });
});

describe("devin processes and commands", () => {
  test("subcommands, and which process reports which session", () => {
    expect(devinSubcommand(["devin"])).toBeNull();
    expect(devinSubcommand(["/x/bin/devin", "--model", "acp", "--", "acp"])).toBeNull();
    expect(devinSubcommand(["devin", "-r", "lead-sandal"])).toBeNull();
    expect(devinSubcommand(["devin", "acp"])).toBe("acp");
    expect(devinSubcommand(["devin", "--config", "c.json", "list", "--format", "json"])).toBe("list");

    const procs = [
      { pid: 10, ppid: 1, argv: ["devin", "-r", "lead-sandal"] },
      { pid: 11, ppid: 10, argv: ["/x/devin", "acp"] },
      { pid: 20, ppid: 1, argv: ["devin"] },
      { pid: 21, ppid: 20, argv: ["/x/devin", "acp"] },
      { pid: 30, ppid: 99, argv: ["devin", "acp"] },
      { pid: 40, ppid: 98, argv: ["devin", "acp"] },
      { pid: 50, ppid: 1, argv: ["devin", "list"] },
    ];
    const held = new Map([
      ["lead-sandal", 11],
      ["zed-session", 30],
    ]);
    expect(devinSessionProcs(procs, held)).toEqual([
      { pid: 10, ids: ["lead-sandal"] },
      { pid: 20, ids: [] },
      { pid: 30, ids: ["zed-session"] },
    ]);
  });

  test("a lock proves a session only for a live devin that predates it", () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-locks-"));
    const now = Date.now();
    const lock = (id: string, pid: number, mtime: number) => {
      const p = join(dir, `${id}.lock`);
      writeFileSync(p, `${pid}\n`);
      utimesSync(p, mtime / 1000, mtime / 1000);
    };
    lock("live", 100, now - 1000);
    lock("stale", 100, now - 3_600_000); // before pid 100 started: a dead holder
    lock("reused", 200, now - 60_000); // pid 200 started after this was written
    lock("dead", 300, now);
    const starts: Record<number, number> = { 100: now - 10_000, 200: now - 5_000 };
    const held = heldLocks(dir, [100, 200], (pid) => starts[pid] ?? null);
    expect([...held]).toEqual([["live", 100]]);
    expect(heldLocks(dir, [], () => 0).size).toBe(0);
  });

  test("account environment", () => {
    const home = mkdtempSync(join(tmpdir(), "devin-acct-"));
    const a = createDevinAdapter({ dataHome: () => "/unused" });
    expect(a.accountCommand(acct("/unused"))).toEqual({ env: {}, unset: ["WINDSURF_API_KEY"] });
    expect(() => a.accountCommand(acct(home, false, "second"))).toThrow(/log in again/);
    mkdirSync(join(home, "devin"), { recursive: true });
    writeFileSync(join(home, "devin", "credentials.toml"), 'windsurf_api_key = "test-key-not-real"\napi_server_url = "https://example.invalid"\n');
    expect(windsurfKeyOf(home)).toBe("test-key-not-real");
    expect(a.accountCommand(acct(home, false, "second"))).toEqual({ env: { WINDSURF_API_KEY: "test-key-not-real" } });
    expect(a.defaultHome()).toBe("/unused");
  });

  test("argv, dialogs", () => {
    const a = createDevinAdapter({ dataHome: () => "/unused" });
    const base = { account: acct("/unused"), cwd: "/work", autoApprove: true };
    const spawn = a.spawnCommand({ ...base, prompt: "-fix it", model: "swe-2-max" });
    expect(spawn.argv).toEqual(["devin", "--model", "swe-2-max", "--permission-mode", "dangerous", "--", "-fix it"]);
    expect(spawn.agentSessionId).toBeNull();
    expect(a.resumeCommand({ ...base, autoApprove: false, agentSessionId: "lead-sandal" }).argv).toEqual(["devin", "-r", "lead-sandal"]);

    const trust = "Do you trust the authors of this directory?\n/work\n> Yes, trust\n  No, exit";
    expect(a.autoAnswer!(trust)).toEqual(["Enter"]);
    expect(a.autoAnswer!("Yes, allow once")).toBeNull();
    expect(a.blockedOn!(trust)).toBe("folder trust");
    expect(a.blockedOn!("exec: rm -rf build\n> Yes, allow once\n  Yes, always allow\n  No, deny")).toBe("permission");
    expect(a.blockedOn!("Allow network access to example.com?")).toBe("network access");
    expect(a.blockedOn!("Quota exhausted\nPurchase on-demand usage")).toBe("usage limit");
    expect(a.blockedOn!("> ")).toBeNull();
  });
});
