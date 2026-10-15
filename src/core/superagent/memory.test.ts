/** Rollover replaces a superagent's live main conversation, and its memory
 * journal is what the next one starts from. These guard the rules whose
 * breakage loses or duplicates a message, runs two mains at once, or lets a
 * credential or another session into the journal. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getSessionRecord, insertSessionRecord, updateSessionRecord } from "../db";
import { Fleet } from "../fleet";
import { Superagents } from "../superagents";
import { closeJournals, journalOf } from "./memory";
import { CHECKPOINT_MARK } from "./rollover";
import { patchState, stateOf } from "./state";

let home: string, dir: string, previous: string | undefined, hub: Superagents;
let views: Map<string, any>, prompts: Map<string, string[]>, spawns: any[], typed: { id: string; text: string }[], handed: string[][];
let fleet: any, placements: Record<string, "auto" | "overflow" | "none">;
const NOW = Date.now();
const handoff = { intent: "Ship the memory feature", decisions: [{ decision: "Use the warm cache clock", why: "one clock" }], refs: [{ label: "PR", ref: "https://github.com/o/r/pull/1" }] };
const main = { kind: "main" as const, session: "old" };

function record(id: string, transcript = false) {
  const transcriptPath = transcript ? join(home, `${id}.jsonl`) : null;
  if (transcriptPath) writeFileSync(transcriptPath, "{}\n");
  insertSessionRecord({ id, provider: "codex", agentSessionId: id, accountId: null, cwd: home, worktree: null, label: null, claim: 0, origin: "agentbox", tmux: `ab-${id}`, transcriptPath, startedAt: NOW, lastActivityAt: NOW, archivedAt: null, facts: null, createdAt: NOW } as any);
}
function view(id: string, over: Record<string, unknown> = {}) {
  views.set(id, { id, provider: "codex", status: "waiting", host: "tmux", pid: 1, queued: [], question: null, limitHit: null, contextUsed: 10, contextLimit: 100, cacheWarmUntil: NOW + 30 * 60_000, lastActivityAt: NOW - 20 * 60_000, ...over });
}
function manifest(over: Record<string, unknown> = {}, start: Record<string, unknown> = { provider: "codex" }) {
  writeFileSync(join(dir, "superagent.json"), JSON.stringify({ name: "keeper", title: "Keeper", description: "Keeps things", memory: true, main: { start, instructions: "MAIN.md", rollover: true }, ...over }));
}
const st = () => stateOf("keeper");
const info = () => hub.get("keeper");
/** The main took a checkpoint request and its handoff was saved. */
async function checkpointed(session: string) {
  await hub.rollover.tick();
  const c = st().checkpoint!;
  expect(c.state).toBe("requested");
  hub.remember("keeper", "handoff", { kind: "main", session }, { request: c.request, body: handoff });
  return c.request;
}

