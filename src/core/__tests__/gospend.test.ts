import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db";
import {
  closeGoSpend,
  configureGoSpend,
  goSpendDollars,
  goSpendPass,
  goSpendReady,
  goSpendWindows,
  ompCall,
  opencodeCalls,
} from "../accounts/gospend";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-06T12:00:00Z");

const dir = mkdtempSync(join(tmpdir(), "agentbox-gospend-"));
const ompRoot = join(dir, "omp", "sessions");
const ocFile = join(dir, "opencode.db");
const savedHome = process.env.AGENTBOX_HOME;

const OMP_ID = "01a0a1a1-e083-7000-9424-28bd09fdb5fe";
const OMP_FILE = join(ompRoot, "-proj", `2026-10-06T10-00-00-000Z_${OMP_ID}.jsonl`);
const OMP_SUB = join(ompRoot, "-proj", `2026-10-06T10-00-00-000Z_${OMP_ID}`, "Explore.jsonl");
const OMP_TOOLLOG = join(ompRoot, "-proj", `2026-10-06T10-00-00-000Z_${OMP_ID}`, "12.jsonl");

/** Sessions pinned to accounts: everything else is the default's. */
const pins = new Map<string, string>([
  [`omp:${OMP_ID}`, "acct-b"],
  ["opencode:ses_root", "acct-c"],
]);

let now = NOW;
let oc: Database;

const ompLine = (at: number, provider: string, cost: number) =>
  JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider, usage: { cost: { total: cost } } } }) + "\n";

function ocRow(session: string, seq: number, at: number, data: object, type = "assistant") {
  oc.query("INSERT OR REPLACE INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    `${session}-${seq}`,
    session,
    type,
    seq,
    at,
    at,
    JSON.stringify(data),
  );
}
const goMsg = (cost: number, completed: number | null, providerID = "opencode-go") => ({
  model: { id: "deepseek-v4.1-flash", providerID },
  cost,
  time: completed === null ? { created: completed } : { created: completed - 1000, completed },
});

beforeAll(() => {
  process.env.AGENTBOX_HOME = join(dir, "home");
  closeDb();
  mkdirSync(join(ompRoot, "-proj", `2026-10-06T10-00-00-000Z_${OMP_ID}`), { recursive: true });
  oc = new Database(ocFile);
  oc.exec("PRAGMA journal_mode = WAL");
  oc.exec("CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, time_updated integer NOT NULL DEFAULT 0)");
  oc.exec(`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`);
  oc.exec("CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq)");
  oc.exec("CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq)");
  oc.exec("CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)");
  oc.query("INSERT INTO session_v2 (id, parent_id) VALUES ('ses_root', NULL), ('ses_child', 'ses_root'), ('ses_hand', NULL)").run();
  configureGoSpend({
    ompRoot: () => ompRoot,
    opencodeDb: () => ocFile,
    accountFor: (p, id) => pins.get(`${p}:${id}`) ?? null,
    defaultAccount: () => "acct-default",
    now: () => now,
  });
});

