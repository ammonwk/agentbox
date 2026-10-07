import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  cacheWarmUntil,
  claudeCacheTtl,
  KEEP_WARM_MAX,
  isKeepWarmNote,
  keepWarmNote,
  keepWarmPlan,
} from "../cache";
import { claudeReader } from "../providers/claude";
import { ClaudeFold } from "../providers/claude-transcript";
import { loadFields, saveFields } from "../providers/foldstate";
import { deserialize, serialize } from "bun:jsc";
import { classifyShell } from "../park";
import { isAgentSent, readSent } from "../sent";

const M = 60_000;
const H = 60 * M;

describe("the cache clock", () => {
  test("reads the lifetime a Claude call wrote its cache with", () => {
    expect(claudeCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 352_481, ephemeral_5m_input_tokens: 0 } })).toBe(CACHE_TTL_1H_MS);
    expect(claudeCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 600 } })).toBe(CACHE_TTL_5M_MS);
    // The conversation's tail on five minutes: that is what goes cold.
    expect(claudeCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 600 } })).toBe(CACHE_TTL_5M_MS);
    // A pure read says nothing about the lifetime.
    expect(claudeCacheTtl({ cache_read_input_tokens: 9, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })).toBeNull();
    expect(claudeCacheTtl({ input_tokens: 4 })).toBeNull();
  });

  test("runs from the newest model call, for the lifetime it wrote", () => {
    // Notification lines moved lastActivityAt on; the cache did not move.
    expect(cacheWarmUntil({ lastTurnAt: 1_000, lastActivityAt: 50 * M, cacheTtlMs: CACHE_TTL_1H_MS }, 0, 30 * M)).toBe(1_000 + H);
    expect(cacheWarmUntil({ lastTurnAt: 1_000, cacheTtlMs: CACHE_TTL_5M_MS }, 0, H)).toBe(1_000 + 5 * M);
    // A provider that says neither: its newest line, and the fallback lifetime.
    expect(cacheWarmUntil({ lastActivityAt: 2_000 }, 0, 30 * M)).toBe(2_000 + 30 * M);
    expect(cacheWarmUntil(null, 3_000, 30 * M)).toBe(3_000 + 30 * M);
  });
});

describe("keeping a cache warm", () => {
  const turn = 10 * H;
  const base = { warmUntil: turn + H, cacheTtlMs: CACHE_TTL_1H_MS, lastTurnAt: turn, lastWorkAt: turn - M };

  test("comes in the last five minutes of an hour's cache", () => {
    expect(keepWarmPlan({ ...base, now: turn + 54 * M }, undefined)).toBeNull();
    expect(keepWarmPlan({ ...base, now: turn + 55 * M }, undefined)).toEqual({ count: 1, at: turn + 55 * M });
    // Already cold: nothing left to keep.
    expect(keepWarmPlan({ ...base, now: turn + H }, undefined)).toBeNull();
  });

  test("not for a five-minute cache, nor one whose lifetime is unknown", () => {
    expect(keepWarmPlan({ ...base, warmUntil: turn + 5 * M, cacheTtlMs: CACHE_TTL_5M_MS, now: turn + 2 * M }, undefined)).toBeNull();
    expect(keepWarmPlan({ ...base, cacheTtlMs: null, now: turn + 56 * M }, undefined)).toBeNull();
  });

  test("not again before the last one is answered", () => {
    const sent = { count: 1, at: turn + 55 * M };
    expect(keepWarmPlan({ ...base, now: turn + 57 * M }, sent)).toBeNull();
  });

  test("counts the messages in one wait, and stops at the cap", () => {
    // Answered a minute after it went: the next is the second of this wait.
    const answered = turn + 56 * M;
    const next = { ...base, lastTurnAt: answered, warmUntil: answered + H, now: answered + 55 * M };
    expect(keepWarmPlan(next, { count: 1, at: turn + 55 * M })?.count).toBe(2);
    expect(keepWarmPlan(next, { count: KEEP_WARM_MAX, at: turn + 55 * M })).toBeNull();
  });

  test("a wait starts over once you write to it, or it works", () => {
    const sent = { count: KEEP_WARM_MAX, at: turn + 55 * M };
    // You wrote to it after the last one.
    const later = turn + 2 * H;
    expect(keepWarmPlan({ ...base, lastTurnAt: later, lastWorkAt: later - M, warmUntil: later + H, now: later + 55 * M }, sent)?.count).toBe(1);
    // A background task woke it and it worked, well after it answered.
    expect(keepWarmPlan({ ...base, lastTurnAt: later, lastWorkAt: later, warmUntil: later + H, now: later + 55 * M }, sent)?.count).toBe(1);
  });

  test("says what it waits on and asks for one line", () => {
    const note = keepWarmNote("a background command is running (gh run watch 37338529329)");
    expect(note).toContain("(a background command is running (gh run watch 37338529329))");
    expect(note.startsWith("[agentbox: ") && note.endsWith("]")).toBe(true);
  });

  test("delayed warming replies and a restarted reader cannot extend a wait indefinitely", () => {
    const ref = { path: "/tmp/warm.jsonl", agentSessionId: "warm" };
    let fold = new ClaudeFold(ref);
    const add = (type: string, at: number, message: object) => fold.add({ type, timestamp: new Date(at).toISOString(), message });
    add("user", turn, { content: "Wait for the job" });
    for (let i = 1; i <= KEEP_WARM_MAX; i++) {
      const at = turn + i * H;
      add("user", at, { content: keepWarmNote("a background command is waiting") });
      // The former five-minute heuristic mistook this for new work.
      add("assistant", at + 6 * M, { model: "claude-opus-5-5", usage: { input_tokens: 1 }, content: [{ type: "text", text: "Still waiting." }] });
      const state = deserialize(serialize(saveFields(fold, ["ref"])));
      fold = new ClaudeFold(ref);
      loadFields(fold, state);
    }
    const f = fold.facts();
    expect(f.lastWorkAt).toBe(turn);
    expect(f.keepWarm?.count).toBe(KEEP_WARM_MAX);
    expect(keepWarmPlan({ ...f, now: f.lastTurnAt! + 55 * M, warmUntil: f.lastTurnAt! + H, cacheTtlMs: H }, f.keepWarm!)).toBeNull();
    add("user", turn + 10 * H, { content: "The job finished; carry on" });
    expect(fold.facts().keepWarm).toBeNull();
  });

  test("only provably self-matching sleep waiters lose their hold; productive jobs remain protected", () => {
    const stuck = 'until [ -s /tmp/prmon.txt ] && ! pgrep -f "pr-monitor.sh 8327" >/dev/null; do sleep 15; done; tail -25 /tmp/prmon.txt';
    expect(classifyShell(stuck, ["sleep 15"])).toBe("follower");
    expect(classifyShell(stuck, ["bun repair.ts --prod"])).toBe("work");
    // These process checks can finish, and stopping them could kill work.
    for (const cmd of [
      'until ! pgrep -f "[r]un-arm.sh model-compare"; do sleep 10; done',
      'until ! pgrep -A -f "run-arm.sh model-compare"; do sleep 10; done',
      'until ! pgrep -f "run-arm.sh model-compare" || test -f done; do sleep 10; done',
      'until ! pgrep -f "run-arm.sh model-compare"; do bun repair.ts --prod; sleep 10; done',
      'sleep 1800; bun repair.ts --prod',
    ]) expect(classifyShell(cmd, ["sleep 10"])).not.toBe("follower");
  });
});