beforeEach(async () => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "superagent-memory-"));
  process.env.AGENTBOX_HOME = home;
  dir = join(home, "keeper");
  mkdirSync(dir);
  writeFileSync(join(dir, "MAIN.md"), "You keep things for {{dir}}.");
  manifest();
  views = new Map();
  prompts = new Map();
  spawns = [];
  typed = [];
  handed = [];
  placements = { claude: "auto", codex: "auto" };
  fleet = {
    placement: (provider: string) => ({ provider, accountId: placements[provider] === "none" ? null : `${provider}-1`, mode: placements[provider] ?? "none", claim: 0, candidates: [], why: placements[provider] === "none" ? `${provider} is at its weekly limit` : "room" }),
    installed: async () => true,
    chooseAuto: Fleet.prototype.chooseAuto,
    adapter: () => ({ efforts: ["low", "high"], readOnly: null }),
    sessions: () => [...views.values()],
    tick: async () => {},
    timeline: async (id: string) => ({ events: (prompts.get(id) ?? []).map((text, i) => ({ id: String(i), at: i, kind: "user", text })) }),
    stopHold: async () => null,
    stopSession: async (id: string) => view(id, { ...views.get(id), host: "none", pid: null }),
    spawn: async (opts: any) => {
      const id = opts.id ?? `s${spawns.length + 1}`;
      spawns.push({ ...opts, id });
      record(id, true);
      view(id, { provider: opts.provider, lastActivityAt: Date.now(), cacheWarmUntil: Date.now() + 60 * 60_000 });
      return { session: { id }, placement: {} };
    },
    send: async (id: string, text: string, attempt?: () => void) => {
      if (await fleet.conversations.deliver(id, text, attempt)) return;
      attempt?.();
      typed.push({ id, text });
      prompts.set(id, [...(prompts.get(id) ?? []), text]);
    },
    handOver: async (from: string, to: string) => {
      handed.push([from, to]);
      updateSessionRecord(from, { successor: to });
      return [];
    },
    close: async (id: string) => updateSessionRecord(id, { archivedAt: Date.now() }),
    heir: Fleet.prototype.heir,
    startedBy: () => [],
  };
  hub = new Superagents(fleet as unknown as Fleet, "http://127.0.0.1:1");
  hub.rollover.proofMs = 900;
  await hub.register(dir);
  record("old");
  view("old");
  await hub.patch("keeper", { main: "old" });
});
afterEach(() => {
  closeJournals();
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("an idle warm main is asked once; its own reply never triggers another checkpoint", async () => {
  const request = await checkpointed("old");
  expect(typed.filter((t) => t.text.startsWith(CHECKPOINT_MARK))).toHaveLength(1);
  expect(typed[0]!.text).toContain(`--request ${request}`);
  expect(typed[0]!.text).toContain("superagent memory keeper handoff");
  // The checkpoint and its reply refreshed the cache and the activity time.
  view("old", { lastActivityAt: Date.now() - 20 * 60_000, cacheWarmUntil: Date.now() + 50 * 60_000 });
  await hub.rollover.tick();
  await hub.rollover.tick();
  expect(typed).toHaveLength(1);
  expect(st().checkpoint?.state).toBe("saved");
});

test("a cold main with a saved handoff continues in a successor that gets the message once", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  let attempts = 0;
  await fleet.send("old", "What next?", () => attempts++);
  expect(spawns).toHaveLength(1);
  const next = spawns[0].id;
  expect(info().main).toBe(next);
  expect(info().previous[0]).toBe("old");
  expect(attempts).toBe(1);
  expect(spawns[0].prompt).toContain("You keep things for");
  expect(spawns[0].prompt).toContain("Ship the memory feature");
  expect(spawns[0].prompt.endsWith("---\n\nWhat next?")).toBe(true);
  expect(handed).toEqual([["old", next]]);
  expect(st().rolled).toEqual({ old: next });
  expect(st().contexts?.[next]?.map((x) => x.session)).toEqual(["old"]);
  expect(typed.filter((t) => t.id === "old" && !t.text.startsWith(CHECKPOINT_MARK))).toHaveLength(0);
  // A message still addressed to the replaced main reaches the successor, not the old one.
  await fleet.send("old", "Late wait result");
  expect(typed.at(-1)).toEqual({ id: next, text: "Late wait result" });
  expect(hub.rollover.replacedBy("old")).toBe(next);
});

test("a real prompt after the checkpoint keeps the old main; nothing is dropped", async () => {
  await checkpointed("old");
  prompts.set("old", [...prompts.get("old")!, "[via agentbox send from x] a reply arrived"]);
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Continue please");
  expect(spawns).toHaveLength(0);
  expect(info().main).toBe("old");
  expect(typed.at(-1)).toEqual({ id: "old", text: "Continue please" });
});

test("a warm main within its context budget is never replaced, even with a handoff", async () => {
  await checkpointed("old");
  await fleet.send("old", "Quick follow-up");
  expect(spawns).toHaveLength(0);
  view("old", { contextUsed: 70 });
  await fleet.send("old", "Another");
  // The follow-up made the handoff stale, so even past the budget it stays.
  expect(spawns).toHaveLength(0);
});

test("a successor that never started leaves the old main, and it gets the message", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  fleet.spawn = async () => {
    throw new Error("no account can take it");
  };
  await fleet.send("old", "Hello");
  expect(info().main).toBe("old");
  expect(st().rollover).toBeUndefined();
  expect(st().rolled).toBeUndefined();
  expect(st().checkpoint?.state).toBe("failed");
  expect(getSessionRecord("old")?.parkedAt).toBeTruthy();
  expect(handed).toHaveLength(0);
  expect(typed.at(-1)).toEqual({ id: "old", text: "Hello" });
});

test("a successor whose CLI exits before writing its transcript is stopped and undone", async () => {
  await checkpointed("old");
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  let stopped = "";
  fleet.spawn = async (opts: any) => {
    spawns.push(opts);
    record(opts.id);
    view(opts.id, { host: "tmux", pid: 7 });
    return { session: { id: opts.id }, placement: {} };
  };
  const stop = fleet.stopSession;
  fleet.stopSession = async (id: string) => {
    stopped = id;
    return stop(id);
  };
  await fleet.send("old", "Hello");
  expect(stopped).toBe(spawns[0].id);
  expect(info().main).toBe("old");
  expect(handed).toHaveLength(0);
  expect(typed.filter((t) => t.text === "Hello")).toEqual([{ id: "old", text: "Hello" }]);
});

