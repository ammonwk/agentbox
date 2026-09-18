/** Reading omp's session directory: the record a fan-out leaves behind.
 *
 * The fixture beside this file (`omp-subagent.capture.jsonl`) is a real omp
 * subagent log, trimmed and with long strings clipped — envelope, two tool
 * calls with their results, an assistant message with usage, and the exit
 * line. Shapes are omp's, verbatim, because every one of them is a thing we
 * guessed at once and got wrong: the exit marker is a `custom` event rather
 * than a type, usage lives on the message rather than the session, and the
 * assignment is on `session_init` rather than in the first message.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ompSessionDir,
  ompSlugFor,
  readHubAgent,
  scanHubAgents,
} from "../ompsession";

const CAPTURE = readFileSync(join(import.meta.dir, "omp-subagent.capture.jsonl"), "utf8");
const SESSION_ID = "01a09496-0000-7000-0000-00000000cafe";

let ompRoot: string;
let previousOmpHome: string | undefined;
/** The session directory omp would have written for `CWD`. */
let sessionDir: string;
const CWD = "/tmp/agentbox-test-worktree/fanout";

/** Write one subagent's files exactly where omp puts them. */
function writeAgent(
  dir: string,
  base: string,
  opts: { log?: string; report?: string | null } = {},
) {
  mkdirSync(dirname(join(dir, base)), { recursive: true });
  writeFileSync(join(dir, `${base}.jsonl`), opts.log ?? CAPTURE);
  if (opts.report !== null && opts.report !== undefined) {
    writeFileSync(join(dir, `${base}.md`), opts.report);
  }
}

/** The capture without its trailing `session_exit` — an agent still going. */
function unfinished(): string {
  return `${CAPTURE.trim()
    .split("\n")
    .filter((l) => !l.includes("session_exit"))
    .join("\n")}\n`;
}

beforeAll(() => {
  previousOmpHome = process.env.AGENTBOX_OMP_HOME;
  ompRoot = mkdtempSync(join(tmpdir(), "agentbox-omp-"));
  process.env.AGENTBOX_OMP_HOME = ompRoot;

  sessionDir = join(
    ompRoot,
    "agent",
    "sessions",
    ompSlugFor(CWD),
    `2026-09-12T07-48-00-374Z_${SESSION_ID}`,
  );
  mkdirSync(sessionDir, { recursive: true });

  // Finished and reported.
  writeAgent(sessionDir, "Gnc5199", { report: "All five points hold. PR is merge-ready." });
  // Finished, but the report says omp aborted it.
  writeAgent(sessionDir, "Gnc5194", {
    report: JSON.stringify({ aborted: true, error: "request budget exhausted" }),
  });
  // Exited without ever writing a report.
  writeAgent(sessionDir, "Gnc5252", { report: null });
  // Still going: no exit line, no report.
  writeAgent(sessionDir, "Gnc5409", { log: unfinished(), report: null });
  // A subagent this run's subagent dispatched, which the progress stream
  // never mentions at all.
  writeAgent(join(sessionDir, "Gnc5199"), "Gnc5199.DiffAudit", { report: "No findings." });

  // Things in the directory that are not agents, all of which omp really puts
  // there: per-tool output captures and its own scratch directory.
  writeFileSync(join(sessionDir, "1203.bash.log"), "$ git status\n");
  writeFileSync(join(sessionDir, "0.read.log"), "file contents\n");
  mkdirSync(join(sessionDir, "local"), { recursive: true });
  writeFileSync(join(sessionDir, "local", "master-plan.md"), "# plan\n");
});

afterAll(() => {
  process.env.AGENTBOX_OMP_HOME = previousOmpHome;
  rmSync(ompRoot, { recursive: true, force: true });
});

describe("finding omp's directory", () => {
  test("derives the slug omp uses for a working directory", () => {
    expect(ompSlugFor("/tmp/agentbox-test-worktree/fanout")).toBe(
      "-tmp-agentbox-test-worktree-fanout",
    );
  });

  test("finds the session by its id under the cwd's slug", () => {
    expect(ompSessionDir(CWD, SESSION_ID)).toBe(sessionDir);
  });

  test("finds it anyway when the cwd no longer maps to that slug", () => {
    // A session whose worktree was reclaimed and re-cut elsewhere: the slug is
    // wrong, but the omp session id is unique, so the scan still lands on it.
    expect(ompSessionDir("/somewhere/else/entirely", SESSION_ID)).toBe(sessionDir);
  });

  test("is null without an omp session id, rather than guessing", () => {
    expect(ompSessionDir(CWD, null)).toBeNull();
  });

  test("is null for a session omp has no record of", () => {
    expect(ompSessionDir(CWD, "01a00000-0000-7000-0000-000000000000")).toBeNull();
  });
});

