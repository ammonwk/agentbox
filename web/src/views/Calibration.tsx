import { useCallback, useEffect, useState } from "react";
import type { AgentSettings, BalancerSettings, CalibrationReport, ForecastReport, Percentiles, ProviderId, RatesReport } from "../../../src/core/types";
import { PROVIDER_LABEL } from "../bits";
import { api } from "../api";
import { Button, Empty, Icon, Spinner } from "../components";
import { fmtPts } from "../lib/format";
import { useAction } from "./session/useAction";
import { BALANCER_HELP } from "../lib/balancer";
import { niceTicks, useWidth } from "./Insights";

const KEYS = Object.keys(BALANCER_HELP) as (keyof BalancerSettings)[];

/**
 * Checks the balancer's assumptions against what actually happened, and
 * offers better numbers. Reads the metrics tables; changes nothing until you
 * press Apply.
 */
export function Calibration({ settings }: { settings: AgentSettings }) {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const apply = useAction();
  const [applied, setApplied] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .calibration(days)
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Empty title="Could not build the calibration report" action={<Button onClick={load}>Try again</Button>}>
        <p className="mono">{error}</p>
      </Empty>
    );
  }
  if (!report) return <Empty title="Reading usage samples…" />;

  // The live settings, not the report's snapshot: someone may have changed them since.
  const current = settings.balancer;
  const suggested = report.suggested;
  const changes = KEYS.filter((k) => suggested[k] != null && Math.abs((suggested[k] as number) - current[k]) > 1e-9);
  const hitRate = report.placements > 0 ? report.hitAfterPlacement / report.placements : null;

  return (
    <div className="cal">
      <div className="cal-bar">
        <p className="hint">
          Built from the last {report.days} days of usage readings and placements. Nothing changes until you apply it.
        </p>
        <div className="seg" role="group" aria-label="Window">
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
        {loading ? <Spinner size={13} /> : null}
      </div>

      <div className="cal-stats">
        <Stat
          label="Placements"
          value={report.placements.toLocaleString()}
          note={`${report.hitAfterPlacement} followed by a rate-limit hit${hitRate != null ? ` (${(hitRate * 100).toFixed(1)}%)` : ""}`}
          help="How often the account a session was placed on then hit a limit. Lower is better; a rising rate means claims are too small."
          tone={hitRate != null && hitRate > 0.1 ? "bad" : hitRate != null && hitRate > 0.04 ? "warn" : undefined}
        />
      </div>

      <section className="card cal-card">
        <h3>What sessions actually used</h3>
        <p className="hint">
          Weekly points each finished session consumed. The claim should sit near the 75th percentile: high enough that most sessions fit
          inside it, not so high that one session blocks an account.
        </p>
        <table className="cal-table">
          <thead>
            <tr>
              <th />
              <th className="num">median</th>
              <th className="num">p75</th>
              <th className="num">p90</th>
              <th className="num">sessions</th>
              <th className="num">claim now</th>
            </tr>
          </thead>
          <tbody>
            <PctRow label="Sessions" p={report.sessionUse} samples={report.sessionUse.samples} claim={current.claimNormal} />
          </tbody>
        </table>
      </section>

      <RatesCard rates={report.rates} />

      <ForecastCard forecast={report.forecast} />

      <section className="card cal-card">
        <h3>Balancer settings</h3>
        <table className="cal-table cal-settings">
          <thead>
            <tr>
              <th>Setting</th>
              <th className="num">current</th>
              <th className="num">suggested</th>
              <th>meaning</th>
            </tr>
          </thead>
          <tbody>
            {KEYS.map((k) => {
              const s = suggested[k];
              const changed = changes.includes(k);
              return (
                <tr key={k} data-changed={changed || undefined}>
                  <td className="cal-key">{BALANCER_HELP[k].label}</td>
                  <td className="num">
                    {fmtPts(current[k])} <span className="faint">{BALANCER_HELP[k].unit}</span>
                  </td>
                  <td className="num">
                    {s == null ? <span className="faint">—</span> : changed ? <strong>{fmtPts(s)}</strong> : fmtPts(s)}
                  </td>
                  <td className="hint">{BALANCER_HELP[k].help}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="cal-apply">
          {applied && changes.length === 0 ? (
            <span className="save-ok">
              <Icon.check size={14} /> Applied — the balancer uses these from the next placement.
            </span>
          ) : changes.length === 0 ? (
            <span className="hint">The current settings already match what the data suggests.</span>
          ) : (
            <span className="hint">
              {changes.length} setting{changes.length === 1 ? "" : "s"} would change. Running sessions keep their claims.
            </span>
          )}
          <Button
            variant="primary"
            icon={Icon.check}
            disabled={changes.length === 0}
            loading={apply.busy}
            onClick={() =>
              void apply.run(async () => {
                const next: BalancerSettings = { ...current };
                for (const k of changes) next[k] = suggested[k] as number;
                await api.applyBalancer(next);
                setApplied(true);
              })
            }
          >
            Apply suggested
          </Button>
        </div>
        {apply.error ? <p className="error-line">{apply.error}</p> : null}
      </section>
    </div>
  );
}

const dollars = (n: number): string => `$${Math.round(n).toLocaleString()}`;
const DAY_FMT = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

/**
 * What a percent of each plan is worth: how many weekly points a full window
 * of each kind is, what a week buys at API prices, its history, and how much
 * of each account's week agentbox did not see.
 */
function RatesCard({ rates }: { rates: RatesReport }) {
  const plans = rates.plans.filter((p) => p.windows.length > 1 || p.price != null);
  return (
    <section className="card cal-card">
      <h3>What a percent is worth</h3>
      <p className="hint">
        Measured per plan, from how its windows rose together and what agentbox's sessions spent meanwhile. A window's worth in weekly
        points cannot be thrown off by use agentbox does not see (the browser, another machine): every window counts it. What a week
        buys can, so it comes from the stretches of work whose points did not come much dearer than usual, and the rest of a rise is
        counted as used outside agentbox. A change in either puts a note in Review.
      </p>
      {plans.length === 0 ? <p className="hint">Not enough usage readings yet.</p> : plans.map((p) => <PlanRates key={p.plan} plan={p} />)}
    </section>
  );
}

function PlanRates({ plan: p }: { plan: RatesReport["plans"][number] }) {
  const others = p.windows.filter((w) => w.id !== p.weeklyId);
  const seen = p.accounts.filter((a) => a.split && a.split.units > 0);
  return (
    <div className="cal-plan">
      <h4>
        {p.plan}
        {p.price != null ? (
          <span>
            a week ≈ <b>{dollars(100 / p.price)}</b> at API prices
          </span>
        ) : (
          <span className="faint">too little spent to price a week yet</span>
        )}
      </h4>
      <ul className="cal-ratios">
        {others.map((w) => (
          <li key={w.id} title={w.perWeekly != null ? `${w.samples} windows · r² ${w.r2?.toFixed(2) ?? "—"}` : "Not measured yet: taken by its length until it is"}>
            A full {w.label.toLowerCase()} window is{" "}
            {w.perWeekly != null ? (
              <b>{fmtPts(100 / w.perWeekly)} weekly points</b>
            ) : (
              <>
                taken for {fmtPts(100 / w.cold!)} weekly points <span className="faint">(not measured yet)</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <ValueChart plan={p} />
      {seen.length ? (
        <table className="cal-table">
          <thead>
            <tr>
              <th>Last 7 days</th>
              <th className="num">agentbox spent</th>
              <th className="num">outside agentbox</th>
            </tr>
          </thead>
          <tbody>
            {seen.map((a) => (
              <tr key={a.id}>
                <td className="cal-key">{a.label}</td>
                <td className="num">{fmtPts(a.split!.ours)} pts</td>
                <td className="num" title="How far its weekly rose beyond what agentbox's sessions spent, at the plan's price">
                  {a.split!.outside > 0 ? `${fmtPts(a.split!.outside)} pts` : <span className="faint">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

const PAD = { left: 52, right: 8, top: 8, bottom: 20 };

/** What a week bought, day by day, each fitted over the week up to it. */
function ValueChart({ plan: p }: { plan: RatesReport["plans"][number] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const first = p.history.findIndex((h) => h.price != null);
  if (first < 0) return null;
  const days = p.history.slice(first);
  const values = days.map((h) => (h.price != null ? 100 / h.price : null));
  const H = 120;
  const ticks = niceTicks(Math.max(...values.map((v) => v ?? 0)));
  const yMax = ticks[ticks.length - 1]!;
  const step = days.length > 1 ? (width - PAD.left - PAD.right) / (days.length - 1) : 0;
  const xOf = (i: number) => PAD.left + i * step;
  const yOf = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / yMax);
  let d = "";
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${i > 0 && values[i - 1] != null ? "L" : "M"}${xOf(i)},${yOf(v)}`;
  });
  const pick = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = step > 0 ? Math.round((e.clientX - r.left - PAD.left) / step) : 0;
    setHover(i >= 0 && i < days.length ? i : null);
  };
  const h = hover !== null ? days[hover]! : null;
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(width / 70))));
  return (
    <div className="cal-value" ref={ref}>
      <div className="ins-sub-label">What a week bought at API prices, each day over the week before it</div>
      {width > 0 ? (
        <svg
          width={width}
          height={H}
          className="ins-svg"
          role="img"
          aria-label={`What a week of ${p.plan} bought, from ${dollars(Math.min(...values.filter((v): v is number => v != null)))} to ${dollars(Math.max(...values.filter((v): v is number => v != null)))}`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="ins-grid" x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} />
              <text className="ins-axis" x={PAD.left - 6} y={yOf(v)} dy="0.32em" textAnchor="end">
                {dollars(v)}
              </text>
            </g>
          ))}
          {days.map((day, i) =>
            i % labelEvery === 0 ? (
              <text key={day.at} className="ins-axis" x={xOf(i)} y={H - 6} textAnchor="middle">
                {DAY_FMT.format(day.at)}
              </text>
            ) : null,
          )}
          {hover !== null ? <line className="cal-value-cross" x1={xOf(hover)} x2={xOf(hover)} y1={PAD.top} y2={H - PAD.bottom} /> : null}
          <path className="cal-value-line" d={d} />
          {hover !== null && values[hover] != null ? <circle className="cal-value-dot" cx={xOf(hover)} cy={yOf(values[hover]!)} r={4} /> : null}
        </svg>
      ) : null}
      {h ? (
        <p className="cal-value-tip">
          {DAY_FMT.format(h.at)}: {h.price != null ? <b>{dollars(100 / h.price)}</b> : "not enough work that week"}
          {p.windows
            .filter((w) => w.id !== p.weeklyId && h.perWeekly[w.id])
            .map((w) => ` · a ${w.label.toLowerCase()} window ${fmtPts(100 / h.perWeekly[w.id]!)} weekly points`)
            .join("")}
        </p>
      ) : null}
    </div>
  );
}

/** The buckets `edges` make, named in weekly points at `perCost`: "under 0.1",
 *  "0.1–0.5", "2.2 or more". With `zero`, the first edge only separates
 *  nothing from something, and the first bucket is named that. */
function bucketNames(edges: number[], perCost: number, zero: string | null): string[] {
  // One figure below a tenth of a point, where rounding to tenths would say 0.
  const at = (i: number) => {
    const v = edges[i]! * perCost;
    return v < 0.095 ? String(Number(v.toPrecision(1))) : fmtPts(v);
  };
  return [...edges, null].map((_, i) => {
    if (i === 0) return zero ?? `under ${at(0)}`;
    if (i === edges.length) return `${at(i - 1)} or more`;
    return zero && i === 1 ? `under ${at(1)}` : `${at(i - 1)}–${at(i)}`;
  });
}

/**
 * What a running session is expected to still use, by the two things it has
 * shown: one table per provider, weekly points throughout.
 */
function ForecastCard({ forecast }: { forecast: ForecastReport }) {
  const shown = forecast.providers.filter((p) => p.pointsPerCost != null);
  return (
    <section className="card cal-card">
      <h3>What a running session is expected to still use</h3>
      <p className="hint">
        Weekly points a session goes on to use before it next falls quiet for an hour, averaged over every past stretch of work that
        stood where it stands: by what it spent in the last ten minutes (rows) and so far this stretch (columns). This is what a
        session holds against its account once it has spent anything; its model's claim only stands in until then.
        {forecast.fittedAt ? <> Refitted daily, last {new Date(forecast.fittedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.</> : null}
      </p>
      {shown.length === 0 ? (
        <p className="hint">Not enough history yet: sessions hold what is left of their claims until there is.</p>
      ) : (
        shown.map((p) => {
          const rows = bucketNames(forecast.recentEdges, p.pointsPerCost!, "nothing");
          const cols = bucketNames(forecast.soFarEdges, p.pointsPerCost!, null);
          return (
            <div className="cal-scroll" key={p.provider}>
              <table className="cal-table cal-forecast">
                <thead>
                  <tr>
                    <th>{PROVIDER_LABEL[p.provider as ProviderId] ?? p.provider} · last 10 min ↓ so far →</th>
                    {cols.map((c) => (
                      <th className="num" key={c}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, ri) => (
                    <tr key={r}>
                      <td className="cal-key">{r}</td>
                      {cols.map((c, ci) => {
                        const cell = p.cells.find((x) => x.recent === ri && x.soFar === ci);
                        return (
                          <td className="num" key={c} title={cell ? `${cell.stretches.toLocaleString()} stretches of work passed through here` : "Never seen"}>
                            {cell?.points != null ? fmtPts(cell.points) : <span className="faint">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  unit,
  note,
  help,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  note: string;
  help: string;
  tone?: "warn" | "bad";
}) {
  return (
    <div className="cal-stat card" data-tone={tone}>
      <span className="cal-stat-label">{label}</span>
      <b>
        {value}
        {unit ? <span className="faint"> {unit}</span> : null}
      </b>
      <span className="cal-stat-note">{note}</span>
      <span className="hint">{help}</span>
    </div>
  );
}

function PctRow({ label, p, samples, claim }: { label: string; p: Percentiles; samples: number; claim: number }) {
  const few = samples < 10;
  return (
    <tr>
      <td className="cal-key">{label}</td>
      <td className="num">{fmtPts(p.p50)}</td>
      <td className="num">
        <strong>{fmtPts(p.p75)}</strong>
      </td>
      <td className="num">{fmtPts(p.p90)}</td>
      <td className="num" title={few ? "Fewer than 10 sessions: read these as a hint, not a measurement" : undefined}>
        {samples}
        {few ? <span className="cal-few"> few</span> : null}
      </td>
      <td className="num">{fmtPts(claim)}</td>
    </tr>
  );
}
