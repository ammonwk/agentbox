import { useEffect, useState } from "react";
import { api, fmtBytes, useMetrics, type LoadDetail, type ProcDetail, type ProcRole } from "../../api";
import { Empty } from "../../components";
import { fmtDur } from "../../lib/format";

/**
 * Where a session's CPU and memory actually went.
 *
 * A process list can only say "4.4 GB", which is the number that makes you ask the
 * question, not the one that answers it. This is the answer: every process in
 * the subtree, what it is, and what it is holding.
 *
 * The role split is the useful part — an MCP server holding a gigabyte is a
 * configuration problem you fix once, and a tool call holding a gigabyte is
 * just today's type-check. See `classify` in src/core/proc.ts for how a role is
 * decided.
 */

/**
 * CPU as a percentage of ONE core, always — the htop convention.
 *
 * The tempting alternative is to switch to "3.5×" above 100 and stay in percent
 * below it, which makes 96% and 4× look like two different units when they are
 * the same one: 96% is most of a single core, 400% is four of them. A threshold
 * that changes notation is worse than a big number.
 */
export function cpuText(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return pct > 0 ? "<1%" : "—";
}

const ROLE_LABEL: Record<ProcRole, string> = {
  agent: "the agent",
  mcp: "mcp server",
  tool: "tool call",
  child: "child",
};

/** States worth a word next to the name. Sleeping is every process waiting on
 *  anything, so it says nothing; these do. */
const STATE_LABEL: Record<string, string> = {
  R: "running",
  D: "disk wait",
  Z: "zombie",
  T: "stopped",
  t: "stopped",
};

/** The metrics poll's cadence, which the history arrays are sampled on. */
const SAMPLE_MS = 2_000;
/** Slots in a history strip: the server keeps five minutes (HISTORY in proc.ts). */
const SLOTS = 150;
/** Below these a sample is idle, matching ACTIVE_* in proc.ts. */
const ACTIVE_CPU = 1;
const ACTIVE_READ = 2048;

/** Slower than the metrics poll: each refresh walks smaps for the whole
 *  subtree, which is the most expensive read in the product. */
const REFRESH_MS = 5_000;

