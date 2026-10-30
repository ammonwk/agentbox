import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getSessionRecord, getWait, insertAccount, insertSessionRecord, insertWait, updateWait, type SessionRecord } from "../db";
import { Fleet, type Runtime } from "../fleet";
import { claudeAdapter } from "../providers/claude";
import { markScheduled } from "../schedule-sessions";
import { Scheduler, type AgentsPort } from "../scheduler";
import { Waits } from "../waits";
import type { PaneInfo } from "../tmux";

const dir = mkdtempSync(join(tmpdir(), "agentbox-close-finished-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };
const now = Date.now();
const min = 60_000;

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  mkdirSync(process.env.HOME, { recursive: true });
  closeDb();
});
afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});

test("a parked scheduled session told its wait ended is not closed as finished before it takes that turn", async () => {
  // 10-25: the nightly release, parked on a run, was told the run concluded
  // and closed as finished in the same pass, before the resume it was told by got going.
  const panes: PaneInfo[] = [];
  const runtime: Runtime = {
    listPanes: async () => panes,
    newSession: (s) => {
      panes.push({ name: s.name, pid: 99999981, dead: false, activity: now / 1000 } as PaneInfo);
      return 0;
    },
    killSession: () => {},
    sendText: async () => {},
    sendKeys: () => {},
    capture: () => "",
    captureMany: () => new Map(),
  };
  insertAccount({ id: "nightly-account", provider: "claude", label: "nightly", email: null, plan: null, home: join(dir, "account"), isDefault: false, enabled: true, createdAt: now });
  insertSessionRecord({ id: "nightly", provider: "claude", agentSessionId: "00000000-0000-4000-8000-000000000250", accountId: "nightly-account", cwd: dir, worktree: null,
    label: "Nightly release", claim: 1, origin: "agentbox", scope: "personal", tmux: null, transcriptPath: null, startedAt: now - 180 * min, lastActivityAt: now - 136 * min,
    archivedAt: null, parkedAt: now - 75 * min, facts: { resumeCwd: dir, lastMessage: "STATUS: waiting on run 40153567218" }, createdAt: now - 180 * min } as SessionRecord);
  markScheduled("nightly", "nightly-schedule", now - 180 * min);
  const wait = insertWait({ sessionId: "nightly", spec: { kind: "run", repo: "o/r", run: 40153567218 }, createdAt: now - 140 * min, deadline: now + 60 * min });
  updateWait(wait.id, { ended: "happened", endedAt: now, outcome: "The run concluded: success." });

  const fleet = new Fleet({ adapters: [claudeAdapter], runtime, usage: { usageOf: () => null } });
  await fleet.tick();
  await new Waits(fleet).tick();
  // The tell runs behind the waits' pass: a resume, here.
  for (let i = 0; i < 200 && getWait(wait.id)!.toldAt === null; i++) await Bun.sleep(5);
  expect(getWait(wait.id)!.toldAt).not.toBeNull();
  // The next pass sees the wait told, and the resumed pane not yet at its turn.
  await fleet.tick();
  expect(fleet.get("nightly")).toMatchObject({ host: "tmux", status: "waiting", waits: [] });

  await new Scheduler(fleet, () => ({}) as AgentsPort, () => {}, () => now).tick();
  expect(getSessionRecord("nightly")!.archivedAt).toBeNull();
});
