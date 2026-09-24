import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../types";
import { codexAdapter, codexAutoAnswer, codexBlockedOn, codexHome, matchByCwd, parseCodexArgs, type CwdCandidate, type RolloutInfo } from "../codex";
import {
  CodexFold,
  codexLineage,
  codexOutput,
  codexPieces,
  codexUserPrompt,
  codexWindows,
  isUsageLimit,
  summarizeCodexTool,
} from "../codex-transcript";

const roots: string[] = [];
const tmp = (prefix = "codex-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};
const children: { kill(): void }[] = [];
afterAll(() => {
  for (const c of children) c.kill();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const TID = "01a0d106-dd2b-7381-974e-d4324d098396";
const PARENT = "01a0d100-0000-7000-8000-000000000000";
const CWD = "/work/repo";
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const ts = (s: number) => new Date(T0 + s * 1000).toISOString();

const meta = (over: Record<string, unknown> = {}, s = 0) => ({
  timestamp: ts(s),
  ordinal: 0,
  type: "session_meta",
  payload: { id: TID, session_id: TID, timestamp: ts(s), cwd: CWD, originator: "codex-tui", cli_version: "0.156.1", source: "cli", thread_source: "user", git: { branch: "main" }, ...over },
});
const item = (s: number, payload: Record<string, unknown>) => ({ timestamp: ts(s), type: "response_item", payload });
const ev = (s: number, payload: Record<string, unknown>) => ({ timestamp: ts(s), type: "event_msg", payload });
const userMsg = (s: number, ...texts: (string | { image: true })[]) =>
  item(s, {
    type: "message",
    role: "user",
    content: texts.map((t) => (typeof t === "string" ? { type: "input_text", text: t } : { type: "input_image", image_url: "data:" })),
  });
const asstMsg = (s: number, text: string) => item(s, { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const tokenCount = (s: number, total: Record<string, number>, last: Record<string, number>, rl: Record<string, unknown> | null = null) =>
  ev(s, { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 }, rate_limits: rl });
const u = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

const fold = (records: unknown[], titleOf?: () => string | null) => {
  const f = new CodexFold({ agentSessionId: TID }, titleOf);
  records.forEach((r, i) => f.add(r, i));
  return f.facts();
};

describe("codex user prompts", () => {
  test("injected context is not a prompt", () => {
    expect(codexUserPrompt([{ type: "input_text", text: "# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…</INSTRUCTIONS>" }])).toBeNull();
    expect(codexUserPrompt([{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }])).toBeNull();
    expect(codexUserPrompt([{ type: "input_text", text: "<recommended_plugins>\nHere is a list\n</recommended_plugins>" }])).toBeNull();
    expect(codexUserPrompt([{ type: "input_text", text: "<skill>\n<name>go</name>\n</skill>" }])).toBeNull();
    expect(codexUserPrompt([{ type: "input_text", text: "<some_new_injection attr=\"1\">body</some_new_injection>" }])).toBeNull();
    expect(codexUserPrompt([{ type: "input_text", text: "$green-and-clean 4802" }])).toEqual({ text: "$green-and-clean 4802", images: 0 });
  });

  test("a prompt with an image keeps its words and counts the image", () => {
    expect(
      codexUserPrompt([
        { type: "input_text", text: '<image name=[Image #1] path="/tmp/codex-clipboard-x.png">' },
        { type: "input_image", image_url: "data:" },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "what is this?" },
      ]),
    ).toEqual({ text: "what is this?", images: 1 });
  });
});

describe("codex facts", () => {
  test("session meta, turn context, prompts, last message, title", () => {
    const f = fold(
      [
        meta(),
        ev(1, { type: "task_started", turn_id: "t1", model_context_window: 258400 }),
        item(1, { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] }),
        userMsg(1, "# AGENTS.md instructions for /work/repo\n<INSTRUCTIONS>x</INSTRUCTIONS>"),
        { timestamp: ts(2), type: "turn_context", payload: { cwd: "/work/repo/sub", model: "gpt-5.6-sol" } },
        userMsg(2, "fix the tests"),
        asstMsg(3, "on it"),
        ev(4, { type: "task_complete", turn_id: "t1" }),
        ev(5, { type: "task_started", turn_id: "t2" }),
        userMsg(5, "and the lint"),
      ],
      () => "My thread",
    );
    expect(f).toMatchObject({
      agentSessionId: TID,
      cwd: "/work/repo/sub",
      resumeCwd: "/work/repo/sub",
      model: "gpt-5.6-sol",
      gitBranch: "main",
      firstPrompt: "fix the tests",
      lastPrompt: "and the lint",
      lastMessage: "on it",
      title: "My thread",
      turnOpen: true,
      contextLimit: 258400,
      startedAt: T0,
      lastActivityAt: T0 + 5000,
      isSubagent: false,
      parentId: null,
    });
  });

  test("tokens: cached input is taken out of input; reasoning stays in output", () => {
    const f = fold([
      meta(),
      tokenCount(1, u(25924, 11008, 204, 138), u(25924, 11008, 204, 138)),
      tokenCount(2, u(60000, 40000, 500, 300), u(34076, 28992, 296, 162)),
    ]);
    expect(f.tokens).toMatchObject({ input: 20000, cacheRead: 40000, output: 500, cacheWrite: 0 });
    expect(f.tokens.costEquiv).toBeGreaterThan(0);
    expect(f.contextUsed).toBe(34076 + 296);
    expect(f.contextLimit).toBe(258400);
  });

  test("tokens: a total that restarts (a new process) adds instead of going backwards", () => {
    const f = fold([meta(), tokenCount(1, u(1000, 0, 100), u(1000, 0, 100)), tokenCount(2, u(300, 0, 10), u(300, 0, 10))]);
    expect(f.tokens.input).toBe(1300);
    expect(f.tokens.output).toBe(110);
  });

  test("rate limits become usage windows; a reached limit is one hit per episode", () => {
    const rl = (pct: number, reached: string | null = null) => ({
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: pct, window_minutes: 10080, resets_at: 1790715541 },
      secondary: { used_percent: 12, window_minutes: 300, resets_at: 1790300000 },
      plan_type: "pro",
      rate_limit_reached_type: reached,
    });
    const f = fold([
      meta(),
      tokenCount(1, u(1, 0, 1), u(1, 0, 1), rl(40)),
      tokenCount(2, u(2, 0, 2), u(1, 0, 1), rl(100, "primary")),
      tokenCount(3, u(3, 0, 3), u(1, 0, 1), rl(100, "primary")),
      tokenCount(4, u(4, 0, 4), u(1, 0, 1), rl(10)),
      tokenCount(5, u(5, 0, 5), u(1, 0, 1), { limit_id: "codex_bengalfox", limit_name: "GPT-5.3-Codex-Spark", primary: { used_percent: 3, window_minutes: 10080, resets_at: 1 } }),
    ]);
    expect(f.rateLimitHits).toEqual([{ at: T0 + 2000, detail: "rate limit reached: primary" }]);
    expect(f.usage?.at).toBe(T0 + 5000);
    expect(f.usage?.windows).toEqual([
      { id: "weekly", kind: "weekly", label: "Weekly", usedPct: 10, resetsAt: 1790715541000, windowMs: 604800000 },
      { id: "five_hour", kind: "short", label: "5-hour", usedPct: 12, resetsAt: 1790300000000, windowMs: 18000000 },
      { id: "weekly:codex_bengalfox", kind: "weekly", label: "Weekly · GPT-5.3-Codex-Spark", usedPct: 3, resetsAt: 1000, windowMs: 604800000, scope: { model: "GPT-5.3-Codex-Spark" } },
    ]);
  });

  test("a usage-limit refusal on task_complete is a hit; a per-minute API limit is not", () => {
    const f = fold([
      meta(),
      ev(1, { type: "task_started" }),
      ev(2, {
        type: "task_complete",
        error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 2:16 AM.", codex_error_info: "usage_limit_exceeded" },
      }),
      ev(3, { type: "task_complete", error: { message: "stream disconnected before completion: Rate limit reached for gpt-x on tokens per min (TPM)", codex_error_info: "other" } }),
      ev(4, { type: "error", message: "You've hit your usage limit. Try again later." }),
    ]);
    expect(f.rateLimitHits.map((h) => h.at)).toEqual([T0 + 2000, T0 + 4000]);
    expect(f.turnOpen).toBe(false);
    expect(isUsageLimit({ codex_error_info: "usage_limit_exceeded" })).toBe(true);
  });

  test("turn_aborted closes the turn", () => {
    expect(fold([meta(), ev(1, { type: "task_started" }), ev(2, { type: "turn_aborted", reason: "interrupted" })]).turnOpen).toBe(false);
  });

  test("a forked subagent: flagged with its parent, inherited history ignored", () => {
    const sub = meta({
      id: TID,
      session_id: PARENT,
      forked_from_id: PARENT,
      parent_thread_id: PARENT,
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: "Kuhn" } } },
      thread_source: "subagent",
      subagent_history_start_ordinal: 3,
    });
    const f = fold([
      sub,
      { ...meta({ id: PARENT }), ordinal: 1 },
      { ...userMsg(1, "parent's prompt"), ordinal: 2 },
      { ...tokenCount(1, u(9999, 0, 9999), u(9999, 0, 9999)), ordinal: 2 },
      { ...asstMsg(5, "sub work"), ordinal: 4 },
      { ...tokenCount(6, u(100, 0, 10), u(100, 0, 10)), ordinal: 5 },
    ]);
    expect(f.isSubagent).toBe(true);
    expect(f.parentId).toBe(PARENT);
    expect(f.firstPrompt).toBeNull();
    expect(f.tokens.input).toBe(100);
    expect(f.cwd).toBe(CWD);
    expect(codexLineage(meta({ source: { subagent: { other: "guardian" } } }))).toMatchObject({ isSubagent: true, parentId: null });
  });
});

