import { describe, expect, test } from "bun:test";
import { busy, friendly, parseCpuLine, parseMeminfo, throttleDelta } from "../system";
import {
  LoadMeter,
  classify,
  describe as describeProc,
  isToolShell,
  parseStat,
  subtree,
  subtreeCpuTicks,
  type ProcRow,
  type ProcTable,
} from "../proc";

/**
 * Only the pure parts. Everything that reads /proc or /sys is I/O against a
 * kernel and is not mocked here — the value in this file is the arithmetic that
 * turns two cumulative readings into a rate, which is where the bugs live.
 */

// ---------------------------------------------------------------- /proc/stat

interface StatFields {
  pid?: number;
  ppid?: number;
  comm?: string;
  utime?: number;
  stime?: number;
  cutime?: number;
  cstime?: number;
  starttime?: number;
  rssPages?: number;
}

function statLine(fields: StatFields = {}): string {
  // 52 fields after comm, 0-based; only 11-14 (times), 19 (starttime) and
  // 21 (rss pages) are read.
  const f = new Array(52).fill(0);
  f[0] = "R"; // state
  f[1] = fields.ppid ?? 1;
  f[11] = fields.utime ?? 0;
  f[12] = fields.stime ?? 0;
  f[13] = fields.cutime ?? 0;
  f[14] = fields.cstime ?? 0;
  f[19] = fields.starttime ?? 0;
  f[21] = fields.rssPages ?? 0;
  return `${fields.pid ?? 1} (${fields.comm ?? "bun"}) ${f.join(" ")}`;
}

describe("parseStat", () => {
  test("reads the fields the meters actually use", () => {
    const row = parseStat(
      42,
      statLine({ ppid: 7, utime: 10, stime: 5, cutime: 100, cstime: 50, starttime: 999, rssPages: 3 }),
    );
    expect(row).not.toBeNull();
    expect(row!.ppid).toBe(7);
    // Cumulative: own time PLUS everything this process has reaped.
    expect(row!.cpuTicks).toBe(165);
    // Own time only — what the per-process drilldown divides.
    expect(row!.ownTicks).toBe(15);
    expect(row!.rssKb).toBe(12);
    expect(row!.startTicks).toBe(999);
  });

  test("a comm containing spaces and parens does not shift every field", () => {
    // This is why the parser splits from the LAST close paren rather than
    // tokenising: `node (vitest 1)` is a real comm, and naive splitting moves
    // utime into stime's slot and reports nonsense CPU forever after.
    const row = parseStat(9, statLine({ comm: "node (vitest 1)", utime: 33, stime: 7 }));
    expect(row).not.toBeNull();
    expect(row!.comm).toBe("node (vitest 1)");
    expect(row!.ownTicks).toBe(40);
  });

  test("a truncated line is dropped rather than half-read", () => {
    expect(parseStat(1, "1 (bun) R 1 2 3")).toBeNull();
    expect(parseStat(1, "garbage with no parens")).toBeNull();
  });
});

// ----------------------------------------------------------------- host cpu

