import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../types";
import { claudeAdapter, claudeAutoAnswer, claudeBlockedOn, claudeHome, sessionIdFromArgv, SubagentTokens } from "../claude";
import {
  ClaudeFold,
  classifyUserText,
  claudePieces,
  commandLine,
  contextLimitFor,
  projectSlug,
  summarizeClaudeTool,
} from "../claude-transcript";

const roots: string[] = [];
const tmp = (prefix = "claude-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const SID = "11111111-2222-4333-8444-555555555555";
const CWD = "/work/my_repo";
let n = 0;
beforeEach(() => {
  n = 0;
});
const ts = (i: number) => new Date(Date.UTC(2026, 8, 24, 12, 0, 0) + i * 1000).toISOString();

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: `u${++n}`,
  timestamp: ts(n),
  cwd: CWD,
  sessionId: SID,
  gitBranch: "main",
  message: { role: "user", content },
  ...extra,
});
const asst = (
  blocks: unknown[],
  o: { id?: string; usage?: Record<string, unknown>; stop?: string | null; model?: string } = {},
  extra: Record<string, unknown> = {},
) => ({
  type: "assistant",
  uuid: `a${++n}`,
  timestamp: ts(n),
  cwd: CWD,
  sessionId: SID,
  message: {
    id: o.id ?? `msg_${n}`,
    model: o.model ?? "claude-opus-5",
    role: "assistant",
    content: blocks,
    stop_reason: o.stop === undefined ? null : o.stop,
    usage: o.usage,
  },
  ...extra,
});
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: unknown, isError = false) =>
  user([{ type: "tool_result", tool_use_id: id, content, is_error: isError }], { toolUseResult: {} });

const REF = { path: `/h/projects/${projectSlug(CWD)}/${SID}.jsonl`, agentSessionId: SID };
const fold = (records: unknown[], ref = REF) => {
  const f = new ClaudeFold(ref);
  for (const r of records) f.add(r);
  return f.facts();
};

