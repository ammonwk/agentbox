import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../../types";
import { attributeOmp, isOmpSessionArgv, ompAdapter, parentFromPath, resumeArg, sessionsRootOf, slugDirFor } from "../omp";
import { ompSlug, sessionIdFromFileName, startFromFileName } from "../omp-transcript";
import { kindForDuration, parseOmpUsage } from "../omp-usage";
import { costEquiv } from "../../pricing";

const ID = "01a050f4-1aa7-7000-9860-48d174e524ab";
const FILE = `2026-08-30T04-36-10-023Z_${ID}.jsonl`;

function account(home: string): Account {
  return { id: "omp-default", provider: "omp", label: "omp", email: null, plan: null, home, isDefault: true, enabled: true, createdAt: 0 };
}

/** The fixed 256-byte title slot omp writes as line 0. */
function slot(title: string): string {
  const base = JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-08-30T04:36:10.023Z", pad: "" });
  const pad = " ".repeat(256 - Buffer.byteLength(base) - 1);
  return `${JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-08-30T04:36:10.023Z", pad })}\n`;
}

const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const at = (s: number) => new Date(Date.UTC(2026, 7, 30, 4, 36, s)).toISOString();

const header = line({ type: "session", version: 3, id: ID, timestamp: at(10), cwd: "/work/proj" });
const model = line({ type: "model_change", id: "m1", parentId: null, timestamp: at(10), model: "anthropic/claude-opus-4-5" });
const user = (text: string, s: number, attribution = "user") =>
  line({ type: "message", id: `u${s}`, parentId: null, timestamp: at(s), message: { role: "user", content: [{ type: "text", text }], attribution } });
const assistant = (s: number, content: unknown[], stopReason: string, extra: Record<string, unknown> = {}) =>
  line({
    type: "message",
    id: `a${s}`,
    parentId: null,
    timestamp: at(s),
    message: {
      role: "assistant",
      content,
      provider: "anthropic",
      model: "claude-opus-4-5",
      stopReason,
      usage: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50, totalTokens: 1170, cost: { total: 0 } },
      ...extra,
    },
  });
const toolResult = (callId: string, s: number, text: string, isError = false) =>
  line({ type: "message", id: `r${s}`, parentId: null, timestamp: at(s), message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError } });

function sessionDir(): { home: string; dir: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "omp-home-"));
  const dir = join(home, "agent", "sessions", "--work-proj--");
  mkdirSync(dir, { recursive: true });
  return { home, dir, path: join(dir, FILE) };
}