describe("scanning a fan-out", () => {
  test("reads every subagent, and nothing that is not one", () => {
    const names = scanHubAgents(sessionDir).map((a) => a.name);
    expect(names.sort()).toEqual(["DiffAudit", "Gnc5194", "Gnc5199", "Gnc5252", "Gnc5409"]);
  });

  test("a report means it answered", () => {
    const agent = scanHubAgents(sessionDir).find((a) => a.name === "Gnc5199")!;
    expect(agent).toMatchObject({ status: "completed", hasResult: true, parent: null });
    expect(agent.startedAt).toBe(Date.parse("2026-09-12T07:50:48.712Z"));
    expect(agent.endedAt).toBe(Date.parse("2026-09-12T08:01:24.022Z"));
  });

  test("an aborted report is a failure, not a completion", () => {
    expect(scanHubAgents(sessionDir).find((a) => a.name === "Gnc5194")).toMatchObject({
      status: "failed",
      hasResult: true,
    });
  });

  test("ending without a report is completed-but-unanswered, not failed", () => {
    // The distinction the strip shows as "ended without reporting". Calling it
    // failed would be a claim omp never made; calling it a plain completion is
    // how three parked agents went unnoticed in a fifty-way run.
    expect(scanHubAgents(sessionDir).find((a) => a.name === "Gnc5252")).toMatchObject({
      status: "completed",
      hasResult: false,
    });
  });

  test("no exit line means omp recorded no ending", () => {
    expect(scanHubAgents(sessionDir).find((a) => a.name === "Gnc5409")).toMatchObject({
      status: "running",
      endedAt: null,
      hasResult: false,
    });
  });

  test("finds subagents that subagents dispatched, and says whose they are", () => {
    // omp reports only one level to its client, so this whole branch of the
    // tree exists nowhere except on disk.
    expect(scanHubAgents(sessionDir).find((a) => a.name === "DiffAudit")).toMatchObject({
      parent: "Gnc5199",
      status: "completed",
    });
  });

  test("a deep scan counts the work the log records", () => {
    // Counted from bytes, not parsed — the numbers have to match what a full
    // parse of the same log produces, or the roster and the drilldown will
    // disagree about the same subagent.
    const scanned = scanHubAgents(sessionDir, { deep: true }).find((a) => a.name === "Gnc5199")!;
    const parsed = readHubAgent(sessionDir, "Gnc5199")!;
    expect(scanned.toolCount).toBe(parsed.toolCount);
    expect(scanned.tokens).toBe(parsed.tokens);
    expect(scanned.toolCount).toBeGreaterThan(0);
  });

  test("a cheap scan reports no counts at all, rather than zeroes", () => {
    // Zero would be a claim. Absent lets the roster keep what the live stream
    // saw, which is an underestimate but is not a lie.
    const cheap = scanHubAgents(sessionDir).find((a) => a.name === "Gnc5199")!;
    expect(cheap.toolCount).toBeUndefined();
    expect(cheap.tokens).toBeUndefined();
  });

  test("an absent directory is an empty fan-out, not a crash", () => {
    expect(scanHubAgents(null)).toEqual([]);
    expect(scanHubAgents(join(ompRoot, "nope"))).toEqual([]);
  });
});

describe("reading one subagent's log", () => {
  test("parses the assignment, the model and the usage omp recorded", () => {
    const detail = readHubAgent(sessionDir, "Gnc5199")!;
    expect(detail.task).toContain("PR #5199");
    expect(detail.agentType).toBe("task");
    expect(detail.model).toBe("opencode-go-responses/muse-spark-1.3-contributor");
    // Peak occupancy, not a sum over requests.
    expect(detail.tokens).toBeGreaterThan(0);
    expect(detail.result).toBe("All five points hold. PR is merge-ready.");
  });

  test("every tool call carries its arguments and what came back", () => {
    const detail = readHubAgent(sessionDir, "Gnc5199")!;
    const tools = detail.steps.filter((s) => s.kind === "tool");
    expect(tools.length).toBe(detail.toolCount);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toMatchObject({ tool: "read", intent: "Read green-and-clean skill" });
    // The thing the old reconstruction could never have: the result, attached
    // to the call that asked for it.
    expect(tools[0]!.output).toBeTruthy();
  });

  test("a shell call is shown as its command, not as a JSON blob", () => {
    const detail = readHubAgent(sessionDir, "Gnc5199")!;
    const bash = detail.steps.find((s) => s.tool === "bash");
    expect(bash?.args).toContain("git");
  });

  test("finds a nested subagent by its own name", () => {
    expect(readHubAgent(sessionDir, "DiffAudit")).toMatchObject({
      name: "DiffAudit",
      parent: "Gnc5199",
      result: "No findings.",
    });
  });

  test("is null for a name omp has no log for", () => {
    expect(readHubAgent(sessionDir, "NeverExisted")).toBeNull();
    expect(readHubAgent(null, "Gnc5199")).toBeNull();
  });

  test("a log that is nothing but junk yields a record, not an exception", () => {
    // Half-written lines are normal: this reads a file another process is
    // appending to.
    const dir = join(ompRoot, "agent", "sessions", "torn", `2026-01-01T00-00-00-000Z_torn`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Half.jsonl"), '{"type":"session","timestamp":"2026-01-01T00:00:00Z"}\n{"type":"mess');
    const detail = readHubAgent(dir, "Half")!;
    expect(detail.name).toBe("Half");
    expect(detail.steps).toEqual([]);
  });
});