describe("codex windows", () => {
  test("shapes", () => {
    expect(codexWindows({ primary: { used_percent: 5, window_minutes: 1440, resets_at: null } })).toEqual([
      { id: "daily", kind: "daily", label: "Daily", usedPct: 5, resetsAt: null, windowMs: 86400000 },
    ]);
    expect(codexWindows({ limit_id: "premium", primary: null, secondary: null })).toEqual([]);
    expect(codexWindows(null)).toEqual([]);
    expect(codexWindows({ primary: { used_percent: 1, window_minutes: 43200 } })[0]).toMatchObject({ id: "43200m", kind: "monthly", label: "30-day" });
  });
});

describe("codex tools", () => {
  test("summaries", () => {
    expect(summarizeCodexTool("exec_command", { cmd: "git status", workdir: "/x" })).toBe("git status");
    expect(summarizeCodexTool("exec", 'const r = await tools.exec_command({"cmd":"rg -n foo","workdir":"/x"}); text(r.output);\n')).toBe("rg -n foo");
    expect(summarizeCodexTool("exec", "const r = await tools.exec_command({cmd: 'ls -la'});")).toBe("ls -la");
    expect(summarizeCodexTool("shell", { command: ["bash", "-lc", "make test"] })).toBe("make test");
    expect(summarizeCodexTool("apply_patch", "*** Begin Patch\n*** Update File: /r/a.ts\n@@\n*** Add File: /r/b.ts\n+x\n*** End Patch")).toBe("U /r/a.ts, A /r/b.ts");
    expect(summarizeCodexTool("update_plan", { plan: [{ step: "a", status: "completed" }, { step: "b", status: "in_progress" }] })).toBe("2 steps · b");
    expect(summarizeCodexTool("write_stdin", { session_id: 5, chars: "" })).toBe("session 5 (poll)");
    expect(summarizeCodexTool("collaboration.spawn_agent", { task_name: "scout" })).toBe("spawn scout");
    expect(summarizeCodexTool("web.run", { search_query: [{ q: "bun sqlite" }] })).toBe("bun sqlite");
  });

  test("output errors are read from the text", () => {
    expect(codexOutput("Exit code: 0\nWall time: 0 seconds\nOutput:\nok").error).toBe(false);
    expect(codexOutput("Exit code: 2\nOutput:\nboom").error).toBe(true);
    expect(codexOutput([{ type: "input_text", text: "Script failed\nWall time 1s" }]).error).toBe(true);
    expect(codexOutput([{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: "data" }])).toEqual({ text: "Script completed\n\ndata", error: false });
    expect(codexOutput("Chunk ID: 1\nWall time: 1s\nProcess exited with code 1\nOutput:\n").error).toBe(true);
    expect(codexOutput('{"output":"hi","metadata":{"exit_code":3}}')).toEqual({ text: "hi", error: true });
  });
});