describe("omp transcript reader", () => {
  test("facts: title slot, prompts, tokens, context, turn state", async () => {
    const { home, path } = sessionDir();
    writeFileSync(
      path,
      slot("") +
        header +
        model +
        user("fix the bug", 11) +
        assistant(12, [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c1", name: "bash", arguments: { i: "look", command: "ls -la" } }], "toolUse"),
    );
    const ref = (await ompAdapter.findTranscript(account(home), ID))!;
    expect(ref.path).toBe(path);
    const r = ompAdapter.reader(ref);
    let { changed, facts } = await r.refresh();
    expect(changed).toBe(true);
    expect(facts.agentSessionId).toBe(ID);
    expect(facts.cwd).toBe("/work/proj");
    expect(facts.resumeCwd).toBe("/work/proj");
    expect(facts.title).toBeNull();
    expect(facts.firstPrompt).toBe("fix the bug");
    expect(facts.model).toBe("anthropic/claude-opus-4-5");
    expect(facts.turnOpen).toBe(true);
    expect(facts.contextUsed).toBe(1170);
    expect(facts.tokens.input).toBe(100);
    expect(facts.tokens.cacheWrite).toBe(50);
    expect(facts.tokens.costEquiv).toBeCloseTo(costEquiv("claude-opus-4-5", { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }));
    expect(facts.isSubagent).toBe(false);
    expect(facts.startedAt).toBe(Date.parse(at(10)));

    expect((await r.refresh()).changed).toBe(false);

    // omp rewrites the title slot in place, then the turn ends.
    const fd = openSync(path, "r+");
    writeSync(fd, slot("Fix the bug"), 0);
    closeSync(fd);
    appendFileSync(path, toolResult("c1", 13, "a\nb") + assistant(14, [{ type: "text", text: "Done." }], "stop"));
    ({ changed, facts } = await r.refresh());
    expect(changed).toBe(true);
    expect(facts.title).toBe("Fix the bug");
    expect(facts.turnOpen).toBe(false);
    expect(facts.lastMessage).toBe("Done.");
    expect(facts.tokens.input).toBe(200);
    expect(facts.lastActivityAt).toBe(Date.parse(at(14)));
  });

  test("rate-limit errors become hits; agent-attributed prompts are not the user's", async () => {
    const { home, path } = sessionDir();
    writeFileSync(
      path,
      slot("") +
        header +
        user("real prompt", 11) +
        user("assignment from a parent", 12, "agent") +
        assistant(13, [], "error", { errorStatus: 429, errorMessage: "rate_limit_exceeded: Provider returned error" }) +
        assistant(14, [], "error", { errorMessage: "5-hour usage limit reached. Resets in 2hr" }) +
        assistant(15, [], "error", { errorStatus: 500, errorMessage: "server_error: boom" }),
    );
    const r = ompAdapter.reader((await ompAdapter.findTranscript(account(home), ID))!);
    const { facts } = await r.refresh();
    expect(facts.lastPrompt).toBe("real prompt");
    expect(facts.rateLimitHits.map((h) => h.detail)).toEqual([
      "anthropic/claude-opus-4-5: rate_limit_exceeded: Provider returned error",
      "anthropic/claude-opus-4-5: 5-hour usage limit reached. Resets in 2hr",
    ]);
    expect(facts.rateLimitHits[0]!.at).toBe(Date.parse(at(13)));
    // An errored request does not describe the context window.
    expect(facts.contextUsed).toBeNull();
    const page = await r.timeline({ limit: 20 });
    expect(page.events.filter((e) => e.kind === "meta").map((e) => (e as { tone?: string }).tone)).toEqual(["error", "error", "error"]);
  });

  test("subagent logs fold into the parent's tokens and are flagged on their own", async () => {
    const { home, dir, path } = sessionDir();
    writeFileSync(path, slot("") + header + user("fan out", 11) + assistant(12, [{ type: "text", text: "ok" }], "stop"));
    const subDir = join(dir, FILE.slice(0, -".jsonl".length));
    mkdirSync(join(subDir, "Scout"), { recursive: true });
    const sub = join(subDir, "Scout.jsonl");
    writeFileSync(sub, slot("") + line({ type: "session", version: 3, id: "sub-1", timestamp: at(20), cwd: "/work/proj" }) + line({ type: "session_init", id: "i", parentId: null, timestamp: at(20), task: "look" }) + assistant(21, [], "stop"));
    writeFileSync(join(subDir, "Scout", "Scout.Child.jsonl"), assistant(22, [], "stop"));
    // Tool-output captures sit beside the logs and are not agents.
    writeFileSync(join(subDir, "12.bash.jsonl"), assistant(23, [], "stop"));

    const refs = await ompAdapter.listTranscripts(account(home), 0);
    expect(refs.map((x) => x.agentSessionId)).toEqual([ID]);

    const { facts } = await ompAdapter.reader(refs[0]!).refresh();
    expect(facts.tokens.input).toBe(300);

    const subRef = { ...refs[0]!, path: sub, agentSessionId: "sub-1" };
    const sf = (await ompAdapter.reader(subRef).refresh()).facts;
    expect(sf.isSubagent).toBe(true);
    expect(sf.parentId).toBe(ID);
    expect(sf.resumeCwd).toBeNull();
    expect(sf.tokens.input).toBe(100);
    expect(parentFromPath(join(subDir, "Scout", "Scout.Child.jsonl"))).toBe(ID);
    expect(parentFromPath(path)).toBeNull();
  });

  test("timeline pages backwards and since re-sends a finished tool", async () => {
    const { home, path } = sessionDir();
    let body = slot("") + header;
    for (let s = 11; s < 31; s++) body += user(`p${s}`, s);
    body += assistant(40, [{ type: "text", text: "running it" }, { type: "toolCall", id: "c9", name: "bash", arguments: { command: "make" } }], "toolUse");
    writeFileSync(path, body);
    const r = ompAdapter.reader((await ompAdapter.findTranscript(account(home), ID))!);
    await r.refresh();

    const newest = await r.timeline({ limit: 5 });
    expect(newest.events.map((e) => e.kind)).toEqual(["user", "user", "user", "assistant", "tool"]);
    const tool = newest.events[4]!;
    expect(tool.kind === "tool" && tool.status).toBe("running");
    expect(tool.kind === "tool" && tool.summary).toBe("make");
    expect(newest.before).toBe(newest.events[0]!.id);

    const older = await r.timeline({ before: newest.before, limit: 100 });
    expect(older.events.length).toBe(17);
    expect(older.before).toBeNull();
    expect((older.events[0] as { text: string }).text).toBe("p11");

    appendFileSync(path, toolResult("c9", 41, "built", true) + assistant(42, [{ type: "text", text: "failed" }], "stop"));
    const inc = await r.since(newest.cursor);
    expect(inc.reset).toBe(false);
    expect(inc.events.map((e) => e.id)).toEqual([tool.id, expect.stringMatching(/\.0$/)]);
    const resent = inc.events[0]!;
    expect(resent.kind === "tool" && resent.status).toBe("error");
    expect(resent.kind === "tool" && resent.output).toBe("built");
    expect((await r.since(inc.cursor)).events).toEqual([]);

    // A replaced file invalidates old cursors.
    writeFileSync(`${path}.new`, slot("") + header + user("fresh", 11));
    renameSync(`${path}.new`, path);
    const after = await r.since(inc.cursor);
    expect(after.reset).toBe(true);
    expect(after.events.map((e) => (e as { text?: string }).text)).toEqual(["fresh"]);
  });
});

describe("omp discovery and commands", () => {
  test("listTranscripts filters by mtime and skips non-session files", async () => {
    const { home, dir, path } = sessionDir();
    writeFileSync(path, slot("") + header);
    writeFileSync(join(dir, "notes.jsonl"), "{}\n");
    const acct = account(home);
    expect((await ompAdapter.listTranscripts(acct, 0)).length).toBe(1);
    expect(await ompAdapter.listTranscripts(acct, Date.now() + 60_000)).toEqual([]);
    expect(await ompAdapter.findTranscript(acct, "nope")).toBeNull();
    expect(sessionsRootOf(acct)).toBe(join(home, "agent", "sessions"));
  });

  test("slug, file-name and argv helpers match omp's own", () => {
    const home = "/home/u";
    expect(ompSlug("/home/u/Documents/agentbox", home, "/tmp")).toBe("-Documents-agentbox");
    expect(ompSlug("/home/u", home, "/tmp")).toBe("-");
    expect(ompSlug("/tmp", home, "/tmp")).toBe("-tmp");
    expect(ompSlug("/tmp/wt/a", home, "/tmp")).toBe("-tmp-wt-a");
    expect(ompSlug("/srv/x", home, "/tmp")).toBe("--srv-x--");
    expect(sessionIdFromFileName(FILE)).toBe(ID);
    expect(sessionIdFromFileName("Scout.jsonl")).toBeNull();
    expect(startFromFileName(FILE)).toBe(Date.parse("2026-08-30T04:36:10.023Z"));

    expect(isOmpSessionArgv(["bun", "/home/u/.bun/bin/omp"])).toBe(true);
    expect(isOmpSessionArgv(["bun", "/x/@oh-my-pi/pi-coding-agent/dist/cli.js", "-r", "abc"])).toBe(true);
    expect(isOmpSessionArgv(["omp", "acp"])).toBe(true);
    expect(isOmpSessionArgv(["omp", "usage", "--json"])).toBe(false);
    expect(isOmpSessionArgv(["bun", "/home/u/.bun/bin/omp", "__tiny-worker"])).toBe(false);
    expect(isOmpSessionArgv(["omp", "--profile", "work"])).toBe(false);
    expect(isOmpSessionArgv(["node", "/x/codex"])).toBe(false);
    expect(resumeArg(["omp", "-r", "01a0"])).toBe("01a0");
    expect(resumeArg(["omp", "--resume=01a0"])).toBe("01a0");
    expect(resumeArg(["omp", "--", "-r", "x"])).toBeNull();
  });

  test("attribution: open file, then argv, then newest file after start; never twice", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-root-"));
    const cwd = "/nonexistent/proj";
    const dir = slugDirFor(root, cwd);
    mkdirSync(join(dir, "2026-09-01T00-00-00-000Z_aaaa0000-0000-7000-8000-000000000001"), { recursive: true });
    const f = (iso: string, id: string) => {
      const p = join(dir, `${iso}_${id}.jsonl`);
      writeFileSync(p, "{}\n");
      return p;
    };
    const a = f("2026-09-01T00-00-00-000Z", "aaaa0000-0000-7000-8000-000000000001");
    f("2026-09-01T01-00-00-000Z", "bbbb0000-0000-7000-8000-000000000002");
    f("2026-09-01T02-00-00-000Z", "cccc0000-0000-7000-8000-000000000003");
    const sub = join(dir, "2026-09-01T00-00-00-000Z_aaaa0000-0000-7000-8000-000000000001", "Scout.jsonl");
    writeFileSync(sub, "{}\n");
    const t = (iso: string) => Date.parse(iso);
    const procs = [
      { pid: 1, ppid: 0, argv: ["omp"], cwd, startedAt: t("2026-08-31T00:00:00Z") },
      { pid: 2, ppid: 0, argv: ["omp", "-r", "bbbb"], cwd, startedAt: t("2026-08-31T00:00:00Z") },
      { pid: 3, ppid: 0, argv: ["omp"], cwd, startedAt: t("2026-09-01T01:30:00Z") },
      { pid: 4, ppid: 0, argv: ["omp"], cwd, startedAt: t("2026-09-01T01:30:00Z") },
    ];
    const open = (pid: number) => (pid === 1 ? ["/dev/null", sub, a] : pid === 3 ? [sub] : []);
    const got = attributeOmp(procs, root, open);
    expect(got.get(1)).toBe("aaaa0000-0000-7000-8000-000000000001");
    expect(got.get(2)).toBe("bbbb0000-0000-7000-8000-000000000002");
    expect(got.get(3)).toBe("cccc0000-0000-7000-8000-000000000003");
    expect(got.get(4)).toBeNull();
  });

  test("commands", async () => {
    const { home, path } = sessionDir();
    writeFileSync(path, slot("") + header);
    const acct = account(home);
    const spawn = ompAdapter.spawnCommand({ account: acct, cwd: "/work/proj", prompt: "-v means verbose", model: "opus", autoApprove: true });
    expect(spawn.argv).toEqual(["omp", "--model", "opus", "--auto-approve", "--", "-v means verbose"]);
    expect(spawn.agentSessionId).toBeNull();
    expect(spawn.unset).toContain("XDG_DATA_HOME");
    expect(spawn.unset).toContain("OMP_PROFILE");
    expect(spawn.unset).not.toContain("PI_CODING_AGENT_DIR");
    expect(ompAdapter.spawnCommand({ account: acct, cwd: homedir(), autoApprove: false }).argv).toEqual(["omp", "--allow-home"]);

    // Resume by path when the file is where the cwd says it is; by id otherwise.
    const slugged = slugDirFor(sessionsRootOf(acct), "/work/proj");
    mkdirSync(slugged, { recursive: true });
    renameSync(path, join(slugged, FILE));
    const resume = ompAdapter.resumeCommand({ account: acct, agentSessionId: ID, cwd: "/work/proj", prompt: "go on", autoApprove: false });
    expect(resume.argv).toEqual(["omp", "-r", join(slugged, FILE), "--", "go on"]);
    expect(ompAdapter.resumeCommand({ account: acct, agentSessionId: "zzz", cwd: "/work/proj", autoApprove: false }).argv).toEqual(["omp", "-r", "zzz"]);
  });

  test("blockedOn", () => {
    expect(ompAdapter.blockedOn!("Allow tool: bash\ncommand: rm -rf x\n> Approve\n  Deny")).toBe("permission: bash");
    expect(ompAdapter.blockedOn!("Approve and execute\nRefine plan")).toBe("plan approval");
    expect(ompAdapter.blockedOn!("No models available. Use /login")).toBe("login");
    expect(ompAdapter.blockedOn!("> ")).toBeNull();
  });
});

describe("omp usage", () => {
  test("maps a captured `omp usage --json`", () => {
    const json = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "omp-usage.json"), "utf8"));
    const u = parseOmpUsage(json, "omp-default");
    expect(u.source).toBe("cli");
    expect(u.accountId).toBe("omp-default");
    expect(u.at).toBe(1790282612231);
    expect(u.windows.map((w) => [w.id, w.kind, w.windowMs])).toEqual([
      ["opencode-go:rolling-5h", "short", 18_000_000],
      ["opencode-go:weekly", "weekly", 604_800_000],
      ["opencode-go:monthly", "monthly", 2_592_000_000],
    ]);
    const monthly = u.windows[2]!;
    expect(monthly.usedPct).toBeCloseTo(0.837935);
    expect(monthly.resetsAt).toBe(1790301009834);
    expect(monthly.label).toBe("opencode-go Monthly limit");
    expect(u.windows[0]!.resetsAt).toBeNull();
    expect(u.notes).toContain("opencode-go: OpenCode Go");
  });

  test("two accounts on one provider, derived fractions, scopes and unknowns", () => {
    const limit = (id: string, amount: object, window?: object, scope: object = {}) => ({ id, label: id, scope: { provider: "anthropic", ...scope }, window, amount: { unit: "percent", ...amount } });
    const u = parseOmpUsage(
      {
        generatedAt: 5,
        reports: [
          { provider: "anthropic", fetchedAt: 10, limits: [limit("five_hour", { usedFraction: 0.5 }, { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000, resetsAt: 99 })] },
          {
            provider: "anthropic",
            fetchedAt: 7,
            limits: [
              limit("five_hour", { used: 30, limit: 40 }, { id: "5h", label: "5 Hour" }),
              limit("seven_day_opus", { remainingFraction: 0.25 }, { id: "7d", label: "7 Day", durationMs: 7 * 86_400_000 }, { modelId: "opus" }),
              limit("mystery", { unit: "unknown" }, { id: "x", label: "x" }),
            ],
          },
        ],
      },
      "a",
    );
    expect(u.at).toBe(7);
    expect(u.windows.map((w) => [w.id, w.usedPct, w.windowMs])).toEqual([
      ["anthropic:five_hour", 50, 18_000_000],
      ["anthropic:five_hour#2", 75, 18_000_000],
      ["anthropic:seven_day_opus", 75, 604_800_000],
    ]);
    expect(u.windows[2]!.scope).toEqual({ model: "opus" });
    expect(u.notes).toContain("anthropic mystery: no usage figure");
    expect(kindForDuration(86_400_000)).toBe("daily");
  });
});
