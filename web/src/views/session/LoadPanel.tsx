import { useEffect, useState } from "react";
import { api, fmtBytes, useMetrics, type ProcDetail, type ProcRole } from "../../api";
import { Empty } from "../../components";
import { cpuText } from "./load";

/**
 * Where a session's CPU and memory actually went.
 *
 * The board can only say "4.4 GB", which is the number that makes you ask the
 * question, not the one that answers it. This is the answer: every process in
 * the subtree, what it is, and what it is holding.
 *
 * The role split is the useful part — an MCP server holding a gigabyte is a
 * configuration problem you fix once, and a tool call holding a gigabyte is
 * just today's type-check. See `classify` in src/core/proc.ts for how a role is
 * decided, and for why that decision is currently provisional for omp.
 */

const ROLE_LABEL: Record<ProcRole, string> = {
  agent: "the agent",
  mcp: "mcp server",
  tool: "tool call",
  child: "child",
};

/** Slower than the metrics poll: each refresh walks smaps for the whole
 *  subtree, which is the most expensive read in the product. */
const REFRESH_MS = 5_000;

export function LoadPanel({ sessionId }: { sessionId: string }) {
  const { metrics } = useMetrics();
  const load = metrics?.load[sessionId];
  const cores = navigator.hardwareConcurrency || 8;
  const [procs, setProcs] = useState<ProcDetail[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setProcs(null);
    setErr(null);
    const pull = async () => {
      try {
        const r = await api.load(sessionId);
        if (!alive) return;
        setProcs(r.procs);
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
  if (!procs) return <Empty title="Reading the process table…" />;
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
        />
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
          <col style={{ width: "92px" }} />
          <col style={{ width: "66px" }} />
          <col style={{ width: "78px" }} />
          <col style={{ width: "68px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>process</th>
            <th>role</th>
            <th className="num">cpu</th>
            <th className="num">memory</th>
            <th className="num">pid</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => {
            const mem = p.pssBytes ?? p.rssBytes;
            return (
              <tr key={p.pid} data-role={p.role} title={p.cmd}>
                <td className="truncate">
                  {/* Indent by tree depth: an MCP server and the shell a tool
                      call runs in are both children, but only one of them is
                      something you would go and fix. */}
                  <span style={{ paddingLeft: p.depth * 14 }}>
                    {p.depth > 0 ? <span className="faint">└ </span> : null}
                    {p.name}
                  </span>
                </td>
                <td>
                  <span className="role-tag" data-role={p.role}>
                    {ROLE_LABEL[p.role]}
                  </span>
                </td>
                <td className="num">
                  <span data-hot={p.cpuPct >= 80}>{cpuText(p.cpuPct)}</span>
                </td>
                <td className="num">
                  <span
                    className="membar"
                    style={{ ["--f" as string]: `${totalMem ? Math.min(100, (mem / totalMem) * 100) : 0}%` }}
                  >
                    {fmtBytes(mem)}
                  </span>
                </td>
                <td className="num faint">{p.pid}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="hint">
        Memory is proportional set size — shared pages are split between the processes holding them,
        so these add up to the subtree total instead of double counting. CPU is measured per process
        over the last interval; the summary above also counts short-lived commands that started and
        finished inside it, so it can legitimately exceed the sum of the rows.
      </p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="load-stat">
      <span className="label">{label}</span>
      <b>{value}</b>
      {note ? <span className="faint">{note}</span> : null}
    </div>
  );
}
