/** `agentbox watch` — what the agents are doing, in a terminal.
 *
 * The status line has room for one line and the web view needs a browser.
 * This is for the case in between, which is most of them: you are already in a
 * terminal, something has been running for a while, and you want to know
 * whether to leave it alone.
 *
 * It reads the record on disk rather than talking to anything. The process
 * that owns an agent is a short-lived MCP server on somebody's stdio with no
 * address, so a watcher that needed to reach it could not exist; a watcher
 * that reads files works for running agents, finished ones, and ones whose
 * owner was killed an hour ago — and it says which is which, because a
 * snapshot nobody has refreshed means nobody is there.
 */

import { budget, healthWord, renderBudget, verdict, duration } from "../core/health";
import {
  listRecords,
  readEvents,
  readRecord,
  requestCommand,
  type AgentRecord,
} from "../core/record";
import { shortPlace } from "../core/place";

const TICK_MS = 2000;

/** Colour only when somebody is looking. Piped output goes into `grep`. */
const tty = process.stdout.isTTY === true;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);

/** Concerns that mean "something is wrong" as against "worth knowing". The
 *  colour is doing the same job as the ordering in `health.ts`. */
function paint(word: string): string {
  if (word === "looping" || word === "quiet" || word === "died" || word === "abandoned") {
    return red(word);
  }
  if (word === "context" || word === "overrunning" || word === "silent") return yellow(word);
  if (word === "working") return green(word);
  return dim(word);
}

function place(rec: AgentRecord): string {
  return shortPlace({
    path: rec.meta.cwd,
    toplevel: rec.meta.cwd,
    branch: rec.meta.branch,
    dirty: null,
  });
}

/**
 * One line per agent, plus the reason underneath when there is one.
 *
 * Sorted so the ones in trouble are at the top: a roster read top-down should
 * put the thing you need to act on where your eye already is.
 */
function roster(now: number): string {
  const records = listRecords(now);
  const live = records.filter((r) => r.snapshot !== null && !r.stale);
  const abandoned = records.filter(
    (r) => r.snapshot !== null && r.stale && r.snapshot.state === "running",
  );
  if (live.length === 0 && abandoned.length === 0) {
    return dim("No agents running. Finished ones: `agentbox watch <name>`.");
  }

  const rows = live.map((rec) => {
    const snap = rec.snapshot!;
    const v = verdict(snap, now);
    return { rec, snap, v, rank: v.concern === null ? 1 : 0 };
  });
  rows.sort((a, b) => a.rank - b.rank || a.snap.name.localeCompare(b.snap.name));

  const out: string[] = [];
  for (const { rec, snap, v } of rows) {
    const word = healthWord(v, snap);
    out.push(
      `${bold(snap.name.padEnd(22))} ${dim(place(rec).padEnd(28))} ${paint(word)}`,
      `  ${dim(renderBudget(budget(snap, now)))}`,
      `  ${dim("now:")} ${snap.lastAction || "starting"}`,
    );
    for (const f of v.findings) out.push(`  ${paint(f.concern)}: ${f.note}`);
    out.push("");
  }

  // An agent whose owner died still has a record claiming it is running. Say
  // so plainly rather than either hiding it or showing it as live: the process
  // is gone, and the difference matters to anyone deciding whether to wait.
  for (const rec of abandoned) {
    out.push(
      `${bold(rec.meta.name.padEnd(22))} ${dim(place(rec).padEnd(28))} ${red("abandoned")}`,
      `  ${dim(`its owner (pid ${rec.meta.pid}) stopped reporting; the agent is gone`)}`,
      "",
    );
  }
  return out.join("\n");
}

/** One agent in full: what it was asked, how it is doing, what it has done. */
function detail(query: string, now: number): string {
  const records = listRecords(now);
  const matches = records.filter((r) => r.id === query || r.meta.name === query);
  const rec = matches[0];
  if (!rec) {
    const known = records.slice(0, 12).map((r) => `  ${r.meta.name}  ${dim(r.id)}`);
    return known.length === 0
      ? `No agent called "${query}", and no records at all.`
      : `No agent called "${query}". Recent ones:\n${known.join("\n")}`;
  }

  const out: string[] = [];
  const snap = rec.snapshot;
  out.push(bold(rec.meta.name), dim(`${rec.id}  ${rec.meta.cwd}  ${rec.meta.branch ?? "-"}`));
  if (snap === null) {
    out.push(red("no state was ever published for this agent"));
  } else {
    const v = verdict(snap, now);
    const label = rec.stale && snap.state === "running" ? "abandoned" : healthWord(v, snap);
    out.push(`${paint(label)}   ${dim(renderBudget(budget(snap, now)))}`);
    for (const f of v.findings) out.push(`${paint(f.concern)}: ${f.note}`);
    if (snap.partial) out.push("", dim("saying:"), snap.partial);
  }

  out.push("", dim("brief:"), rec.meta.prompt.split("\n").slice(0, 6).join("\n"));

  const events = readEvents(rec.dir, 400);
  const calls = events.filter((e) => e.type === "tool");
  out.push("", dim(`${calls.length} tool call${calls.length === 1 ? "" : "s"} on record:`));
  for (const e of calls.slice(-25)) {
    const call = e.call as { title?: string; kind?: string; ms?: number | null } | undefined;
    const took = call?.ms == null ? dim("running") : dim(duration(call.ms));
    out.push(`  ${(call?.title || call?.kind || "?").slice(0, 70).padEnd(70)} ${took}`);
  }

  const turns = events.filter((e) => e.type === "turn");
  for (const e of turns.slice(-1)) {
    const report = (e.report as { report?: string } | undefined)?.report;
    if (report) out.push("", dim("last answer:"), report.slice(0, 2000));
  }
  return out.join("\n");
}

function draw(body: string): void {
  // Clear and home. Redrawing the whole frame is fine at this size and avoids
  // every problem that comes with tracking what changed.
  process.stdout.write(tty ? `\x1b[2J\x1b[H${body}\n` : `${body}\n`);
}

/**
 * `watch` with no argument is a live roster; with a name it is one agent.
 * `--once` prints a frame and exits, which is what a script wants.
 */
export async function watch(argv: string[]): Promise<number> {
  const once = argv.includes("--once") || !tty;
  const rest = argv.filter((a) => !a.startsWith("--"));
  const target = rest[0];

  const command = argv.includes("--interrupt")
    ? "interrupt"
    : argv.includes("--stop")
      ? "stop"
      : null;
  if (command !== null) {
    if (target === undefined) {
      console.error(`agentbox watch --${command}: name an agent`);
      return 2;
    }
    const rec = listRecords().find((r) => r.id === target || r.meta.name === target);
    if (!rec) {
      console.error(`no agent called "${target}"`);
      return 1;
    }
    requestCommand(rec.dir, command);
    // The owner sweeps on the same beat it publishes on, so this is a request
    // rather than an act. Saying so is more honest than printing "stopped".
    console.log(`asked ${rec.meta.name}'s owner to ${command} it; it sweeps every ~2s`);
    return 0;
  }

  const frame = () => (target === undefined ? roster(Date.now()) : detail(target, Date.now()));
  if (once) {
    draw(frame());
    return 0;
  }

  draw(frame());
  const timer = setInterval(() => draw(frame()), TICK_MS);
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

export { readRecord };
