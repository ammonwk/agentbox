import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet, FleetError, headline, type Runtime } from "../fleet";
import { closeDb, getDb, insertAccount, listSessionRecords, assignmentsSince, type SessionRecord } from "../db";
import type { NewSession, PaneInfo } from "../tmux";
import type {
  LiveProcess,
  ProviderAdapter,
  TranscriptFacts,
  TranscriptRef,
} from "../providers/types";
import type { Account, AccountUsage, ProviderId } from "../types";
import { useTempHome } from "./tmp-home";

const HOUR = 3_600_000;

/**
 * A provider whose "transcripts" are small JSON files of facts, so each test
 * says exactly what the transcript says.
 */
class FakeAdapter implements ProviderAdapter {
  readonly label: string;
  live: LiveProcess[] = [];
  presetIds = true;
  constructor(readonly id: ProviderId, readonly dir: string) {
    this.label = id;
  }
  async detect() {
    return { installed: true, version: "1" };
  }
  defaultHome() {
    return this.dir;
  }
  accountCommand(account: Account) {
    return { env: { FAKE_HOME: account.home }, unset: [] };
  }
  write(account: Account, facts: Partial<TranscriptFacts> & { agentSessionId: string }): string {
    const dir = join(this.dir, account.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${facts.agentSessionId}.json`);
    writeFileSync(path, JSON.stringify(facts));
    return path;
  }
  async listTranscripts(account: Account, sinceMs: number): Promise<TranscriptRef[]> {
    const dir = join(this.dir, account.id);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      const path = join(dir, n);
      const st = statSync(path);
      if (st.mtimeMs < sinceMs) return [];
      return [{ provider: this.id, accountId: account.id, agentSessionId: n.replace(/\.json$/, ""), path, mtimeMs: st.mtimeMs, size: st.size }];
    });
  }
  async liveProcesses(): Promise<LiveProcess[]> {
    return this.live;
  }
  async findTranscript(account: Account, id: string) {
    return (await this.listTranscripts(account, 0)).find((r) => r.agentSessionId === id) ?? null;
  }
  reader(ref: TranscriptRef) {
    const read = (): TranscriptFacts => {
      const raw = JSON.parse(require("node:fs").readFileSync(ref.path, "utf8"));
      return {
        cwd: null, resumeCwd: null, title: null, firstPrompt: null, lastPrompt: null, lastMessage: null,
        model: null, gitBranch: null, startedAt: null, lastActivityAt: null, turnOpen: false,
        contextUsed: null, contextLimit: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
        usage: null, rateLimitHits: [], isSubagent: false, parentId: null,
        ...raw,
      };
    };
    let last = "";
    return {
      ref,
      async refresh() {
        const facts = read();
        const sig = JSON.stringify(facts);
        const changed = sig !== last;
        last = sig;
        return { changed, facts };
      },
      async timeline() {
        return { events: [], before: null, cursor: "0" };
      },
      async since() {
        return { events: [], cursor: "0", reset: false };
      },
    };
  }
  spawnCommand(opts: { account: Account; cwd: string; prompt?: string }) {
    const agentSessionId = this.presetIds ? `preset-${Math.random().toString(36).slice(2, 8)}` : null;
    return { argv: ["fake", ...(opts.prompt ? [opts.prompt] : [])], ...this.accountCommand(opts.account), agentSessionId };
  }
  resumeCommand(opts: { account: Account; agentSessionId: string }) {
    return { argv: ["fake", "--resume", opts.agentSessionId], ...this.accountCommand(opts.account) };
  }
  blockedOn(screen: string) {
    return screen.includes("Allow?") ? "permission" : null;
  }
}

class FakeRuntime implements Runtime {
  panes = new Map<string, PaneInfo>();
  started: NewSession[] = [];
  typed: [string, string][] = [];
  keysSent: [string, string[]][] = [];
  screens = new Map<string, string>();
  nextPid = 50_000;
  newSession(s: NewSession): number {
    const pid = this.nextPid++;
    this.started.push(s);
    this.panes.set(s.name, { name: s.name, pid, dead: false, deadStatus: null, clients: 0, width: 200, height: 50 });
    return pid;
  }
  listPanes() {
    return [...this.panes.values()];
  }
  async sendText(name: string, text: string) {
    this.typed.push([name, text]);
  }
  sendKeys(name: string, keys: string[]) {
    this.keysSent.push([name, keys]);
  }
  capture(name: string) {
    return this.screens.get(name) ?? "";
  }
  killSession(name: string) {
    this.panes.delete(name);
  }
}

function account(id: string, provider: ProviderId = "claude"): Account {
  return { id, provider, label: id, email: null, plan: null, home: `/fake/${id}`, isDefault: id.endsWith("default"), enabled: true, createdAt: 1 };
}

function usageSource(map: Record<string, AccountUsage["windows"]>) {
  return {
    usageOf(id: string): AccountUsage | null {
      const windows = map[id];
      return windows ? { accountId: id, at: Date.now(), windows, stale: null, source: "endpoint", notes: [] } : null;
    },
  };
}

const weekly = (used: number, short: number) => [
  { id: "five_hour", kind: "short" as const, label: "5h", usedPct: short, resetsAt: Date.now() + 3 * HOUR, windowMs: 5 * HOUR },
  { id: "seven_day", kind: "weekly" as const, label: "wk", usedPct: used, resetsAt: Date.now() + 72 * HOUR, windowMs: 168 * HOUR },
];

describe("Fleet", () => {
  let restore: () => void;
  let dir: string;
  let adapter: FakeAdapter;
  let runtime: FakeRuntime;
  let fleet: Fleet;
  const A = account("claude-a");
  const B = account("claude-b");

  beforeAll(() => {
    closeDb();
    restore = useTempHome().restore;
  });
  afterAll(() => {
    closeDb();
    restore();
  });
  beforeEach(() => {
    getDb().exec("DELETE FROM sessions; DELETE FROM accounts; DELETE FROM assignments;");
    insertAccount(A);
    insertAccount(B);
    dir = mkdtempSync(join(tmpdir(), "fleet-"));
    adapter = new FakeAdapter("claude", dir);
    runtime = new FakeRuntime();
    fleet = new Fleet({ adapters: [adapter], runtime, usage: usageSource({ "claude-a": weekly(92, 0), "claude-b": weekly(12, 80) }) });
  });

  test("a transcript on disk becomes a stopped external session on its account", async () => {
    adapter.write(A, { agentSessionId: "s1", cwd: dir, firstPrompt: "Fix the flaky login test", lastActivityAt: Date.now() });
    await fleet.tick();
    const [s] = fleet.sessions();
    expect(s).toBeDefined();
    expect(s!.accountId).toBe("claude-a");
    expect(s!.origin).toBe("external");
    expect(s!.host).toBe("none");
    expect(s!.status).toBe("stopped");
    expect(s!.title).toBe("Fix the flaky login test");
  });

  test("a live process elsewhere makes it external and running or waiting", async () => {
    adapter.write(A, { agentSessionId: "s2", cwd: dir, turnOpen: true, lastActivityAt: Date.now() });
    adapter.live = [{ pid: process.pid, accountId: A.id, agentSessionId: "s2", cwd: dir, startedAt: 0 }];
    await fleet.tick();
    const s = fleet.sessions()[0]!;
    expect(s.host).toBe("external");
    expect(s.status).toBe("running");
    await expect(fleet.send(s.id, "hi")).rejects.toThrow("adopt");
  });

  test("spawn places by the balancer, records the assignment, and starts tmux on that account", async () => {
    const { session, placement } = await fleet.spawn({ provider: "claude", cwd: dir, prompt: "do it" });
    expect(placement.accountId).toBe("claude-a");
    expect(session.host).toBe("tmux");
    expect(session.claim).toBe(5);
    expect(runtime.started[0]!.env).toEqual({ FAKE_HOME: "/fake/claude-a" });
    expect(runtime.started[0]!.argv).toEqual(["fake", "do it"]);
    const [a] = assignmentsSince(0);
    expect(a!.sessionId).toBe(session.id);
    expect(a!.candidates.length).toBe(2);

    await fleet.send(session.id, "more");
    expect(runtime.typed).toEqual([[session.tmux!, "more"]]);
  });

  test("claims from running sessions steer the next placement", async () => {
    const first = await fleet.spawn({ provider: "claude", cwd: dir });
    const second = await fleet.spawn({ provider: "claude", cwd: dir });
    const third = await fleet.spawn({ provider: "claude", cwd: dir });
    expect([first, second, third].map((r) => r.placement.accountId)).toEqual(["claude-a", "claude-a", "claude-b"]);
    const claims = fleet.claims().get("claude-a")!;
    expect(claims.map((c) => c.outstanding)).toEqual([5, 5]);
  });

  test("nothing eligible refuses with the placement attached", async () => {
    fleet = new Fleet({ adapters: [adapter], runtime, usage: usageSource({ "claude-a": weekly(100, 0), "claude-b": weekly(100, 0) }) });
    const err = await fleet.spawn({ provider: "claude", cwd: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(FleetError);
    expect((err as FleetError).status).toBe(409);
    expect((err as FleetError).placement?.mode).toBe("none");
    // …but a manual pick goes through.
    const forced = await fleet.spawn({ provider: "claude", cwd: dir, accountId: "claude-b" });
    expect(forced.placement.mode).toBe("manual");
  });

  test("a provider that cannot preset its id is matched to the first new transcript in its directory", async () => {
    adapter.presetIds = false;
    const { session } = await fleet.spawn({ provider: "claude", cwd: dir, accountId: "claude-b" });
    expect(session.agentSessionId).toBeNull();
    // Someone else's session in the same directory, started earlier: not ours.
    adapter.write(B, { agentSessionId: "older", cwd: dir, startedAt: Date.now() - HOUR, lastActivityAt: Date.now() - HOUR });
    adapter.write(B, { agentSessionId: "ours", cwd: dir, startedAt: Date.now() + 5, lastActivityAt: Date.now() + 5 });
    (fleet as unknown as { lastDiscovery: number }).lastDiscovery = 0;
    await fleet.tick();
    expect(fleet.get(session.id).agentSessionId).toBe("ours");
    const records = listSessionRecords(0);
    expect(records.filter((r: SessionRecord) => r.agentSessionId === "ours").length).toBe(1);
  });

  test("resume refuses a claude session whose directory cannot be proven, and runs one that can", async () => {
    adapter.write(A, { agentSessionId: "r1", cwd: dir, lastActivityAt: Date.now() });
    await fleet.tick();
    const s = fleet.sessions()[0]!;
    await expect(fleet.resume(s.id)).rejects.toThrow("cannot prove");

    adapter.write(A, { agentSessionId: "r1", cwd: dir, resumeCwd: dir, lastActivityAt: Date.now() + 1000 });
    await fleet.tick();
    const resumed = await fleet.resume(s.id);
    expect(resumed.host).toBe("tmux");
    expect(runtime.started.at(-1)!.argv).toEqual(["fake", "--resume", "r1"]);
    expect(runtime.started.at(-1)!.env).toEqual({ FAKE_HOME: "/fake/claude-a" });
  });

  test("adopt never kills a process it cannot resume", async () => {
    adapter.write(A, { agentSessionId: "ad", cwd: dir, lastActivityAt: Date.now() });
    // Our own pid stands in for the external process: if adopt tried to kill
    // it, this test would die.
    adapter.live = [{ pid: process.pid, accountId: A.id, agentSessionId: "ad", cwd: dir, startedAt: 0 }];
    await fleet.tick();
    const s = fleet.sessions()[0]!;
    await expect(fleet.adopt(s.id)).rejects.toThrow("cannot prove");
  });

  test("a permission prompt on screen makes a quiet session blocked", async () => {
    const { session } = await fleet.spawn({ provider: "claude", cwd: dir });
    runtime.screens.set(session.tmux!, "Bash(rm -rf build)\n Allow? 1. Yes 2. No");
    await fleet.tick();
    expect(fleet.get(session.id).status).toBe("blocked");
  });

  test("archiving hides a stopped session's status; new activity brings it back", async () => {
    const path = adapter.write(A, { agentSessionId: "ar", cwd: dir, lastActivityAt: Date.now() });
    await fleet.tick();
    const s = fleet.sessions()[0]!;
    await fleet.archive(s.id, true);
    expect(fleet.get(s.id).status).toBe("archived");
    writeFileSync(path, JSON.stringify({ agentSessionId: "ar", cwd: dir, lastActivityAt: Date.now() + 5000 }));
    await fleet.tick();
    expect(fleet.get(s.id).status).toBe("stopped");
  });
});

describe("headline", () => {
  test("first line, trimmed at a word", () => {
    expect(headline("  \nFix it\nmore")).toBe("Fix it");
    expect(headline("/compact")).toBeNull();
    const long = "word ".repeat(30);
    expect(headline(long)!.length).toBeLessThanOrEqual(81);
  });
});