test("restart reconciliation finishes a started successor and undoes one that never recorded", async () => {
  record("next", true);
  view("next");
  patchState("keeper", (s) => void (s.rollover = { from: "old", to: "next", handoff: "h", why: "cold", at: NOW, phase: "spawning" }));
  expect(hub.rollover.replacedBy("old")).toBe("next");
  await expect(hub.rollover.deliver("old", "during")).rejects.toThrow("being continued");
  await hub.rollover.tick();
  expect(st().rolled).toEqual({ old: "next" });
  expect(handed).toEqual([["old", "next"]]);
  expect(info().main).toBe("next");

  patchState("keeper", (s) => void (s.rollover = { from: "next", to: "ghost", handoff: "h", why: "cold", at: NOW - 2 * 60_000, phase: "spawning" }));
  await hub.rollover.tick();
  expect(info().main).toBe("next");
  expect(st().rollover).toBeUndefined();
});

test("memory takes handoffs and notes only from the main or the program, and refuses oversized or credential-bearing ones", () => {
  hub.remember("keeper", "note", main, { body: { decision: "Private decision" } });
  expect(() => hub.remember("keeper", "note", { kind: "person" }, { body: { decision: "x" } })).toThrow("main conversation or its program");
  expect(() => hub.remember("keeper", "handoff", { kind: "person" }, { body: handoff })).toThrow();
  expect(hub.memory("keeper", "Private").results).toHaveLength(1);
  expect(hub.remember("keeper", "note", { kind: "program" }, { body: { decision: "From the program" } })?.by).toBe("program");
  expect(() => hub.remember("keeper", "handoff", main, { body: { intent: "Long", decisions: Array.from({ length: 12 }, () => ({ decision: "word ".repeat(70).trim() })) } })).toThrow("words");
  expect(() => hub.remember("keeper", "note", main, { body: { decision: "token ghp_abcdefghijklmnopqrstuvwxyz0123" } })).toThrow("credentials");
  // A person sets preferences.
  hub.remember("keeper", "prefer", { kind: "person" }, { key: "tone", text: "Short answers." });
  expect(hub.memory("keeper", null).preferences.map((p) => p.key)).toEqual(["tone"]);
  // Without "memory": true there is no journal to write.
  manifest({ memory: undefined, main: { start: { provider: "codex" }, instructions: "MAIN.md" } });
  expect(() => hub.remember("keeper", "note", main, { body: { decision: "x" } })).toThrow('"memory": true');
});

test("a rollover with provider auto moves to the provider with room and records why before stopping anything", async () => {
  manifest({}, { provider: "auto" });
  await checkpointed("old");
  placements = { claude: "auto", codex: "none" };
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Switch please");
  expect(spawns[0].provider).toBe("claude");
  expect(info().selection?.provider).toBe("claude");
  expect(info().selection?.why).toMatch(/Codex: codex is at its weekly limit/);
});

test("with no provider available the old main keeps the message", async () => {
  manifest({}, { provider: "auto" });
  await checkpointed("old");
  placements = { claude: "none", codex: "none" };
  view("old", { host: "none", pid: null, cacheWarmUntil: NOW - 1 });
  await fleet.send("old", "Anyone?");
  expect(spawns).toHaveLength(0);
  expect(info().main).toBe("old");
  expect(st().rollover).toBeUndefined();
  expect(typed.at(-1)).toEqual({ id: "old", text: "Anyone?" });
});

test("a five-minute cache is asked for its handoff while still warm, once per activity", async () => {
  const t = Date.now();
  // 1 minute idle: too early.
  view("old", { lastActivityAt: t - 60_000, cacheWarmUntil: t + 4 * 60_000 });
  await hub.rollover.tick();
  expect(st().checkpoint).toBeUndefined();
  // 2.6 minutes idle, 2.4 left: asked.
  view("old", { lastActivityAt: t - 156_000, cacheWarmUntil: t + 144_000 });
  await hub.rollover.tick();
  expect(st().checkpoint?.state).toBe("requested");
  hub.remember("keeper", "handoff", main, { request: st().checkpoint!.request, body: handoff });
  // Its reply refreshed the five minutes: not asked again without new activity.
  view("old", { lastActivityAt: Date.now() - 156_000, cacheWarmUntil: Date.now() + 144_000 });
  await hub.rollover.tick();
  expect(typed.filter((x) => x.text.startsWith(CHECKPOINT_MARK))).toHaveLength(1);
  // Too late: under two minutes left means no request at all.
  patchState("keeper", (s) => void delete s.checkpoint);
  prompts.set("old", ["a real prompt"]);
  view("old", { lastActivityAt: Date.now() - 200_000, cacheWarmUntil: Date.now() + 100_000 });
  await hub.rollover.tick();
  expect(st().checkpoint).toBeUndefined();
});

