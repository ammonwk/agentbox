import { useCallback, useEffect, useState } from "react";
import type { AgentSettings, BalancerSettings, CalibrationReport, Percentiles } from "../../../src/core/types";
import { api } from "../api";
import { Button, Empty, Icon, Spinner } from "../components";
import { fmtPts } from "../lib/format";
import { useAction } from "./session/useAction";
import { BALANCER_HELP } from "../lib/balancer";

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
  const sw = report.shortWindowInWeekly;

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
          label="5-hour window in weekly"
          value={sw.estimate != null ? fmtPts(sw.estimate) : "—"}
          unit="pts"
          note={`${sw.samples.toLocaleString()} intervals · r² ${sw.r2 != null ? sw.r2.toFixed(2) : "—"} · in use: ${fmtPts(current.shortWindowInWeekly)}`}
          help="Weekly increase regressed on 5-hour increase, over intervals where neither window reset. r² near 1 means the two move together."
        />
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
            <PctRow label="Normal" p={report.sessionUse.normal} samples={report.sessionUse.normal.samples} claim={current.claimNormal} />
            <PctRow label="Big" p={report.sessionUse.big} samples={report.sessionUse.big.samples} claim={current.claimBig} />
          </tbody>
        </table>
      </section>

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
