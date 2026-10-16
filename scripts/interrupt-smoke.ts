/**
 * Live check of what `Fleet.endTurnFor` (#25) relies on, against the real
 * Claude and Codex CLIs: one Escape ends a running turn within
 * INTERRUPT_WAIT_MS, the transcript records the end as the readers expect
 * (Claude: "[Request interrupted by user]"; Codex: `turn_aborted`), the old
 * turn does not carry on, and the next typed message starts a turn that
 * finishes. The fake terminals of the unit tests cannot show any of that.
 *
 * It runs each installed CLI on its default login, in a scratch directory and
 * a scratch tmux server, and spends two short turns each. The result, with
 * the CLI's version, goes to $AGENTBOX_HOME/smoke/interrupt.json, and
 * `agentbox doctor` warns when an installed version has not passed.
 * `--if-changed` skips a provider whose installed version already passed, so
 * a schedule can run it after every update.
 *
 *   bun scripts/interrupt-smoke.ts [claude] [codex] [--if-changed]
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGENTBOX_TMUX_SOCKET = `ab-interrupt-smoke-${process.pid}`;
const tmux = await import("../src/core/tmux");
const { claudeAutoAnswer } = await import("../src/core/providers/claude");
const { codexAutoAnswer } = await import("../src/core/providers/codex");
const { installedVersion, recordSmoke, smokeRecord } = await import("../src/core/smoke");
const { userHome } = await import("../src/core/paths");

/** Fleet.endTurnFor's wait: a turn not ended by then gets the message mid-turn. */
const INTERRUPT_WAIT_MS = 8_000;
const TASK = "Use your shell tool to run exactly this command and wait for it to finish: sleep 60\nAfter it finishes, reply with the single word FINISHED.";
const NEXT = "Reply with the single word PONG and nothing else.";

type Provider = "claude" | "codex";
type Probe = { argv: string[]; transcript: () => string | null; answer: (screen: string) => string[] | null };

function newestFile(dir: string, match: (path: string) => boolean, since: number): string | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; at: number } | null = null;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const at = statSync(p).mtimeMs;
        if (at >= since && (!best || at > best.at) && match(p)) best = { path: p, at };
      }
    }
  };
  walk(dir);
  return (best as { path: string } | null)?.path ?? null;
}

function probe(provider: Provider, cwd: string, since: number): Probe {
  if (provider === "claude") {
    const id = randomUUID();
    return {
      argv: ["claude", "--session-id", id, "--dangerously-skip-permissions", TASK],
      transcript: () => newestFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(userHome(), ".claude"), "projects"), (p) => p.endsWith(`${id}.jsonl`), since),
      answer: (s) => claudeAutoAnswer(s, { bypassPermissions: true }),
    };
  }
  return {
    argv: ["codex", "--dangerously-bypass-approvals-and-sandbox", TASK],
    transcript: () => newestFile(join(process.env.CODEX_HOME ?? join(userHome(), ".codex"), "sessions"), (p) => readFileSync(p, "utf8").split("\n", 1)[0]!.includes(JSON.stringify(cwd).slice(1, -1)), since),
    answer: codexAutoAnswer,
  };
}

/** The transcript's lines as JSON, the unreadable ones left out. */
function lines(path: string | null): any[] {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((l) => {
    try { return l ? [JSON.parse(l)] : []; } catch { return []; }
  });
}
const text = (rows: any[]) => JSON.stringify(rows);
const toolStarted = (p: Provider, rows: any[]) =>
  p === "claude"
    ? rows.some((r) => r.type === "assistant" && r.message?.content?.some?.((c: any) => c.type === "tool_use"))
    : rows.some((r) => r.type === "response_item" && /call/.test(r.payload?.type ?? ""));
/** What the agent said, not what it was told: the prompt holds both words. */
const replies = (p: Provider, rows: any[]) =>
  text(p === "claude"
    ? rows.filter((r) => r.type === "assistant").map((r) => r.message?.content)
    : rows.filter((r) => (r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "assistant") || (r.type === "event_msg" && r.payload?.type === "agent_message")).map((r) => r.payload));
const interrupted = (p: Provider, rows: any[]) =>
  p === "claude" ? text(rows).includes("[Request interrupted by user") : rows.some((r) => r.type === "event_msg" && r.payload?.type === "turn_aborted");

async function until<T>(what: string, ms: number, poll: () => T | null | false, answer?: () => void): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    answer?.();
    const v = poll();
    if (v) return v;
    await Bun.sleep(250);
  }
  throw new Error(`${what} did not happen within ${ms / 1000}s`);
}

async function check(provider: Provider): Promise<{ ok: boolean; detail: string; endedInMs?: number }> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `agentbox-interrupt-${provider}-`)));
  const name = `smoke-${provider}`;
  const since = Date.now() - 1000;
  const p = probe(provider, cwd, since);
  const answer = () => {
    const keys = p.answer(tmux.capture(name) ?? "");
    if (keys?.length) tmux.sendKeys(name, keys);
  };
  tmux.newSession({ name, cwd, argv: p.argv });
  try {
    const path = await until("the transcript", 60_000, () => p.transcript(), answer);
    await until("the shell command", 120_000, () => toolStarted(provider, lines(path)), answer);
    await Bun.sleep(2000);
    const pressed = Date.now();
    tmux.sendKeys(name, ["Escape"]);
    await until("the end of the turn in the transcript", INTERRUPT_WAIT_MS, () => interrupted(provider, lines(path)));
    const endedInMs = Date.now() - pressed;
    await Bun.sleep(1000);
    await tmux.sendText(name, NEXT);
    await until("the reply to the next message", 120_000, () => /PONG/.test(replies(provider, lines(path))), answer);
    // The interrupted turn must not come back and finish its task.
    await Bun.sleep(3000);
    if (/FINISHED/.test(replies(provider, lines(path))))
      return { ok: false, detail: "the interrupted turn carried on and finished its task" };
    return { ok: true, detail: `Escape ended the turn in ${(endedInMs / 1000).toFixed(1)}s; the next message started a new turn`, endedInMs };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    tmux.killSession(name);
    rmSync(cwd, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const ifChanged = args.includes("--if-changed");
const asked = args.filter((a): a is Provider => a === "claude" || a === "codex");
let failed = false;
for (const provider of asked.length ? asked : (["claude", "codex"] as Provider[])) {
  const version = installedVersion(provider);
  if (!version) {
    console.log(`${provider}: not installed, skipped`);
    continue;
  }
  if (ifChanged && smokeRecord()[provider]?.version === version && smokeRecord()[provider]?.ok) {
    console.log(`${provider} ${version}: passed before, skipped`);
    continue;
  }
  console.log(`${provider} ${version}: checking…`);
  const r = await check(provider);
  recordSmoke(provider, { version, ...r, at: Date.now() });
  console.log(`${provider} ${version}: ${r.ok ? "ok" : "FAILED"}: ${r.detail}`);
  failed ||= !r.ok;
}
process.exit(failed ? 1 : 0);