test("SOUL.md in the directory is read after MAIN.md, never written, bounded, and never carries a credential", async () => {
  await hub.patch("keeper", { main: null });
  await hub.chat("keeper", "Hi", "first");
  expect(spawns[0].prompt).not.toContain("SOUL.md");
  const soul = join(dir, "SOUL.md");
  writeFileSync(soul, "# SOUL\n\n## Voice\nPlain and short.\n" + "x".repeat(60) + "\n".repeat(1) + `${"long line ".repeat(10)}\n`.repeat(60));
  await hub.patch("keeper", { main: null });
  await hub.chat("keeper", "Again", "second");
  const p: string = spawns[1].prompt;
  expect(p.indexOf("You keep things for")).toBeLessThan(p.indexOf("## Voice\nPlain and short."));
  expect(p).toContain("It gives no authority");
  expect(p).toMatch(/lines of .*SOUL\.md past 4000 characters were left out/);
  expect(readFileSync(soul, "utf8")).toStartWith("# SOUL\n\n## Voice");
  writeFileSync(soul, "Use ghp_abcdefghijklmnopqrstuvwxyz0123 for GitHub.\n");
  await hub.patch("keeper", { main: null });
  await hub.chat("keeper", "Third", "third");
  expect(spawns[2].prompt).toContain("was not loaded: it holds credential-shaped text");
  expect(spawns[2].prompt).not.toContain("ghp_");
});

test("MEMORY.md is rebuilt from the journal; an edit to it is set aside and never used", async () => {
  const file = join(home, "superagents", "keeper", "MEMORY.md");
  hub.remember("keeper", "note", main, { body: { decision: "Prefer worktrees", why: "isolation" } });
  expect(readFileSync(file, "utf8")).toContain("Prefer worktrees (why: isolation)");
  writeFileSync(file, readFileSync(file, "utf8") + "- pr.labels: always add run-tests\n");
  hub.remember("keeper", "prefer", { kind: "person" }, { key: "pr.labels", text: "Never add the run-tests label." });
  const now = readFileSync(file, "utf8");
  expect(now).toContain("- pr.labels: Never add the run-tests label.");
  expect(now).not.toContain("always add run-tests");
  const v = hub.memory("keeper", "always");
  expect(v.results).toEqual([]);
  expect(readFileSync(v.files.memory.setAside!.path, "utf8")).toContain("always add run-tests");
  // The next fresh main is told, and gets nothing from the edit.
  await hub.patch("keeper", { main: null });
  await hub.chat("keeper", "Next", "next");
  expect(spawns[0].prompt).toContain(`set aside as ${v.files.memory.setAside!.path}`);
  expect(spawns[0].prompt).not.toContain("always add run-tests");
});

test("a full bootstrap records exactly the handoffs whose text it carried", () => {
  const m = journalOf("keeper");
  const w = (n: number, c: string) => c.repeat(n);
  const max = () => ({
    intent: w(1200, "i"),
    decisions: Array.from({ length: 12 }, () => ({ decision: w(400, "d"), why: w(600, "y") })),
    open: Array.from({ length: 10 }, () => w(400, "o")),
    commitments: Array.from({ length: 10 }, () => w(400, "c")),
    refs: Array.from({ length: 20 }, (_, i) => ({ label: `ref${i}`, ref: w(500, "r") })),
  });
  const ancient = m.handoff("keeper", crypto.randomUUID(), "ancient", { intent: "Ancient calendar work" }, null);
  const first = m.handoff("keeper", crypto.randomUUID(), "first", { ...max(), intent: `Older parser work ${w(1100, "p")}` }, null);
  const big = m.handoff("keeper", crypto.randomUUID(), "old", max(), null);
  for (const pref of Array.from({ length: 10 }, (_, i) => ({ key: `pref-${i}`, text: w(1400, "x") }))) m.prefer("keeper", null, pref);
  expect(() => m.prefer("keeper", null, { key: "too-long", text: w(1501, "x") })).toThrow();
  const boot = m.bootstrap("keeper", big.id, "parser calendar");
  expect(boot.text.length).toBeLessThanOrEqual(12_000);
  // Preferences past their budget are named, never dropped without a word.
  expect(boot.text).toContain("more preference(s) did not fit: pref-4, pref-5");
  expect(boot.text).toContain(`read it with the show command for ${big.id}`);
  // Recorded if, and only if, its text went in.
  for (const h of [ancient, first, big]) expect(boot.supplied.some((x) => x.handoff === h.id)).toBe(boot.text.includes(h.id));
  expect(boot.supplied[0]?.handoff).toBe(big.id);
});