export function LoadPanel({ sessionId }: { sessionId: string }) {
  const { metrics } = useMetrics();
  const load = metrics?.load[sessionId];
  const cores = navigator.hardwareConcurrency || 8;
  const [detail, setDetail] = useState<LoadDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr(null);
    const pull = async () => {
      try {
        const r = await api.load(sessionId);
        if (!alive) return;
        setDetail(r);
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void pull();
    const t = setInterval(() => void pull(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);

  if (err) return <Empty title="Could not read the process table">{err}</Empty>;
  if (!detail) return <Empty title="Reading the process table…" />;
  const { procs, history } = detail;
  if (procs.length === 0) {
    return (
      <Empty title="Nothing to measure">
        This session has no live process, so there is no CPU or memory to attribute to it.
      </Empty>
    );
  }

  const totalMem = procs.reduce((s, p) => s + (p.pssBytes ?? p.rssBytes), 0);
  const byRole = (role: ProcRole) =>
    procs.filter((p) => p.role === role).reduce((s, p) => s + (p.pssBytes ?? p.rssBytes), 0);

  return (
    <div className="loadpanel">
      <div className="load-summary">
        <Stat
          label="cpu"
          value={load ? cpuText(load.cpuPct) : "—"}
          // 100% is one core. Spelling out the core count is what stops the
          // headline number from being read as a share of the machine.
          note={load ? `${(load.cpuPct / 100).toFixed(1)} of ${cores} cores` : "of one core"}
        >
          <CpuSpark history={history} />
        </Stat>
        <Stat
          label="memory"
          value={fmtBytes(totalMem)}
          note={load?.memKind === "pss" ? "proportional" : "resident"}
        />
        <Stat
          label="processes"
          value={String(procs.length)}
          note={`${procs.filter((p) => p.role === "mcp").length} mcp`}
        />
        <Stat label="in tool calls" value={fmtBytes(byRole("tool"))} note="right now" />
      </div>

      <table className="proc-table">
        <colgroup>
          <col style={{ width: "auto" }} />
          <col style={{ width: "88px" }} />
          <col style={{ width: "64px" }} />
          <col style={{ width: "70px" }} />
          <col style={{ width: "136px" }} />
          <col style={{ width: "56px" }} />
          <col style={{ width: "74px" }} />
          <col style={{ width: "76px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>process</th>
            <th>role</th>
            <th className="num" title="How long it has been running">age</th>
            <th className="num" title="CPU time it has used itself since it started. Much less than its age: it has mostly been waiting.">
              cpu time
            </th>
            <th title="The last five minutes, newest on the right. Top: CPU. Bottom: bytes read from sockets, pipes and files.">
              last 5 min
            </th>
            <th className="num">cpu</th>
            <th className="num" title="How long since it last used CPU or read anything">
              quiet
            </th>
            <th className="num">memory</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => {
            const mem = p.pssBytes ?? p.rssBytes;
            const state = STATE_LABEL[p.state];
            return (
              <tr key={p.pid} data-role={p.role} title={`pid ${p.pid} · ${p.cmd}`}>
                <td className="truncate">
                  {/* Indent by tree depth: an MCP server and the shell a tool
                      call runs in are both children, but only one of them is
                      something you would go and fix. */}
                  <span style={{ paddingLeft: p.depth * 14 }}>
                    {p.depth > 0 ? <span className="faint">└ </span> : null}
                    {p.name}
                  </span>
                  {state ? (
                    <span className="proc-state" data-state={p.state}>
                      {state}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className="role-tag" data-role={p.role}>
                    {ROLE_LABEL[p.role]}
                  </span>
                </td>
                <td className="num faint">{p.ageMs > 0 ? fmtDur(p.ageMs) : "—"}</td>
                <td className="num">{fmtDur(p.cpuMs)}</td>
                <td>
                  <Activity p={p} />
                </td>
                <td className="num">
                  <span data-hot={p.cpuPct >= 80}>{cpuText(p.cpuPct)}</span>
                </td>
                <td className="num">
                  <Quiet p={p} />
                </td>
                <td className="num">
                  <span
                    className="membar"
                    style={{ ["--f" as string]: `${totalMem ? Math.min(100, (mem / totalMem) * 100) : 0}%` }}
                  >
                    {fmtBytes(mem)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="hint">
        Memory is proportional set size — shared pages are split between the processes holding them,
        so these add up to the subtree total instead of double counting. CPU is measured per process
        over the last interval; the summary above also counts short-lived commands that started and
        finished inside it, so it can legitimately exceed the sum of the rows. A process that has
        been quiet for minutes, with little CPU time for its age, is waiting on something: the network,
        a lock, or input that is not coming.
      </p>
    </div>
  );
}

function Stat({ label, value, note, children }: { label: string; value: string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="load-stat">
      <span className="label">{label}</span>
      <b>{value}</b>
      {note ? <span className="faint">{note}</span> : null}
      {children}
    </div>
  );
}

/** How long a run of samples covers, for a tooltip. */
function span(n: number): string {
  return fmtDur(n * SAMPLE_MS);
}

function rate(bps: number): string {
  return bps < 1 ? "0 B/s" : `${fmtBytes(Math.round(bps))}/s`;
}

/** The whole subtree's CPU over the last five minutes, under the headline. */
function CpuSpark({ history }: { history: number[] }) {
  if (history.length < 2) return null;
  const h = history.slice(-SLOTS);
  const top = Math.max(100, ...h);
  const x = (i: number) => ((SLOTS - h.length + i) / (SLOTS - 1)) * 100;
  const y = (v: number) => 22 - (v / top) * 20;
  const line = h.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg
      className="cpu-spark"
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={`CPU over the last ${span(h.length)}: peak ${cpuText(Math.max(...h))}`}
    >
      <title>{`CPU over the last ${span(h.length)} · peak ${cpuText(Math.max(...h))} · scale to ${cpuText(top)}`}</title>
      <polygon points={`${x(0).toFixed(2)},22 ${line} 100,22`} />
      <polyline points={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A process's last five minutes as two strips, newest on the right: CPU on
 * top, reads below. A cell is shaded only when that sample was active, so a
 * stuck process shows as a run of empty track, and a busy one as solid ink.
 * The track only spans what has been watched: blank to its left is time
 * before anyone looked.
 */
function Activity({ p }: { p: ProcDetail }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.min(SLOTS, p.cpuHistory.length);
  if (n === 0) return <span className="faint">—</span>;
  const cpu = p.cpuHistory.slice(-n);
  const read = p.readHistory.slice(-n);
  const off = SLOTS - n;
  // Intensity rather than height: at a 1px column, whether it did anything is
  // the reading, and how much is a detail the tooltip gives exactly.
  const cpuInk = (v: number) => (v < ACTIVE_CPU ? 0 : 0.3 + 0.7 * Math.min(1, v / 100));
  const readInk = (v: number) =>
    v < ACTIVE_READ ? 0 : 0.3 + 0.7 * Math.min(1, Math.log10(v / ACTIVE_READ) / Math.log10(512));
  const at = hover === null ? null : hover - off;
  const tip =
    at !== null && at >= 0 && at < n
      ? `${at === n - 1 ? "now" : `${fmtDur((n - 1 - at) * SAMPLE_MS)} ago`} · cpu ${cpuText(cpu[at]!)} · read ${rate(read[at]!)}`
      : `watched ${span(n)} · cpu peak ${cpuText(Math.max(...cpu))} · read peak ${rate(Math.max(...read))}`;
  return (
    <svg
      className="activity"
      viewBox={`0 0 ${SLOTS} 13`}
      preserveAspectRatio="none"
      role="img"
      aria-label={tip}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHover(Math.floor(((e.clientX - r.left) / r.width) * SLOTS));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <title>{tip}</title>
      <rect className="track" x={off} y={0} width={n} height={6} />
      <rect className="track" x={off} y={7} width={n} height={6} />
      {cpu.map((v, i) =>
        cpuInk(v) ? <rect key={`c${i}`} className="cpu" x={off + i} y={0} width={1} height={6} opacity={cpuInk(v)} /> : null,
      )}
      {read.map((v, i) =>
        readInk(v) ? <rect key={`r${i}`} className="read" x={off + i} y={7} width={1} height={6} opacity={readInk(v)} /> : null,
      )}
      {at !== null && at >= 0 && at < n ? <rect className="cursor" x={hover!} y={0} width={1} height={13} /> : null}
    </svg>
  );
}

/** How long since it last did anything. "now" within a sample or two. A tool
 *  call quiet past a minute gets the warning ink: tools are meant to finish,
 *  where an agent between turns and an idle MCP server are quiet by design. */
function Quiet({ p }: { p: ProcDetail }) {
  const stale = (ms: number) => (p.role === "tool" && ms >= 60_000) || undefined;
  if (p.quietMs === null) {
    // Nothing yet in the time it has been watched: that long, at least.
    if (p.watchedMs < 2 * SAMPLE_MS) return <span className="faint">—</span>;
    return (
      <span data-stale={stale(p.watchedMs)} title={`no CPU or reads in the ${fmtDur(p.watchedMs)} it has been watched`}>
        ≥{fmtDur(p.watchedMs)}
      </span>
    );
  }
  if (p.quietMs < 2 * SAMPLE_MS) return <span className="faint">now</span>;
  return <span data-stale={stale(p.quietMs)}>{fmtDur(p.quietMs)}</span>;
}