describe("agentbox's own notes", () => {
  test("are not yours", () => {
    const note = keepWarmNote("a /loop wakeup is due in 12m");
    expect(readSent(note)).toEqual({ agent: true, from: "agentbox", via: null, text: note });
    expect(isAgentSent("[agentbox: a background task finished while this session was idle, and the notification never woke it:\n- Build (output: /tmp/b.output)\nCarry on.]")).toBe(true);
  });

  test("put before your own message, it stays yours", () => {
    expect(isAgentSent("[agentbox: this session was parked while idle.]\n\nwhat about the tests?")).toBe(false);
    expect(isAgentSent("[agentbox: this session was parked while idle.]\n\nsee [the doc]")).toBe(false);
    expect(isKeepWarmNote(`${keepWarmNote("a job")}\n\nPlease carry on with the other task`)).toBe(false);
  });
});

describe("a Claude transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const SESSION = "11111111-2222-3333-4444-777777777777";
  let n = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 16, 0, s)).toISOString();
  const line = (r: object) => `${JSON.stringify(r)}\n`;
  const user = (s: number, content: string) => line({ type: "user", sessionId: SESSION, uuid: `u${s}`, timestamp: at(s), message: { role: "user", content } });
  const reply = (s: number, cache_creation: object) =>
    line({
      type: "assistant",
      sessionId: SESSION,
      uuid: `a${s}`,
      timestamp: at(s),
      message: { id: `m${s}`, role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 9, cache_creation }, content: [{ type: "text", text: "Waiting on CI." }] },
    });
  async function factsOf(records: string) {
    const path = join(dir, `${SESSION}-${n++}.jsonl`);
    writeFileSync(path, records);
    return (await claudeReader({ provider: "claude", accountId: "acct", agentSessionId: SESSION, path, mtimeMs: 0, size: 0 }).refresh()).facts;
  }

  test("keeps the lifetime of the newest call that wrote any cache", async () => {
    const hour = { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 };
    const none = { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 };
    expect((await factsOf(user(0, "go") + reply(1, hour) + user(2, "more") + reply(3, none))).cacheTtlMs).toBe(CACHE_TTL_1H_MS);
    expect((await factsOf(user(0, "go") + reply(1, hour) + user(2, "more") + reply(3, { ephemeral_5m_input_tokens: 40 }))).cacheTtlMs).toBe(CACHE_TTL_5M_MS);
  });

  test("does not take the keep-warm message as something you asked", async () => {
    const f = await factsOf(user(0, "ship it") + reply(1, {}) + user(3600, keepWarmNote("a background command is running (gh run watch 1)")) + reply(3601, {}));
    expect(f.lastPrompt).toBe("ship it");
    expect(f.lastPromptAt).toBe(Date.parse(at(0)));
    expect(f.lastTurnAt).toBe(Date.parse(at(3601)));
  });
});