describe("claude facts", () => {
  test("usage is counted once per message id, not once per content block", () => {
    const u = usage(10, 100, 1000, 50);
    const f = fold([
      user("hi"),
      asst([{ type: "thinking", thinking: "" }], { id: "m1", usage: u }),
      asst([{ type: "text", text: "hello" }], { id: "m1", usage: u }),
      asst([toolUse("t1", "Bash", { command: "ls" })], { id: "m1", usage: u, stop: "tool_use" }),
      toolResult("t1", "a\nb"),
      asst([{ type: "text", text: "done" }], { id: "m2", usage: usage(5, 20, 1100, 0), stop: "end_turn" }),
    ]);
    expect(f.tokens.input).toBe(15);
    expect(f.tokens.output).toBe(120);
    expect(f.tokens.cacheRead).toBe(2100);
    expect(f.tokens.cacheWrite).toBe(50);
    expect(f.tokens.costEquiv).toBeGreaterThan(0);
    expect(f.contextUsed).toBe(5 + 1100);
    expect(f.contextLimit).toBe(1_000_000);
    expect(f.model).toBe("claude-opus-5");
    expect(f.lastMessage).toBe("done");
    expect(f.gitBranch).toBe("main");
  });

  test("synthetic messages count nothing and do not become the model", () => {
    const f = fold([
      asst([{ type: "text", text: "x" }], { id: "m1", usage: usage(1, 1) , stop: "end_turn" }),
      asst([{ type: "text", text: "No response requested." }], { id: "s1", model: "<synthetic>", usage: usage(0, 0), stop: "stop_sequence" }),
    ]);
    expect(f.model).toBe("claude-opus-5");
    expect(f.tokens.output).toBe(1);
  });

  test("a model fallback counts both attempts, each on its own model", () => {
    const f = fold([
      asst([{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } }], {
        model: "claude-opus-4-8",
        usage: {
          ...usage(2, 2563, 116506, 0),
          iterations: [
            { ...usage(2, 317, 121913, 1384), model: "claude-fable-5" },
            { ...usage(2, 2563, 116506, 0), model: "claude-opus-4-8" },
          ],
        },
      }),
    ]);
    expect(f.tokens.output).toBe(317 + 2563);
    expect(f.tokens.cacheWrite).toBe(1384);
  });

  test("context limit: known 1M families, auto-compaction evidence, high-water mark", () => {
    expect(contextLimitFor("claude-fable-5-1", 10, 0)).toBe(1_000_000);
    expect(contextLimitFor("claude-opus-4-8", 10, 0)).toBe(1_000_000);
    expect(contextLimitFor("claude-sonnet-5", 10, 0)).toBe(1_000_000);
    expect(contextLimitFor("claude-opus-4-5-20251101", 150_000, 0)).toBe(200_000);
    expect(contextLimitFor("claude-opus-4-5-20251101", 0, 190_000)).toBe(200_000);
    expect(contextLimitFor("claude-opus-4-5-20251101", 0, 800_000)).toBe(1_000_000);
    expect(contextLimitFor("claude-sonnet-4-5-20250929", 300_000, 0)).toBe(1_000_000);
    expect(contextLimitFor("claude-opus-4-5[1m]", 0, 0)).toBe(1_000_000);
  });

  test("a manual /compact proves nothing about the window, an automatic one does", () => {
    const boundary = (trigger: string, pre: number) => ({
      type: "system",
      subtype: "compact_boundary",
      timestamp: ts(99),
      compactMetadata: { trigger, preTokens: pre, postTokens: 15_000 },
    });
    const m = "claude-opus-4-5-20251101";
    const manual = fold([asst([{ type: "text", text: "x" }], { model: m, usage: usage(1, 1, 50_000) }), boundary("manual", 60_000)]);
    expect(manual.contextLimit).toBe(200_000);
    expect(manual.contextUsed).toBe(15_000);
    const auto = fold([asst([{ type: "text", text: "x" }], { model: m, usage: usage(1, 1, 50_000) }), boundary("auto", 830_000)]);
    expect(auto.contextLimit).toBe(1_000_000);
  });

  test("turnOpen follows the transcript: prompt and tool_use open, end_turn and turn_duration close", () => {
    const f = new ClaudeFold(REF);
    const step = (r: unknown) => {
      f.add(r);
      return f.facts().turnOpen;
    };
    expect(step(user("do it"))).toBe(true);
    expect(step(asst([toolUse("t1", "Read", { file_path: "/x" })], { stop: "tool_use" }))).toBe(true);
    expect(step(toolResult("t1", "contents"))).toBe(true);
    expect(step(asst([{ type: "text", text: "ok" }], { stop: "end_turn" }))).toBe(false);
    expect(step({ type: "system", subtype: "turn_duration", timestamp: ts(50), durationMs: 5 })).toBe(false);
    expect(step(user("<task-notification>\n<summary>done</summary>\n</task-notification>"))).toBe(true);
    expect(step(asst([{ type: "text", text: "noted" }], { stop: "end_turn" }))).toBe(false);
    // An image-only prompt is a prompt too.
    expect(step(user([{ type: "image", source: {} }]))).toBe(true);
    expect(step(user([{ type: "text", text: "[Request interrupted by user]" }]))).toBe(false);
    // Slash-command wrappers and skill bodies do not open a turn by themselves.
    expect(step(user("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"))).toBe(false);
    expect(step(user("skill body", { isMeta: true }))).toBe(false);
    // A prompt typed while busy arrives as a queued_command attachment.
    expect(step({ type: "attachment", timestamp: ts(80), attachment: { type: "queued_command", commandMode: "prompt", prompt: "and also this" } })).toBe(true);
    expect(f.facts().lastPrompt).toBe("and also this");
  });

  test("an API error closes the turn, and a rate-limit refusal is a hit", () => {
    const f = fold([
      user("go"),
      asst([{ type: "text", text: "You've hit your session limit · resets 9:10pm (America/Denver)" }], { model: "<synthetic>", usage: usage(0, 0) }, {
        isApiErrorMessage: true,
        error: "rate_limit",
        apiErrorStatus: 429,
      }),
      asst([{ type: "text", text: "API Error: 500 Internal server error." }], { model: "<synthetic>" }, { isApiErrorMessage: true, error: "server_error" }),
      asst([{ type: "text", text: "You're out of extra usage · resets 4pm (America/Denver)" }], { model: "<synthetic>" }, { isApiErrorMessage: true }),
    ]);
    expect(f.turnOpen).toBe(false);
    expect(f.rateLimitHits.map((h) => h.detail)).toEqual([
      "You've hit your session limit · resets 9:10pm (America/Denver)",
      "You're out of extra usage · resets 4pm (America/Denver)",
    ]);
    expect(f.rateLimitHits[0]!.at).toBe(Date.parse(ts(2)));
  });

  test("prompts are what you typed: no tool results, wrappers, caveats, meta or notifications", () => {
    const f = fold([
      user("Caveat: The messages below were generated by the user while running local commands."),
      user("<local-command-stdout>hi</local-command-stdout>"),
      user("first real prompt"),
      toolResult("t1", "x"),
      user([{ type: "text", text: "look at this" }, { type: "image", source: {} }]),
      user("<task-notification><summary>x</summary></task-notification>"),
      user("expanded skill text", { isMeta: true }),
      user("summary of earlier conversation", { isCompactSummary: true }),
      user("<command-name>/review</command-name><command-args>12</command-args>"),
    ]);
    expect(f.firstPrompt).toBe("first real prompt");
    expect(f.lastPrompt).toBe("look at this");
  });

  test("titles: a name you gave beats Claude's generated one", () => {
    expect(fold([{ type: "ai-title", aiTitle: "Generated" }]).title).toBe("Generated");
    expect(fold([{ type: "ai-title", aiTitle: "Generated" }, { type: "custom-title", customTitle: "Mine" }]).title).toBe("Mine");
    expect(fold([{ type: "agent-name", agentName: "agent" }]).title).toBe("agent");
  });

  test("resumeCwd is the cwd that slugs to the transcript's directory, never a guess", () => {
    const moved = fold([user("a"), user("b", { cwd: "/work/my_repo/sub" })]);
    expect(moved.cwd).toBe("/work/my_repo/sub");
    expect(moved.resumeCwd).toBe(CWD);
    const elsewhere = fold([user("a", { cwd: "/somewhere/else" })]);
    expect(elsewhere.resumeCwd).toBeNull();
    // A session relocated into a worktree resumes from wherever its file now is.
    const wt = "/work/my_repo/.claude/worktrees/feat";
    const relocated = fold([user("a"), { type: "relocated", relocatedCwd: wt }], {
      path: `/h/projects/${projectSlug(wt)}/${SID}.jsonl`,
      agentSessionId: SID,
    });
    expect(relocated.resumeCwd).toBe(wt);
  });

  test("subagent transcripts are flagged with their parent", () => {
    const sub = fold([user("task", { isSidechain: true })], {
      path: `/h/projects/x/${SID}/subagents/agent-abc.jsonl`,
      agentSessionId: "agent-abc",
    });
    expect(sub.isSubagent).toBe(true);
    expect(sub.parentId).toBe(SID);
    const wf = fold([], { path: `/h/projects/x/${SID}/subagents/workflows/wf_1/agent-a.jsonl`, agentSessionId: "a" });
    expect(wf.parentId).toBe(SID);
    const old = fold([user("task", { isSidechain: true })], { path: "/h/projects/x/agent-1234.jsonl", agentSessionId: "agent-1234" });
    expect(old).toMatchObject({ isSubagent: true, parentId: SID });
    expect(fold([user("hi")]).isSubagent).toBe(false);
    expect(fold([{ type: "last-prompt", lastPrompt: "x", sessionId: SID }]).isSubagent).toBe(false);
  });

  test("sidechain records count tokens but not prompts or turn state", () => {
    const f = fold([
      user("main prompt"),
      asst([{ type: "text", text: "main" }], { stop: "end_turn", usage: usage(1, 1) }),
      user("side prompt", { isSidechain: true }),
      asst([toolUse("s1", "Bash", {})], { stop: "tool_use", usage: usage(1, 9) }, { isSidechain: true }),
    ]);
    expect(f.lastPrompt).toBe("main prompt");
    expect(f.turnOpen).toBe(false);
    expect(f.tokens.output).toBe(10);
  });

  test("timestamps: first and latest", () => {
    const f = fold([user("a"), asst([{ type: "text", text: "b" }]), { type: "last-prompt", lastPrompt: "a" }]);
    expect(f.startedAt).toBe(Date.parse(ts(1)));
    expect(f.lastActivityAt).toBe(Date.parse(ts(2)));
  });
});

