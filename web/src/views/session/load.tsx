import { fmtBytes, useMetrics, type LoadSample } from "../../api";

/**
 * How much of the machine one session is holding.
 *
 * Two numbers, deliberately weighted differently. CPU is the volatile one and
 * gets the sparkline, because a single instantaneous reading of it is close to
 * meaningless — a session flickers between 0% and 400% as tool calls start and
 * finish, and what you actually want to know is whether it has been busy.
 * Memory is the steady one and gets a plain figure.
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

/**
 * Discrete bars, not a smoothed line: each is one sample from the 2s poll, and
 * a curve between them would imply we measured the gap.
 */
function Sparkline({ history }: { history: number[] }) {
  if (history.length < 2) return <span className="spark-empty" aria-hidden="true" />;
  // Scale to one core or the tallest sample, whichever is larger, so a quiet
  // session is a flat line near the floor rather than noise amplified to
  // full height.
  const peak = Math.max(100, ...history);
  return (
    <span className="spark" aria-hidden="true">
      {history.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(3, (v / peak) * 100)}%` }} data-hot={v >= 100} />
      ))}
    </span>
  );
}

/**
 * The load figure for one session row.
 *
 * Subscribes to metrics itself rather than taking them as a prop. The frames
 * arrive every two seconds and every one differs, so threading them through the
 * list would re-render every row and its title, badge and timestamp to move one
 * number. Subscribing at the leaf keeps the churn where the churn belongs.
 *
 * Renders nothing at all when there is no sample — a session with no live
 * process has no reading, and zero would be a claim we cannot support.
 */
export function LoadCell({ sessionId }: { sessionId: string }) {
  const { metrics } = useMetrics();
  const load = metrics?.load[sessionId];
  if (!load) return null;
  return <LoadFigures load={load} />;
}

export function LoadFigures({ load }: { load: LoadSample }) {
  return (
    <span
      className="load-cell"
      title={
        `${cpuText(load.cpuPct)} of one core across ${load.procs} process${load.procs === 1 ? "" : "es"}\n` +
        `${fmtBytes(load.memBytes)} ${
          load.memKind === "pss"
            ? "proportional set size — shared pages split between the processes holding them"
            : "resident — a first-poll fallback that overstates shared pages"
        }` +
        (load.backgroundShells
          ? `\n${load.backgroundShells} shell${load.backgroundShells === 1 ? "" : "s"} still running with the turn over`
          : "")
      }
    >
      <Sparkline history={load.history} />
      <span className="load-nums">
        <b data-hot={load.cpuPct >= 100}>{cpuText(load.cpuPct)}</b>
        <b>{fmtBytes(load.memBytes)}</b>
      </span>
      {/* Worth its own mark: a parked session with live shells is the one that
          looks busy from the outside for a reason nobody remembers. */}
      {load.backgroundShells ? <span className="load-bg">{load.backgroundShells}bg</span> : null}
    </span>
  );
}
