/**
 * No agent agentbox launches may carry its prompt or its briefing on the
 * command line.
 *
 * `pgrep -f` reads command lines, so an agent whose prompt is an argument is
 * found by any word in it — and a `pkill -f` on one of them kills it, and
 * every other agent that was told the same words. On 2026-10-21 a
 * `pkill -f release-rehearsal` killed seven sessions for exactly this: the
 * words were in their argv.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bridge is a service of its own; a launch must not start one to be read.
mock.module("../bridge/service", () => ({
  ensureBridge: () => {},
  restartBridge: () => {},
  bridgeUp: async () => true,
}));

import { Fleet, type Runtime } from "../fleet";
import { claudeAdapter } from "../providers/claude";
import { codexAdapter } from "../providers/codex";
import { ompAdapter } from "../providers/omp";
import { createOpencodeAdapter } from "../providers/opencode";
import { createDevinAdapter } from "../providers/devin";
import { museAdapter } from "../providers/muse";
import { insertAccount, closeDb } from "../db";
import type { Account } from "../types";
import type { NewSession } from "../tmux";

const dir = mkdtempSync(join(tmpdir(), "agentbox-argv-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };

const PROMPT = "run the release rehearsal in src/ops/release-rehearsal.ts";
const BRIEFING = "You are running in agentbox, whose web UI shows the user your replies as Markdown.";

const account: Account = { id: "fixture", provider: "claude", label: "fixture", email: null, plan: null, home: join(dir, "home"), isDefault: true, enabled: true, createdAt: 0 };

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  closeDb();
});
afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});

test("no provider puts the words of a prompt or a briefing on the command line", () => {
  const promptFile = join(dir, "prompt.md");
  const briefingFile = join(dir, "briefing.md");
  writeFileSync(promptFile, PROMPT);
  writeFileSync(briefingFile, BRIEFING);
  const adapters = [claudeAdapter, codexAdapter, ompAdapter, createOpencodeAdapter(), createDevinAdapter(), museAdapter];
  for (const adapter of adapters) {
    const opts = { session: "fixture", account, cwd: dir, promptFile, briefingFile, autoApprove: true };
    const argv = [...adapter.spawnCommand(opts).argv, ...adapter.resumeCommand({ ...opts, agentSessionId: "fixture-session" }).argv].join(" ");
    expect(argv, adapter.id).not.toContain(PROMPT);
    expect(argv, adapter.id).not.toContain(BRIEFING);
  }
});

test("a session the fleet starts carries no prompt on its command line", async () => {
  const launches: NewSession[] = [];
  const runtime: Runtime = {
    listPanes: async () => [],
    newSession: s => { launches.push(s); return 0; },
    killSession: () => {},
    sendText: async () => {},
    sendKeys: () => {},
    capture: () => null,
    captureMany: () => new Map(),
  };
  insertAccount({ ...account, id: "fixture-account", provider: "claude", home: join(dir, "account"), isDefault: false });
  const fleet = new Fleet({ adapters: [claudeAdapter], runtime, usage: { usageOf: () => null } });
  await fleet.spawn({ provider: "claude", cwd: dir, prompt: PROMPT });
  expect(launches).toHaveLength(1);
  const argv = launches[0]!.argv.join(" ");
  expect(argv).not.toContain(PROMPT);
  expect(argv).not.toContain(BRIEFING);
  // The prompt is in a file the launch names, and the file holds it.
  expect(launches[0]!.stdinFile).toBeTruthy();
  expect(Bun.file(launches[0]!.stdinFile!).text()).resolves.toContain(PROMPT);
});

test("a launch carried over from another terminal keeps its prompt in a file", async () => {
  // The same words an agent would be told, in the argv of a session some
  // other terminal started: adopt carries that launch over.
  const words = "you are a pirate and the rehearsal starts at dawn";
  const where = { sessionId: "carried", cwd: dir };
  const adapters = [claudeAdapter, codexAdapter, ompAdapter];
  const cases: [string, string[]][] = [
    ["claude", ["claude", "--append-system-prompt", words, "--model", "opus"]],
    ["codex", ["codex", "-c", `developer_instructions=${JSON.stringify(words)}`, "--model", "gpt-5"]],
    ["omp", ["omp", `--append-system-prompt=${words}`, "--model", "some-model"]],
  ];
  for (const [id, argv] of cases) {
    const adapter = adapters.find((a) => a.id === id)!;
    const carried = adapter.carryOver?.(argv, where) ?? [];
    expect(carried.join(" "), id).not.toContain(words);
    // The session keeps the prompt it was launched with: the words are in a
    // file the launch names.
    const path = /(\/[^\s"]*carried-[^\s"]*\.md)/.exec(carried.join(" "))?.[1];
    expect(path, id).toBeTruthy();
    expect(await Bun.file(path!).text(), id).toContain(words);
  }
});

test("a prompt a provider reads from a file is carried as the path it is", () => {
  // omp reads a one-line value as a file: a path stays a path.
  const file = join(dir, "own-prompt.md");
  writeFileSync(file, PROMPT);
  const carried = ompAdapter.carryOver?.(["omp", `--append-system-prompt=${file}`], { sessionId: "carried", cwd: dir }) ?? [];
  expect(carried).toContain(`--append-system-prompt=${file}`);
});