describe("claude user text", () => {
  test("classification", () => {
    expect(classifyUserText("fix the bug")).toBe("prompt");
    expect(classifyUserText("<div>pasted html</div>")).toBe("prompt");
    expect(classifyUserText("<command-message>review</command-message>\n<command-name>/review</command-name>")).toBe("command");
    expect(classifyUserText("<bash-input>ls</bash-input>")).toBe("bash");
    expect(classifyUserText("<local-command-stdout>x</local-command-stdout>")).toBe("output");
    expect(classifyUserText("<task-notification>x</task-notification>")).toBe("notification");
    expect(classifyUserText("[Request interrupted by user for tool use]")).toBe("interrupted");
    expect(classifyUserText("<local-command-caveat>Caveat</local-command-caveat>")).toBe("hidden");
  });

  test("commandLine", () => {
    expect(commandLine("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>3305</command-args>")).toBe("/review 3305");
    expect(commandLine("<command-name>/clear</command-name><command-args></command-args>")).toBe("/clear");
  });

  test("tool summaries are one line", () => {
    const home = process.env.HOME;
    process.env.HOME = "/home/me";
    try {
      expect(summarizeClaudeTool("Read", { file_path: "/home/me/a/b.ts", offset: 10 })).toBe("~/a/b.ts @10");
      expect(summarizeClaudeTool("Bash", { command: "git status\n&& ls" })).toBe("git status && ls");
      expect(summarizeClaudeTool("Grep", { pattern: "foo", path: "/x" })).toBe("/foo/ in /x");
      expect(summarizeClaudeTool("Agent", { subagent_type: "Explore", description: "find it" })).toBe("Explore · find it");
      expect(summarizeClaudeTool("mcp__srv__do_thing", { a: 1 })).toBe('do_thing {"a":1}');
      expect(summarizeClaudeTool("Edit", { file_path: "/r/.claude/worktrees/wt1/src/x.ts" })).toBe("wt1:src/x.ts");
    } finally {
      process.env.HOME = home;
    }
  });
});

