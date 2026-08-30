import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SubagentDetail, type SubagentRow } from "../api";
import { Button, Empty } from "../components";
import { useIsNarrow } from "./session/useIsNarrow";
import "./agents.css";

/**
 * Every omp subagent on this machine, and what it is doing.
 *
 * These are not board sessions and never will be — no worktree, no branch, no
 * human in the loop, no row in the database. They are function calls that
 * happen to be language models, and the last thing the board needs is eighty
 * of them filed next to real work.
 *
 * What they did need is somewhere to be seen. A subagent's owner is an MCP
 * server on some client's stdio: it has no address, it exits when the client
 * does, and until now the only window onto one was a single truncated line in
 * a shell status bar. Everything here is read back off the record each agent
 * already writes to disk, which is why it can show agents belonging to other
 * windows, and finished ones, and ones whose owner was killed an hour ago.
 *
 * The two questions it is built to answer, in this order: is anything wrong,
 * and how much of its budget is gone. Neither is a progress bar, because there
 * is no honest one to draw.
 */
export function Agents({
  agentId,
  onSelect,
}: {
  agentId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [rows, setRows] = useState<SubagentRow[] | null>(null);
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [openCall, setOpenCall] = useState<number | null>(null);
  const narrow = useIsNarrow();

  // Polling, not a socket. Subagents are outside the session machinery that
  // the socket carries, and the record is rewritten on a two-second beat
  // anyway — a push channel would deliver the same staleness with more moving
  // parts.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api.subagents();
        if (alive) {
          setRows(next);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (agentId === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const next = await api.subagent(agentId);
        if (alive) setDetail(next);
      } catch {
        // A record pruned while it was open is not an error worth a banner;
        // the list will drop it on its next tick.
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId]);

  const act = useCallback(async (id: string, command: "interrupt" | "stop") => {
    try {
      await api.commandSubagent(id, command);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const { live, finished } = useMemo(() => {
    const all = rows ?? [];
    return {
      live: all.filter((r) => r.state === "running" || r.state === "abandoned" || r.uncollected > 0),
      finished: all.filter(
        (r) => !(r.state === "running" || r.state === "abandoned" || r.uncollected > 0),
      ),
    };
  }, [rows]);

  const shown = showFinished ? [...live, ...finished] : live;
  const showList = !narrow || agentId === null;
  const showDetail = !narrow || agentId !== null;

  return (
    <div className="ag-wrap" data-panes={narrow ? "one" : "two"}>
      {showList && (
        <div className="ag-list">
          <div className="ag-toolbar">
            <span className="ag-count">
              {live.length} running{finished.length > 0 ? ` · ${finished.length} finished` : ""}
            </span>
            {finished.length > 0 && (
              <Button variant="ghost" onClick={() => setShowFinished((v) => !v)}>
                {showFinished ? "Hide finished" : "Show finished"}
              </Button>
            )}
          </div>
          {error && <div className="ag-error">{error}</div>}
          {rows !== null && shown.length === 0 && (
            <Empty title="No subagents">
              Agents started through the omp MCP server appear here while they run, and stay
              afterwards so you can see what they did.
            </Empty>
          )}
          {shown.map((r) => (
            <button
              key={r.id}
              className="ag-row"
              data-selected={r.id === agentId}
              data-concern={r.concern ?? r.state}
              onClick={() => onSelect(r.id)}
            >
              <div className="ag-row-head">
                <span className="ag-name">{r.name}</span>
                <Health row={r} />
              </div>
              <div className="ag-where">
                {r.cwd.split("/").pop()}
                {r.branch ? ` @ ${r.branch}` : ""}
                {r.readOnly ? " · read-only" : ""}
              </div>
              <div className="ag-budget">{budgetLine(r)}</div>
              {r.state === "running" && r.lastAction && (
                <div className="ag-now">{r.lastAction}</div>
              )}
              {r.concern && <div className="ag-concern">{r.findings[0]?.note}</div>}
            </button>
          ))}
        </div>
      )}

      {showDetail && (
        <div className="ag-detail">
          {detail === null ? (
            <Empty title="Nothing selected">Pick an agent to see what it has done.</Empty>
          ) : (
            <>
              <div className="ag-detail-head">
                <div>
                  <h2>{detail.name}</h2>
                  <div className="ag-where">
                    {detail.cwd}
                    {detail.branch ? ` @ ${detail.branch}` : ""} · {detail.model}
                  </div>
                </div>
                <div className="ag-actions">
                  <Health row={detail} />
                  {detail.state === "running" && (
                    <>
                      <Button variant="ghost" onClick={() => act(detail.id, "interrupt")}>
                        Interrupt
                      </Button>
                      <Button variant="danger" onClick={() => act(detail.id, "stop")}>
                        Stop
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="ag-budget ag-budget-big">{budgetLine(detail)}</div>

              {detail.findings.length > 0 && (
                <div className="ag-findings">
                  {detail.findings.map((f) => (
                    <div key={f.concern} className="ag-finding" data-concern={f.concern}>
                      <strong>{f.concern}</strong> {f.note}
                    </div>
                  ))}
                </div>
              )}

              {/* A control that reports success it cannot verify would be the
                  worst kind of lie in exactly the moment people press it. */}
              {detail.state === "abandoned" && (
                <div className="ag-note">
                  Its owner (pid {detail.pid}) stopped publishing, so the process is gone. What
                  follows is the last thing it recorded.
                </div>
              )}

              <Section title="Brief">
                <pre className="ag-pre">{detail.prompt}</pre>
              </Section>

              {detail.partial && (
                <Section title="Saying now">
                  <pre className="ag-pre">{detail.partial}</pre>
                </Section>
              )}

              {detail.turns.map((t) => (
                <Section key={t.turn} title={`Answer to turn ${t.turn} (${t.stopReason})`}>
                  <pre className="ag-pre">{t.report}</pre>
                  {t.errors.length > 0 && (
                    <ul className="ag-errors">
                      {t.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </Section>
              ))}

              <Section title={`${detail.calls.length} tool calls`}>
                <div className="ag-calls">
                  {detail.calls.map((c, i) => (
                    <div key={i} className="ag-call">
                      <button className="ag-call-head" onClick={() => setOpenCall(openCall === i ? null : i)}>
                        <span className="ag-call-kind">{c.kind}</span>
                        <span className="ag-call-title">{c.title}</span>
                        <span className="ag-call-ms">
                          {c.ms === null ? "running" : `${Math.round(c.ms)}ms`}
                        </span>
                      </button>
                      {openCall === i && (
                        <div className="ag-call-body">
                          {c.input && <pre className="ag-pre">{c.input}</pre>}
                          {c.output && <pre className="ag-pre ag-out">{c.output}</pre>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>

              {detail.errors.length > 0 && (
                <Section title="Errors">
                  <ul className="ag-errors">
                    {detail.errors.map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Health({ row }: { row: SubagentRow }) {
  return (
    <span className="ag-health" data-concern={row.concern ?? row.state}>
      {row.health}
      {row.uncollected > 0 ? ` · ${row.uncollected} uncollected` : ""}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ag-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function thousands(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 6) / 10}h`;
}

/**
 * Consumption against ceilings. Not a progress bar and never rendered as one:
 * there is no honest denominator for how much of a task is left, and a made-up
 * percentage is worse than none. Context, clock and money are real.
 */
function budgetLine(row: SubagentRow): string {
  const b = row.budget;
  if (b === null) return "no state recorded";
  const parts: string[] = [];
  if (b.contextUsed !== null) {
    const pct = b.contextFraction === null ? "" : ` (${Math.round(b.contextFraction * 100)}%)`;
    const of = b.contextSize === null ? "" : `/${thousands(b.contextSize)}`;
    parts.push(`ctx ${thousands(b.contextUsed)}${of}${pct}`);
  }
  if (row.state === "running") parts.push(`${duration(b.turnMs)} of ${duration(b.maxTurnMs)}`);
  if (b.costUsd !== null) parts.push(`$${b.costUsd.toFixed(2)}`);
  parts.push(`${row.totalToolCalls} tool calls`);
  if (b.toolsPerMinute !== null && row.state === "running") {
    parts.push(`${b.toolsPerMinute.toFixed(1)}/min`);
  }
  return parts.join(" · ");
}