describe("codex timeline pieces", () => {
  test("messages, reasoning, calls and results", () => {
    expect(codexPieces(userMsg(1, "<environment_context>x</environment_context>"), 3)).toEqual([]);
    const up = codexPieces(userMsg(1, "hello", { image: true }), 3)[0];
    expect(up?.kind === "event" && up.event).toEqual({ id: "r3", at: T0 + 1000, kind: "user", text: "hello", images: 1 });
    const th = codexPieces(item(1, { type: "reasoning", summary: [{ type: "summary_text", text: "**Plan** do x" }], encrypted_content: "gAAA" }), 4)[0];
    expect(th?.kind === "event" && th.event).toMatchObject({ kind: "thinking", text: "**Plan** do x" });
    expect(codexPieces(item(1, { type: "reasoning", summary: [], encrypted_content: "gAAA" }), 4)).toEqual([]);
    const call = codexPieces(item(1, { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" }), 5)[0];
    expect(call).toMatchObject({ kind: "call", callId: "c1", event: { id: "r5", name: "exec_command", summary: "ls", status: "running" } });
    const mcp = codexPieces(item(1, { type: "function_call", name: "find", namespace: "mcp__mongo", arguments: "{}", call_id: "c2" }), 6)[0];
    expect(mcp).toMatchObject({ event: { name: "mcp__mongo__find" } });
    expect(codexPieces(item(2, { type: "function_call_output", call_id: "c1", output: "Exit code: 1\nOutput:\nnope" }), 7)).toEqual([
      { kind: "result", callId: "c1", output: "Exit code: 1\nOutput:\nnope", error: true },
    ]);
    const ws = codexPieces(item(1, { type: "web_search_call", status: "completed", action: { type: "search", query: "codex rollout" } }), 8)[0];
    expect(ws?.kind === "event" && ws.event).toMatchObject({ kind: "tool", name: "web_search", summary: "codex rollout", status: "ok" });
  });

  test("meta: compaction, aborts, limits, inter-agent messages", () => {
    const kinds = [
      { timestamp: ts(1), type: "compacted", payload: { message: "", replacement_history: [] } },
      ev(1, { type: "turn_aborted", reason: "interrupted" }),
      ev(1, { type: "task_complete", error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } }),
      ev(1, { type: "token_count", info: null, rate_limits: { rate_limit_reached_type: "primary" } }),
      item(1, { type: "agent_message", author: "/root", recipient: "/root/scout", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/scout" }, { type: "encrypted_content" }] }),
    ].map((r, i) => codexPieces(r, i)[0]);
    expect(kinds.map((p) => (p?.kind === "event" && p.event.kind === "meta" ? [p.event.text, p.event.tone] : null))).toEqual([
      ["context compacted", "info"],
      ["turn aborted (interrupted)", "warn"],
      ["You've hit your usage limit.", "warn"],
      ["rate limit reached: primary", "warn"],
      ["/root → /root/scout: new task", "info"],
    ]);
    expect(codexPieces(ev(1, { type: "item_completed", item: { type: "AgentMessage" } }), 0)).toEqual([]);
  });
});

describe("codex argv", () => {
  test("parseCodexArgs", () => {
    expect(parseCodexArgs([])).toEqual({ sub: undefined, resumeId: null, cd: null });
    expect(parseCodexArgs(["--dangerously-bypass-approvals-and-sandbox", "fix it"])).toMatchObject({ sub: undefined });
    expect(parseCodexArgs(["-m", "gpt-5", "resume", TID, "go on"])).toEqual({ sub: "resume", resumeId: TID, cd: null });
    expect(parseCodexArgs(["resume", "--last"])).toMatchObject({ sub: "resume", resumeId: null });
    expect(parseCodexArgs(["-c", "features.x=true", "app-server", "--analytics-default-enabled"])).toMatchObject({ sub: "app-server" });
    expect(parseCodexArgs(["exec", "--json", "hi"])).toMatchObject({ sub: "exec" });
    expect(parseCodexArgs(["-C", "/w/x", "hello"])).toMatchObject({ sub: undefined, cd: "/w/x" });
    expect(parseCodexArgs(["--cd=/w/y"])).toMatchObject({ cd: "/w/y" });
    // A prompt that happens to be a word codex does not know is a prompt.
    expect(parseCodexArgs(["review this please"])).toMatchObject({ sub: undefined });
  });
});

// ---------------------------------------------------------------- on disk

const account = (home: string, over: Partial<Account> = {}): Account => ({
  id: "acct-x",
  provider: "codex",
  label: "x",
  email: null,
  plan: null,
  home,
  isDefault: false,
  enabled: true,
  createdAt: 0,
  ...over,
});
const pad = (n: number) => String(n).padStart(2, "0");
function rolloutPath(home: string, at: Date, id: string): string {
  const dir = join(home, "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  mkdirSync(dir, { recursive: true });
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return join(dir, `rollout-${stamp}-${id}.jsonl`);
}
const writeJsonl = (path: string, records: unknown[]) => writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
const appendJsonl = (path: string, records: unknown[]) => appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
const id = (n: number) => `01a0d1${String(n).padStart(2, "0")}-0000-7000-8000-000000000000`;

describe("codex on disk", () => {
  test("listTranscripts walks day directories newest first, by mtime, within the lookback", async () => {
    const home = tmp();
    const now = new Date();
    const today = rolloutPath(home, now, id(1));
    const threeDays = rolloutPath(home, new Date(now.getTime() - 3 * 86400_000), id(2));
    const ancient = rolloutPath(home, new Date(now.getTime() - 40 * 86400_000), id(3));
    for (const p of [today, threeDays, ancient]) writeJsonl(p, [meta()]);
    const t = now.getTime() / 1000;
    utimesSync(threeDays, t - 3 * 86400, t - 3 * 86400);
    writeFileSync(join(home, "sessions", "stray.txt"), "");
    let refs = await codexAdapter.listTranscripts(account(home), now.getTime() - 3600_000);
    expect(refs.map((r) => r.agentSessionId)).toEqual([id(1)]);
    expect(refs[0]).toMatchObject({ provider: "codex", accountId: "acct-x", path: today });
    // Still being appended to three days on: found.
    utimesSync(threeDays, t, t);
    refs = await codexAdapter.listTranscripts(account(home), now.getTime() - 3600_000);
    expect(refs.map((r) => r.agentSessionId).sort()).toEqual([id(1), id(2)]);
    // Beyond the lookback it is found by id only.
    expect((await codexAdapter.listTranscripts(account(home), now.getTime() - 3600_000)).some((r) => r.path === ancient)).toBe(false);
    expect((await codexAdapter.findTranscript(account(home), id(3)))?.path).toBe(ancient);
    expect(await codexAdapter.findTranscript(account(home), id(9))).toBeNull();
  });

  test("reader: facts, title from session_index, paging and a result re-sent", async () => {
    const home = tmp();
    const path = rolloutPath(home, new Date(), TID);
    writeJsonl(path, [
      meta(),
      ev(1, { type: "task_started" }),
      userMsg(1, "list files"),
      item(2, { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" }),
    ]);
    writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ id: TID, thread_name: "old name" })}\n${JSON.stringify({ id: TID, thread_name: "Listing" })}\n`);
    const r = codexAdapter.reader({ provider: "codex", accountId: "a", agentSessionId: TID, path, mtimeMs: 0, size: 0 });
    let res = await r.refresh();
    expect(res.facts).toMatchObject({ title: "Listing", turnOpen: true, firstPrompt: "list files" });
    const page = await r.timeline({ limit: 50 });
    expect(page.events.map((e) => e.kind)).toEqual(["user", "tool"]);
    appendJsonl(path, [item(3, { type: "function_call_output", call_id: "c1", output: "Exit code: 0\nOutput:\na\nb" }), asstMsg(4, "two files"), ev(5, { type: "task_complete" })]);
    const s = await r.since(page.cursor);
    expect(s.events.map((e) => e.kind)).toEqual(["tool", "assistant"]);
    expect(s.events[0]).toMatchObject({ id: "r3", status: "ok", output: "Exit code: 0\nOutput:\na\nb" });
    res = await r.refresh();
    expect(res.facts.turnOpen).toBe(false);
    expect(res.facts.lastMessage).toBe("two files");
  });

  test("the default account is ~/.codex and never inherits the server's CODEX_HOME", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/someone";
    try {
      expect(codexHome(account("/x", { isDefault: true }))).toBe("/tmp/someone/.codex");
    } finally {
      process.env.HOME = prev;
    }
    expect(codexAdapter.accountCommand(account("/x", { isDefault: true }))).toEqual({ env: {}, unset: ["CODEX_HOME"] });
    expect(codexAdapter.accountCommand(account("/acct"))).toEqual({ env: { CODEX_HOME: "/acct" } });
  });
});

describe("codex process identity by cwd", () => {
  const lineage = (over: Partial<RolloutInfo["lineage"]> = {}): RolloutInfo["lineage"] => ({
    id: null,
    cwd: CWD,
    startedAt: null,
    source: "cli",
    originator: "codex-tui",
    isSubagent: false,
    parentId: null,
    inheritedBefore: -1,
    ...over,
  });
  const ro = (n: number, start: number, over: Partial<RolloutInfo["lineage"]> = {}): RolloutInfo => ({ id: id(n), start, lineage: lineage(over) });
  const cand = (startedAt: number, over: Partial<CwdCandidate> = {}): CwdCandidate => ({ home: "/h", cwd: CWD, kind: "tui", startedAt, id: null, ...over });

  test("one process, one rollout after it: matched", () => {
    const a = cand(100_000);
    matchByCwd([a], () => [ro(1, 50_000), ro(2, 120_000)]);
    expect(a.id).toBe(id(2));
  });

  test("two processes that could both have written it: neither is guessed", () => {
    const a = cand(100_000);
    const b = cand(101_000);
    matchByCwd([a, b], () => [ro(1, 120_000)]);
    expect([a.id, b.id]).toEqual([null, null]);
  });

  test("staggered starts resolve one by one", () => {
    const a = cand(100_000);
    const b = cand(200_000);
    matchByCwd([a, b], () => [ro(1, 120_000), ro(2, 220_000)]);
    expect([a.id, b.id]).toEqual([id(1), id(2)]);
  });

  test("subagents, exec rollouts, other directories and claimed rollouts are not candidates", () => {
    const a = cand(1000);
    const known = cand(0, { id: id(4) });
    matchByCwd([a, known], () => [ro(1, 2000, { isSubagent: true }), ro(2, 2100, { source: "exec" }), ro(3, 2200, { cwd: "/elsewhere" }), ro(4, 2300), ro(5, 2400)]);
    expect(a.id).toBe(id(5));
    const e = cand(1000, { kind: "exec" });
    matchByCwd([e], () => [ro(1, 2000), ro(2, 2100, { source: "exec" })]);
    expect(e.id).toBe(id(2));
  });
});

// ------------------------------------------------ live processes (fake codex)

/** A process whose argv reads `codex -c <script> <args>`: bash renamed, so
 *  `-c` and its script parse as a codex config override and the rest as
 *  codex's own arguments. */
async function fakeCodex(home: string, cwd: string, args: string, pre = ""): Promise<number> {
  const script = `${pre} exec -a codex bash -c 'sleep 30; :' ${args}`;
  const proc = Bun.spawn(["bash", "-c", script], { cwd, env: { ...process.env, CODEX_HOME: home }, stdout: "ignore", stderr: "ignore" });
  children.push(proc);
  for (let i = 0; i < 100; i++) {
    try {
      if (readFileSync(`/proc/${proc.pid}/cmdline`, "utf8").startsWith("codex\0")) return proc.pid;
    } catch {
      /* not yet */
    }
    await Bun.sleep(20);
  }
  throw new Error("fake codex did not start");
}

describe("codex liveProcesses", () => {
  test("identity from argv, an open writer lock, the log database, and the cwd", async () => {
    const home = tmp();
    const work = tmp("codex-work-");
    const acct = account(home);

    const resumed = await fakeCodex(home, work, `resume ${id(11)}`);

    const lockDir = join(home, "thread-writer-locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `${id(12)}.lock`), "");
    const locked = await fakeCodex(home, work, "", `exec 3<"${join(lockDir, `${id(12)}.lock`)}";`);

    const logged = await fakeCodex(home, work, "--model x");
    const db = new Database(join(home, "logs_2.sqlite"));
    db.run("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, process_uuid TEXT, thread_id TEXT)");
    db.run("INSERT INTO logs (ts, process_uuid, thread_id) VALUES (?1, ?2, NULL), (?1, ?2, ?3)", [Math.floor(Date.now() / 1000), `pid:${logged}:abc`, id(13)]);
    db.close();

    const other = tmp("codex-other-");
    const byCwd = await fakeCodex(home, other, "");
    // Its rollout, written after it started.
    await Bun.sleep(50);
    writeJsonl(rolloutPath(home, new Date(), id(14)), [meta({ id: id(14), cwd: other, timestamp: new Date().toISOString() })]);

    const server = await fakeCodex(home, work, "-c x=1 app-server");
    const headless = await fakeCodex(home, work, "exec hello");

    const procs = await codexAdapter.liveProcesses([acct]);
    const by = new Map(procs.map((p) => [p.pid, p]));
    expect(by.get(resumed)?.agentSessionId).toBe(id(11));
    expect(by.get(locked)?.agentSessionId).toBe(id(12));
    expect(by.get(logged)?.agentSessionId).toBe(id(13));
    expect(by.get(byCwd)).toMatchObject({ agentSessionId: id(14), cwd: other, accountId: "acct-x" });
    expect(by.has(server)).toBe(false);
    // `codex exec` with nothing to prove its session is not worth a row.
    expect(by.has(headless)).toBe(false);
    for (const p of procs) expect(p.accountId).toBe("acct-x");
  });

  test("a wrapper and the native child it runs are one session under the wrapper's pid", async () => {
    const home = tmp();
    const work = tmp("codex-work-");
    const wrapper = await fakeCodex(home, work, `resume ${id(21)}`, `(exec -a codex bash -c 'sleep 30; :' resume ${id(21)}) &`);
    let procs = await codexAdapter.liveProcesses([account(home)]);
    for (let i = 0; i < 50 && procs.length < 1; i++) {
      await Bun.sleep(20);
      procs = await codexAdapter.liveProcesses([account(home)]);
    }
    await Bun.sleep(100);
    procs = await codexAdapter.liveProcesses([account(home)]);
    expect(procs.map((p) => [p.pid, p.agentSessionId])).toEqual([[wrapper, id(21)]]);
  });

  test("processes on a home agentbox does not manage are not reported", async () => {
    const home = tmp();
    const work = tmp("codex-work-");
    const pid = await fakeCodex(home, work, `resume ${id(31)}`);
    const procs = await codexAdapter.liveProcesses([account(tmp())]);
    expect(procs.some((p) => p.pid === pid)).toBe(false);
  });
});

describe("codex commands and screens", () => {
  test("spawn and resume", () => {
    const s = codexAdapter.spawnCommand({ account: account("/h"), cwd: "/w", prompt: "go", model: "gpt-5.6-sol", autoApprove: true });
    expect(s).toEqual({ argv: ["codex", "--model", "gpt-5.6-sol", "--dangerously-bypass-approvals-and-sandbox", "go"], env: { CODEX_HOME: "/h" }, agentSessionId: null });
    const r = codexAdapter.resumeCommand({ account: account("/h", { isDefault: true }), agentSessionId: TID, cwd: "/w", prompt: "-v please", autoApprove: false });
    expect(r).toEqual({ argv: ["codex", "resume", TID, " -v please"], env: {}, unset: ["CODEX_HOME"] });
  });

  test("autoAnswer: trust, update, directory; never Update now", () => {
    const trust = "> You are in /w/x\n\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n\n› 1. Trust and continue\n  2. Open restricted\n\n  Press enter to continue";
    expect(codexAutoAnswer(trust)).toEqual(["Enter"]);
    const old = "  Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit";
    expect(codexAutoAnswer(old)).toEqual(["Enter"]);
    const update = "  ✨ Update available! 0.156.1 -> 0.157.0\n\n  Release notes: https://github.com/openai/codex/releases/latest\n\n› 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n\n  Press enter to continue";
    expect(codexAutoAnswer(update)).toEqual(["Down", "Enter"]);
    const dir = "  This session was started in /w/a.\n› 1. Use session directory (/w/a)\n  2. Use current directory (/w/b)";
    expect(codexAutoAnswer(dir)).toEqual(["Enter"]);
    expect(codexAutoAnswer("› working on it")).toBeNull();
  });

  test("blockedOn", () => {
    expect(codexBlockedOn("  Would you like to run the following command?\n\n  $ rm -rf x\n\n› 1. Yes, proceed")).toBe("approval: run command");
    expect(codexBlockedOn("Would you like to make the following edits?")).toBe("approval: apply edits");
    expect(codexBlockedOn("Welcome to Codex\n› 1. Sign in with ChatGPT\n  2. Sign in with Device Code")).toBe("login required");
    expect(codexBlockedOn("1 hook is new or changed. Hooks need review")).toBe("hooks need review");
    expect(codexBlockedOn("› Ready")).toBeNull();
  });
});