describe("claude timeline pieces", () => {
  test("blocks become events with stable ids; empty thinking is skipped", () => {
    const r = asst([
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi" },
      toolUse("t1", "Bash", { command: "ls" }),
    ]);
    const p = claudePieces(r, 7);
    expect(p.map((x) => x.kind)).toEqual(["event", "event", "call"]);
    const call = p[2]!;
    if (call.kind !== "call") throw new Error();
    expect(call.event).toMatchObject({ id: `${r.uuid}:3`, name: "Bash", summary: "ls", status: "running", input: '{"command":"ls"}' });
  });

  test("tool results, slash commands, bash, notifications, interrupts, compaction", () => {
    expect(claudePieces(toolResult("t1", [{ type: "text", text: "out" }, { type: "image" }], true), 0)).toEqual([
      { kind: "result", callId: "t1", output: "out\n[image]", error: true },
    ]);
    const cmd = claudePieces(user("<command-name>/review</command-name><command-args>12</command-args>"), 0)[0];
    expect(cmd?.kind === "event" && cmd.event).toMatchObject({ kind: "user", text: "/review 12" });
    const bash = claudePieces(user("<bash-input>ls -la</bash-input>"), 0)[0];
    expect(bash?.kind === "event" && bash.event).toMatchObject({ kind: "user", text: "! ls -la" });
    const note = claudePieces(user("<task-notification>\n<task-id>x</task-id>\n<summary>Build finished</summary>\n</task-notification>"), 0)[0];
    expect(note?.kind === "event" && note.event).toMatchObject({ kind: "meta", text: "background task: Build finished" });
    const intr = claudePieces(user([{ type: "text", text: "[Request interrupted by user]" }]), 0)[0];
    expect(intr?.kind === "event" && intr.event).toMatchObject({ kind: "meta", tone: "warn" });
    expect(claudePieces(user("skill", { isMeta: true }), 0)).toEqual([]);
    const img = claudePieces(user([{ type: "text", text: "see" }, { type: "image" }, { type: "image" }]), 0)[0];
    expect(img?.kind === "event" && img.event).toMatchObject({ kind: "user", text: "see", images: 2 });
    const cb = claudePieces({ type: "system", subtype: "compact_boundary", uuid: "c", timestamp: ts(1), compactMetadata: { trigger: "auto", preTokens: 821311, postTokens: 14990 } }, 0)[0];
    expect(cb?.kind === "event" && cb.event).toMatchObject({ kind: "meta", text: "auto-compacted (821K → 15K tokens)" });
  });

  test("api errors are meta events; rate limits warn", () => {
    const rl = asst([{ type: "text", text: "You've hit your weekly limit · resets Sep 26" }], { model: "<synthetic>" }, { isApiErrorMessage: true, error: "rate_limit" });
    const e = claudePieces(rl, 0)[0];
    expect(e?.kind === "event" && e.event).toMatchObject({ kind: "meta", tone: "warn" });
    const se = claudePieces(asst([{ type: "text", text: "API Error: 529 Overloaded" }], { model: "<synthetic>" }, { isApiErrorMessage: true, error: "server_error" }), 0)[0];
    expect(se?.kind === "event" && se.event).toMatchObject({ kind: "meta", tone: "error" });
  });

  test("sidechain records are not part of this conversation's timeline", () => {
    expect(claudePieces(user("x", { isSidechain: true }), 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------- on disk

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const appendJsonl = (path: string, records: unknown[]) => appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const account = (home: string, over: Partial<Account> = {}): Account => ({
  id: "acct-c",
  provider: "claude",
  label: "c",
  email: null,
  plan: null,
  home,
  isDefault: false,
  enabled: true,
  createdAt: 0,
  ...over,
});

describe("claude on disk", () => {
  test("listTranscripts finds uuid transcripts by mtime and skips subagents and old agent files", async () => {
    const home = tmp();
    const dir = join(home, "projects", projectSlug(CWD));
    const a = join(dir, `${SID}.jsonl`);
    const old = join(dir, "22222222-2222-4222-8222-222222222222.jsonl");
    writeJsonl(a, [user("hi")]);
    writeJsonl(old, [user("old")]);
    writeJsonl(join(dir, "agent-1234.jsonl"), [user("x", { isSidechain: true })]);
    writeJsonl(join(dir, SID, "subagents", "agent-abc.jsonl"), [user("x", { isSidechain: true })]);
    const t = Date.now() / 1000;
    utimesSync(old, t - 7200, t - 7200);
    const acct = account(home);
    let refs = await claudeAdapter.listTranscripts(acct, Date.now() - 3600_000);
    expect(refs.map((r) => r.agentSessionId)).toEqual([SID]);
    expect(refs[0]).toMatchObject({ provider: "claude", accountId: "acct-c", path: a });
    refs = await claudeAdapter.listTranscripts(acct, Date.now() - 3 * 3600_000);
    expect(refs.map((r) => r.agentSessionId).sort()).toEqual([SID, "22222222-2222-4222-8222-222222222222"]);

    // A new session in a new project directory is seen on the next call.
    const b = join(home, "projects", "-other", "33333333-3333-4333-8333-333333333333.jsonl");
    writeJsonl(b, [user("new")]);
    refs = await claudeAdapter.listTranscripts(acct, Date.now() - 3600_000);
    expect(refs.map((r) => r.agentSessionId).sort()).toEqual([SID, "33333333-3333-4333-8333-333333333333"]);

    // An old file appended to (a resumed session) is found within a cold sweep.
    appendJsonl(old, [user("resumed")]);
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      refs = await claudeAdapter.listTranscripts(acct, Date.now() - 3600_000);
      found = refs.some((r) => r.path === old);
    }
    expect(found).toBe(true);
  });

  test("findTranscript searches every project directory", async () => {
    const home = tmp();
    const p = join(home, "projects", "-somewhere", `${SID}.jsonl`);
    writeJsonl(p, [user("hi")]);
    const ref = await claudeAdapter.findTranscript(account(home), SID);
    expect(ref?.path).toBe(p);
    expect(await claudeAdapter.findTranscript(account(home), "44444444-4444-4444-8444-444444444444")).toBeNull();
    expect(await claudeAdapter.findTranscript(account(home), "../etc/passwd")).toBeNull();
  });

  test("the default account is ~/.claude under $HOME at call time", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/somebody";
    try {
      expect(claudeHome(account("/ignored", { isDefault: true }))).toBe("/tmp/somebody/.claude");
      expect(claudeAdapter.defaultHome()).toBe("/tmp/somebody/.claude");
    } finally {
      process.env.HOME = prev;
    }
    expect(claudeHome(account("/acct/home"))).toBe("/acct/home");
  });

  test("reader: incremental facts, pages, since with a finished tool re-sent", async () => {
    const home = tmp();
    const path = join(home, "projects", projectSlug(CWD), `${SID}.jsonl`);
    writeJsonl(path, [
      user("first"),
      asst([{ type: "text", text: "one" }], { stop: "end_turn", usage: usage(1, 1) }),
      user("second"),
      asst([toolUse("t1", "Bash", { command: "sleep 1" })], { stop: "tool_use", usage: usage(1, 2) }),
    ]);
    const ref = { provider: "claude" as const, accountId: "a", agentSessionId: SID, path, mtimeMs: 0, size: 0 };
    const r = claudeAdapter.reader(ref);
    let res = await r.refresh();
    expect(res.changed).toBe(true);
    expect(res.facts.turnOpen).toBe(true);
    expect(res.facts.lastPrompt).toBe("second");
    expect((await r.refresh()).changed).toBe(false);

    const page = await r.timeline({ limit: 10 });
    expect(page.events.map((e) => e.kind)).toEqual(["user", "assistant", "user", "tool"]);
    expect(page.events[3]).toMatchObject({ status: "running" });
    expect(page.before).toBeNull();

    appendJsonl(path, [toolResult("t1", "slept"), asst([{ type: "text", text: "two" }], { stop: "end_turn", usage: usage(1, 3) })]);
    const s = await r.since(page.cursor);
    expect(s.reset).toBe(false);
    expect(s.events.map((e) => e.kind)).toEqual(["tool", "assistant"]);
    expect(s.events[0]).toMatchObject({ id: page.events[3]!.id, status: "ok", output: "slept" });
    expect((await r.since(s.cursor)).events).toEqual([]);

    res = await r.refresh();
    expect(res.facts.turnOpen).toBe(false);
    expect(res.facts.tokens.output).toBe(6);

    // An older page folds in results that arrived later.
    const small = await r.timeline({ limit: 2 });
    expect(small.events.map((e) => e.kind)).toEqual(["tool", "assistant"]);
    expect(small.events[0]).toMatchObject({ status: "ok", output: "slept" });
    const prev = await r.timeline({ before: small.before, limit: 2 });
    expect(prev.events.map((e) => (e as { text?: string }).text)).toEqual(["one", "second"]);
    const first = await r.timeline({ before: prev.before, limit: 2 });
    expect(first.events.map((e) => (e as { text?: string }).text)).toEqual(["first"]);
    expect(first.before).toBeNull();
  });

  test("reader: a replaced file resets facts and cursors", async () => {
    const home = tmp();
    const path = join(home, "projects", "-p", `${SID}.jsonl`);
    writeJsonl(path, [user("before"), asst([{ type: "text", text: "x" }], { usage: usage(1, 100) })]);
    const r = claudeAdapter.reader({ provider: "claude", accountId: "a", agentSessionId: SID, path, mtimeMs: 0, size: 0 });
    await r.refresh();
    const page = await r.timeline({ limit: 10 });
    writeJsonl(path + ".new", [user("after")]);
    renameSync(path + ".new", path);
    const res = await r.refresh();
    expect(res.changed).toBe(true);
    expect(res.facts.firstPrompt).toBe("after");
    expect(res.facts.tokens.output).toBe(0);
    const s = await r.since(page.cursor);
    expect(s.reset).toBe(true);
    expect(s.events.map((e) => (e as { text?: string }).text)).toEqual(["after"]);
  });

  test("subagent tokens are folded into the parent's totals", async () => {
    const home = tmp();
    const path = join(home, "projects", "-p", `${SID}.jsonl`);
    writeJsonl(path, [user("go"), asst([{ type: "text", text: "x" }], { id: "p1", usage: usage(1, 10) })]);
    const subDir = join(home, "projects", "-p", SID, "subagents");
    writeJsonl(join(subDir, "agent-a.jsonl"), [
      asst([{ type: "text", text: "s" }], { id: "s1", usage: usage(2, 20) }, { isSidechain: true }),
      asst([toolUse("x", "Bash", {})], { id: "s1", usage: usage(2, 20) }, { isSidechain: true }),
    ]);
    writeJsonl(join(subDir, "workflows", "wf_1", "agent-b.jsonl"), [asst([{ type: "text", text: "w" }], { id: "w1", usage: usage(3, 300) })]);
    writeJsonl(join(subDir, "workflows", "wf_1", "journal.jsonl"), [asst([], { id: "j", usage: usage(1000, 1000) })]);
    const r = claudeAdapter.reader({ provider: "claude", accountId: "a", agentSessionId: SID, path, mtimeMs: 0, size: 0 });
    const res = await r.refresh();
    expect(res.facts.tokens.output).toBe(10 + 20 + 300);
    expect(res.facts.tokens.input).toBe(1 + 2 + 3);
  });

  test("SubagentTokens picks up new and growing files", () => {
    const dir = join(tmp(), "subagents");
    let now = 1_000_000;
    const s = new SubagentTokens(dir, () => now);
    expect(s.refresh()).toBe(false);
    writeJsonl(join(dir, "agent-a.jsonl"), [asst([], { id: "a", usage: usage(1, 1) })]);
    expect(s.refresh()).toBe(true);
    expect(s.totals()?.output).toBe(1);
    appendJsonl(join(dir, "agent-a.jsonl"), [asst([], { id: "b", usage: usage(1, 5) })]);
    now += 1000;
    expect(s.refresh()).toBe(true);
    expect(s.totals()?.output).toBe(6);
    now += 1000;
    expect(s.refresh()).toBe(false);
  });

  test("liveProcesses: a session file is trusted only while its pid is the same process", async () => {
    const home = tmp();
    mkdirSync(join(home, "sessions"), { recursive: true });
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const good = { pid: process.pid, sessionId: SID, cwd: "/w", startedAt: 123, procStart: ticks, status: "waiting", waitingFor: "dialog open", kind: "interactive" };
    writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify(good));
    // Same pid number reused by another process: start ticks differ.
    writeFileSync(join(home, "sessions", "1.json"), JSON.stringify({ ...good, pid: 1, procStart: "999999999" }));
    // Long gone.
    writeFileSync(join(home, "sessions", "999999.json"), JSON.stringify({ ...good, pid: 999999 }));
    writeFileSync(join(home, "sessions", "5.json"), "{torn");
    writeFileSync(join(home, "sessions", `${process.pid}.deadbeef.key`), "secret");
    const procs = await claudeAdapter.liveProcesses([account(home)]);
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pid: process.pid, accountId: "acct-c", agentSessionId: SID, startedAt: 123, busy: false, waitingOn: "dialog open" });
    writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify({ ...good, status: "busy" }));
    expect((await claudeAdapter.liveProcesses([account(home)]))[0]).toMatchObject({ busy: true });
    writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify({ ...good, status: "shell" }));
    expect((await claudeAdapter.liveProcesses([account(home)]))[0]).toMatchObject({ busy: false });
    expect((await claudeAdapter.liveProcesses([account(home)]))[0]!.waitingOn).toBeUndefined();
  });

  test("sessionIdFromArgv", () => {
    expect(sessionIdFromArgv(["claude", "--session-id", SID, "--dangerously-skip-permissions"])).toBe(SID);
    expect(sessionIdFromArgv(["claude", "--resume", SID])).toBe(SID);
    expect(sessionIdFromArgv(["claude", "-r", SID])).toBe(SID);
    expect(sessionIdFromArgv(["claude", `--resume=${SID}`])).toBe(SID);
    expect(sessionIdFromArgv(["claude", "--resume", SID, "--fork-session"])).toBeNull();
    expect(sessionIdFromArgv(["claude", "--resume", "my search"])).toBeNull();
    expect(sessionIdFromArgv(["claude", "-c"])).toBeNull();
  });
});