afterAll(() => {
  closeGoSpend();
  oc.close();
  closeDb();
  if (savedHome === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

const dollars = (a: string) => goSpendDollars(a, now);

describe("ompCall", () => {
  test("only OpenCode Go assistant calls with a cost", () => {
    expect(ompCall(ompLine(NOW, "opencode-go", 0.5).trim())).toEqual({ at: NOW, cost: 0.5 });
    expect(ompCall(ompLine(NOW, "opencode-go-responses", 0.25).trim())).toEqual({ at: NOW, cost: 0.25 });
    expect(ompCall(ompLine(NOW, "opencode-zen", 0.5).trim())).toBeNull();
    expect(ompCall(ompLine(NOW, "opencode-go", 0).trim())).toBeNull();
    expect(ompCall('{"type":"message","message":{"role":"user","content":"opencode-go"}}')).toBeNull();
    expect(ompCall("not json opencode-go assistant")).toBeNull();
  });
});

describe("opencodeCalls", () => {
  const row = (seq: number, done: number | null, cost = 1, provider = "opencode-go", updated = NOW) => ({
    seq, time_created: NOW - 5000, time_updated: updated, provider, cost, done,
  });
  test("stops at the first streaming Go row, and resumes there", () => {
    const r = opencodeCalls([row(3, NOW), row(5, null), row(7, NOW)], 0, NOW);
    expect(r.calls.length).toBe(1);
    expect(r.next).toBe(5);
  });
  test("an unfinished row of another provider does not hold the cursor", () => {
    expect(opencodeCalls([row(3, null, 1, "opencode"), row(4, NOW)], 0, NOW)).toEqual({ calls: [{ at: NOW, cost: 1 }], next: 5 });
  });
  test("a row abandoned long ago, with rows after it, is skipped", () => {
    const r = opencodeCalls([row(3, null, 1, "opencode-go", NOW - HOUR), row(4, NOW)], 0, NOW);
    expect(r).toEqual({ calls: [{ at: NOW, cost: 1 }], next: 5 });
  });
});

describe("the ledger", () => {
  beforeEach(() => {
    now = NOW;
  });

  test("backfill attributes omp, its subagents and opencode, skipping old calls", async () => {
    expect(goSpendReady()).toBe(false);
    writeFileSync(
      OMP_FILE,
      '{"type":"session","title":"x"}\n' +
        ompLine(NOW - HOUR, "opencode-go", 1) +
        ompLine(NOW - 40 * DAY, "opencode-go", 100) + // older than any window
        ompLine(NOW - HOUR, "opencode-zen", 50), // Zen is not Go
    );
    writeFileSync(OMP_SUB, ompLine(NOW - 2 * HOUR, "opencode-go-responses", 2));
    writeFileSync(OMP_TOOLLOG, ompLine(NOW - 2 * HOUR, "opencode-go", 99)); // a tool log, not an agent
    ocRow("ses_root", 1, NOW - 3 * HOUR, { text: "hi" }, "user");
    ocRow("ses_root", 2, NOW - 3 * HOUR, goMsg(4, NOW - 3 * HOUR));
    ocRow("ses_child", 1, NOW - 3 * HOUR, goMsg(8, NOW - 3 * HOUR));
    ocRow("ses_hand", 1, NOW - 6 * DAY, goMsg(16, NOW - 6 * DAY));
    ocRow("ses_hand", 2, NOW - 40 * DAY, goMsg(32, NOW - 40 * DAY));
    await goSpendPass();
    expect(goSpendReady()).toBe(true);
    expect(dollars("acct-b")).toEqual({ "rolling-5h": 3, weekly: 3, monthly: 3 });
    expect(dollars("acct-c")).toEqual({ "rolling-5h": 12, weekly: 12, monthly: 12 });
    expect(dollars("acct-default")).toEqual({ "rolling-5h": 0, weekly: 16, monthly: 16 });
  });

  test("a second pass counts nothing again, even after a restart", async () => {
    await goSpendPass();
    configureGoSpend({
      ompRoot: () => ompRoot,
      opencodeDb: () => ocFile,
      accountFor: (p, id) => pins.get(`${p}:${id}`) ?? null,
      defaultAccount: () => "acct-default",
      now: () => now,
    });
    await goSpendPass();
    expect(dollars("acct-b").monthly).toBe(3);
    expect(dollars("acct-c").monthly).toBe(12);
  });

  test("appends and half-written lines", async () => {
    const line = ompLine(NOW - 10 * MIN, "opencode-go", 0.5);
    appendFileSync(OMP_FILE, line.slice(0, 20));
    await goSpendPass();
    expect(dollars("acct-b").monthly).toBe(3);
    appendFileSync(OMP_FILE, line.slice(20));
    await goSpendPass();
    expect(dollars("acct-b").monthly).toBe(3.5);
  });

  test("a streaming opencode row is counted once it completes, and rows after it wait", async () => {
    ocRow("ses_root", 3, NOW - MIN, goMsg(1, null));
    ocRow("ses_root", 4, NOW - MIN, goMsg(2, NOW - MIN));
    await goSpendPass();
    expect(dollars("acct-c").monthly).toBe(12);
    ocRow("ses_root", 3, NOW - MIN, goMsg(1.5, NOW - MIN));
    await goSpendPass();
    expect(dollars("acct-c").monthly).toBe(15.5);
    await goSpendPass();
    expect(dollars("acct-c").monthly).toBe(15.5);
  });

  test("windows: percent of each limit, resetting as the oldest spend ages out", () => {
    const w = goSpendWindows("acct-c", now);
    expect(w.map((x) => x.id)).toEqual(["opencode-go:rolling-5h", "opencode-go:weekly", "opencode-go:monthly"]);
    expect(w.map((x) => x.kind)).toEqual(["short", "weekly", "monthly"]);
    expect(w.every((x) => x.provider === "opencode-go")).toBe(true);
    // $15.50 against $12 / $30 / $60.
    expect(w[0]!.usedPct).toBe(100);
    expect(w[1]!.usedPct).toBeCloseTo((15.5 / 30) * 100, 5);
    expect(w[2]!.usedPct).toBeCloseTo((15.5 / 60) * 100, 5);
    const oldest = Math.floor((NOW - 3 * HOUR) / MIN) * MIN;
    expect(w[0]!.resetsAt).toBe(oldest + 5 * HOUR);
    expect(w[1]!.resetsAt).toBe(oldest + 7 * DAY);
    // Six hours on, the 5-hour window has emptied.
    const later = goSpendWindows("acct-c", NOW + 6 * HOUR);
    expect(later[0]!.usedPct).toBe(0);
    expect(later[0]!.resetsAt).toBeNull();
    expect(goSpendWindows("nobody", now).every((x) => x.usedPct === 0 && x.resetsAt === null)).toBe(true);
  });

  test("a file rewritten shorter is not counted again", async () => {
    writeFileSync(OMP_SUB, ompLine(NOW - MIN, "opencode-go", 7).slice(0, 10) + "\n");
    await goSpendPass();
    expect(dollars("acct-b").monthly).toBe(3.5);
  });

  test("spend older than the month is pruned", async () => {
    now = NOW + 40 * DAY;
    await goSpendPass();
    const n = (getDb().query("SELECT count(*) AS n FROM go_spend").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