describe("cpu busy fraction", () => {
  const line = (user: number, idle: number) => parseCpuLine([String(user), "0", "0", String(idle)]);

  test("is zero on the first sample, because one reading has no rate", () => {
    expect(busy(undefined, line(100, 100))).toBe(0);
  });

  test("half idle reads as half busy", () => {
    expect(busy(line(0, 0), line(50, 50))).toBeCloseTo(0.5, 5);
  });

  test("counters that did not move do not divide by zero", () => {
    const same = line(10, 10);
    expect(busy(same, same)).toBe(0);
  });

  test("clamps into 0..1 when counters go backwards", () => {
    // A CPU coming back from suspend can present a lower idle than before.
    const v = busy(line(0, 500), line(50, 50));
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("throttleDelta", () => {
  test("reports nothing without a previous sample", () => {
    expect(throttleDelta(undefined, { count: 5, totalMs: 500 }, 2000)).toEqual({
      throttleDuty: 0,
      throttling: false,
    });
  });

  test("duty is the share of the interval, not the since-boot total", () => {
    // 500ms of throttling inside a 2s interval is 25% — even though the
    // since-boot total is 10 seconds.
    const d = throttleDelta({ count: 1, totalMs: 9_500 }, { count: 4, totalMs: 10_000 }, 2_000);
    expect(d.throttleDuty).toBeCloseTo(0.25, 5);
    expect(d.throttling).toBe(true);
  });

  test("a count that moved with no measurable time still counts as throttling", () => {
    // Bursts of tens of milliseconds are exactly why the boolean exists
    // alongside the duty cycle.
    const d = throttleDelta({ count: 1, totalMs: 100 }, { count: 2, totalMs: 100 }, 2_000);
    expect(d.throttleDuty).toBe(0);
    expect(d.throttling).toBe(true);
  });

  test("never exceeds 1", () => {
    expect(throttleDelta({ totalMs: 0 }, { totalMs: 9_000 }, 2_000).throttleDuty).toBe(1);
  });
});

describe("parseMeminfo", () => {
  test("converts kB to bytes and ignores lines without a unit", () => {
    const mem = parseMeminfo(
      ["MemTotal:       32000000 kB", "MemAvailable:   16000000 kB", "HugePages_Total:       0"].join(
        "\n",
      ),
    );
    expect(mem.MemTotal).toBe(32_000_000 * 1024);
    expect(mem.MemAvailable).toBe(16_000_000 * 1024);
    expect(mem.HugePages_Total).toBeUndefined();
  });
});

describe("friendly sensor names", () => {
  test("keeps only sensors somebody could act on", () => {
    expect(friendly("coretemp", "Package id 0")).toBe("cpu");
    expect(friendly("nvme", "Composite")).toBe("ssd");
    expect(friendly("spd5118", "")).toBe("ram");
    // An unlabelled ACPI zone cannot be attributed to any component, so it is
    // a number nobody can do anything with.
    expect(friendly("acpitz", "")).toBeNull();
  });
});

// -------------------------------------------------------------- the subtree

function table(rows: ProcRow[], at = 0): ProcTable {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const sib = children.get(r.ppid);
    if (sib) sib.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  return { at, byPid, children };
}

function row(pid: number, ppid: number, over: Partial<ProcRow> = {}): ProcRow {
  return {
    pid,
    ppid,
    comm: "bun",
    cpuTicks: 0,
    ownTicks: 0,
    rssKb: 0,
    startTicks: 0,
    ...over,
  };
}

describe("subtree", () => {
  test("collects the root and every descendant", () => {
    const t = table([row(100, 1), row(200, 100), row(300, 200), row(999, 1)]);
    expect(subtree(t, 100).map((r) => r.pid).sort()).toEqual([100, 200, 300]);
  });

  test("an agent with no children is still itself", () => {
    // The normal state of an idle `omp acp`: one process, no subtree.
    const t = table([row(100, 1)]);
    expect(subtree(t, 100).map((r) => r.pid)).toEqual([100]);
  });

  test("a pid that is gone yields nothing rather than throwing", () => {
    expect(subtree(table([row(1, 0)]), 4242)).toEqual([]);
  });

  test("sums cumulative ticks across the whole subtree", () => {
    const t = table([
      row(100, 1, { cpuTicks: 10 }),
      row(200, 100, { cpuTicks: 20 }),
      row(300, 200, { cpuTicks: 5 }),
    ]);
    expect(subtreeCpuTicks(subtree(t, 100))).toBe(35);
  });
});

describe("LoadMeter", () => {
  test("the first sample has no rate to report", () => {
    const m = new LoadMeter();
    const s = m.sample(table([row(100, 1, { cpuTicks: 500 })], 1000), 100);
    expect(s?.cpuPct).toBe(0);
    expect(s?.history).toEqual([]);
  });

  test("turns a tick delta into percent of one core", () => {
    const m = new LoadMeter();
    m.sample(table([row(100, 1, { cpuTicks: 0 })], 0), 100);
    // 100 ticks at 100Hz over 1s is one core fully busy.
    const s = m.sample(table([row(100, 1, { cpuTicks: 100 })], 1000), 100);
    expect(s!.cpuPct).toBeCloseTo(100, 0);
    expect(s!.history).toHaveLength(1);
  });

  test("counts a reaped child's time, which is the whole point of cutime", () => {
    const m = new LoadMeter();
    m.sample(table([row(100, 1, { cpuTicks: 0 })], 0), 100);
    // The `git status` that ran and exited between polls is never seen as a
    // process; its time arrives folded into the parent's cutime. Summing only
    // live processes would report this second as idle.
    const s = m.sample(table([row(100, 1, { cpuTicks: 50 })], 1000), 100);
    expect(s!.cpuPct).toBeCloseTo(50, 0);
  });

  test("a falling total is missing information, not negative CPU", () => {
    const m = new LoadMeter();
    m.sample(table([row(100, 1, { cpuTicks: 500 })], 0), 100);
    // A subtree orphaned onto init takes its accumulated time with it.
    const s = m.sample(table([row(100, 1, { cpuTicks: 100 })], 1000), 100);
    expect(s!.cpuPct).toBe(0);
  });

  test("memory is labelled rss until a PSS pass has run", () => {
    const m = new LoadMeter();
    const t = table([row(100, 1, { rssKb: 1024 }), row(200, 100, { rssKb: 1024 })], 0);
    expect(m.sample(t, 100)).toMatchObject({ memKind: "rss", memBytes: 2 * 1024 * 1024, procs: 2 });

    m.putPss(100, 1_500_000);
    expect(m.sample(t, 100)).toMatchObject({ memKind: "pss", memBytes: 1_500_000 });
  });

  test("a vanished subtree reports nothing rather than zero", () => {
    const m = new LoadMeter();
    expect(m.sample(table([row(1, 0)], 0), 100)).toBeUndefined();
  });

  test("retain drops meters for pids that are gone", () => {
    const m = new LoadMeter();
    m.sample(table([row(100, 1, { cpuTicks: 0 })], 0), 100);
    m.retain(new Set()); // the session ended
    // With the prior forgotten, the next reading is a first sample again
    // rather than a spike measured against a dead process's counters.
    const s = m.sample(table([row(100, 1, { cpuTicks: 10_000 })], 1000), 100);
    expect(s!.cpuPct).toBe(0);
  });

  test("history is bounded", () => {
    const m = new LoadMeter();
    for (let i = 0; i <= 80; i++) {
      m.sample(table([row(100, 1, { cpuTicks: i * 10 })], i * 1000), 100);
    }
    expect(m.sample(table([row(100, 1, { cpuTicks: 999 })], 90_000), 100)!.history).toHaveLength(60);
  });
});

// ------------------------------------------------------------- classifying

describe("isToolShell", () => {
  test("a shell running -c is work the agent asked for", () => {
    expect(isToolShell("/bin/bash -c git status")).toBe(true);
    expect(isToolShell("sh -c 'bun test'")).toBe(true);
  });

  test("Claude Code's snapshot wrapper is recognised outright", () => {
    expect(isToolShell("/bin/bash -c source /home/u/.claude/shell-snapshots/snap.sh && eval 'ls'")).toBe(
      true,
    );
  });

  test("a long-lived server is not a tool call", () => {
    expect(isToolShell("node /opt/mcp-servers/linear/dist/index.js")).toBe(false);
    // An interactive shell is not a tool call either — no -c, no command.
    expect(isToolShell("/bin/bash")).toBe(false);
    expect(isToolShell(undefined)).toBe(false);
  });
});

describe("classify", () => {
  const agentPid = 100;

  test("the root is the agent", () => {
    expect(classify(row(100, 1), agentPid)).toBe("agent");
  });

  test("a direct child splits on whether it is a tool shell", () => {
    expect(classify(row(200, 100, { cmd: "bash -c bun test" }), agentPid, "agent")).toBe("tool");
    expect(classify(row(201, 100, { cmd: "node /srv/mcp/dist/index.js" }), agentPid, "agent")).toBe(
      "mcp",
    );
  });

  test("everything under a tool call is part of that tool call", () => {
    // The `tsc` under the `bash -c bun run typecheck` is the work, and it is
    // the process actually holding the memory.
    expect(classify(row(300, 200, { cmd: "tsc --noEmit" }), agentPid, "tool")).toBe("tool");
  });

  test("descendants of an mcp server stay attributed to it", () => {
    expect(classify(row(301, 201, { cmd: "python3 worker.py" }), agentPid, "mcp")).toBe("mcp");
  });
});

describe("describe", () => {
  test("prefers the command line over the kernel's truncated comm", () => {
    expect(describeProc(row(1, 0, { comm: "npm exec slack-", cmd: "npm exec slack-mcp --port 3000" })))
      .toContain("slack-mcp");
  });

  test("names an MCP server by its package, not by index.js", () => {
    expect(describeProc(row(1, 0, { cmd: "node /opt/mcp-servers/linear/dist/index.js" }))).toBe(
      "linear",
    );
  });

  test("unwraps a shell tool call to the command that was run", () => {
    expect(describeProc(row(1, 0, { cmd: "/bin/bash -c bun run typecheck" }))).toBe("bun run typecheck");
  });

  test("unwraps Claude Code's snapshot preamble to the eval'd command", () => {
    const cmd = "/bin/bash -c source /home/u/.claude/shell-snapshots/s.sh && eval 'git status --short'";
    expect(describeProc(row(1, 0, { cmd }))).toBe("git status --short");
  });

  test("falls back to comm while a process is mid-exec with an empty cmdline", () => {
    expect(describeProc(row(1, 0, { comm: "node (vitest 4)", cmd: "" }))).toBe("vitest 4");
    expect(describeProc(row(1, 0, { comm: "tsc" }))).toBe("tsc");
  });

  test("truncates rather than letting one row set the table width", () => {
    const long = describeProc(row(1, 0, { cmd: `bash -c ${"x".repeat(200)}` }));
    expect(long.length).toBeLessThanOrEqual(44);
    expect(long.endsWith("…")).toBe(true);
  });
});