describe("claude commands", () => {
  test("spawn names its own session id and passes flags", () => {
    const c = claudeAdapter.spawnCommand({ account: account("/h"), cwd: "/w", prompt: "hello", model: "opus", autoApprove: true });
    expect(c.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.argv).toEqual(["claude", "--session-id", c.agentSessionId!, "--model", "opus", "--dangerously-skip-permissions", "hello"]);
    expect(c.env).toEqual({ CLAUDE_CONFIG_DIR: "/h" });
    const d = claudeAdapter.spawnCommand({ account: account("/h", { isDefault: true }), cwd: "/w", autoApprove: false });
    expect(d.argv).toEqual(["claude", "--session-id", d.agentSessionId!]);
    expect(d.env).toEqual({});
    expect(d.unset).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  test("resume, and a prompt that looks like a flag", () => {
    const c = claudeAdapter.resumeCommand({ account: account("/h"), agentSessionId: SID, cwd: "/w", prompt: "--help me", autoApprove: true });
    expect(c.argv).toEqual(["claude", "--resume", SID, "--dangerously-skip-permissions", " --help me"]);
  });
});

describe("claude screens", () => {
  const trust = `
 Accessing workspace:

 /home/me/project

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;
  test("folder trust: moves to Yes wherever the pointer starts", () => {
    expect(claudeAutoAnswer(trust)).toEqual(["Down", "Enter"]);
    const yesFirst = trust.replace(" ❯ No, exit\n   Yes, I trust this folder", " ❯ 1. Yes, I trust this folder\n   2. No, exit");
    expect(claudeAutoAnswer(yesFirst)).toEqual(["Enter"]);
    expect(claudeBlockedOn(trust)).toBe("folder trust");
  });

  test("folder trust with pre-approved permissions is left to you", () => {
    const risky = trust.replace("Security guide", "⚠ This folder pre-approves 3 tool permissions in .claude/settings.json:\n  Bash(rm:*)\nSecurity guide");
    expect(claudeAutoAnswer(risky)).toBeNull();
    expect(claudeBlockedOn(risky)).toBe("folder trust");
  });

  test("bypass-permissions warning", () => {
    const s = `
 WARNING: Claude Code running in Bypass Permissions mode

 In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
 By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

 ❯ No, exit
   Yes, I accept
`;
    expect(claudeAutoAnswer(s)).toEqual(["Down", "Enter"]);
  });

  test("theme picker", () => {
    expect(claudeAutoAnswer("Choose the text style that looks best with your terminal\n ❯ 1. Dark mode ✔")).toEqual(["Enter"]);
  });

  test("the input prompt's ❯ is not a menu pointer", () => {
    expect(claudeAutoAnswer("some output\nYes, I accept\n\n\n\n\n\n\n\n\n\n\n\n❯ type here")).toBeNull();
  });

  test("blockedOn: permission prompts and login", () => {
    expect(claudeBlockedOn(" Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No")).toBe("permission: bash command");
    expect(claudeBlockedOn(" Edit file\n Do you want to make this edit to src/app.ts?\n ❯ 1. Yes")).toBe("permission: edit app.ts");
    expect(claudeBlockedOn(" Do you want to create notes.md?\n ❯ 1. Yes")).toBe("permission: create notes.md");
    expect(claudeBlockedOn("Select login method:\n ❯ 1. Claude account with subscription")).toBe("login required");
    expect(claudeBlockedOn("Resume from summary (recommended)\nResume full session as-is")).toBe("resume: summary or full session");
    expect(claudeBlockedOn("> just working\n✻ Thinking…")).toBeNull();
  });
});
