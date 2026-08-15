import { useState, type ReactNode } from "react";
import { useMetrics, type SystemState } from "./api";

/**
 * The machine, along the bottom of every view.
 *
 * The per-session load column answers "which agent is eating the laptop". This
 * answers the question underneath it — "is the laptop coping" — and those are
 * genuinely different questions. A machine can sit at 40% CPU and still feel
 * dead because it is thermally throttled, swapping, or blocked on disk.
 *
 * The ordering is the argument: cores first, because that is the thing you were
 * about to open System Monitor to see; then memory; then the three numbers that
 * explain a slow machine when CPU and memory both look fine — contention, heat,
 * and throttling. Standing conditions (disk, battery) sit last, after a spacer,
 * because they are context rather than news.
 *
 * Every cell is conditional on its own field. On a kernel without PSI, a
 * desktop with no battery, or a chip whose sensors we cannot name, the cell is
 * absent rather than showing a zero we cannot support.
 */

function gb(n: number): string {
  const g = n / 1024 ** 3;
  return g >= 100 ? `${Math.round(g)}G` : `${g.toFixed(1)}G`;
}

export function SystemBar() {
  const { metrics, stale } = useMetrics();
  const [open, setOpen] = useState(false);
  const sys = metrics?.system;

  // Nothing to say: not Linux, or the first sweep has not landed. An empty
  // strip would be a permanent piece of furniture claiming a measurement.
  if (!sys) return null;

  const memUsed = sys.memTotal - sys.memAvailable;
  const memFrac = sys.memTotal ? memUsed / sys.memTotal : 0;
  const cacheFrac = sys.memTotal ? sys.memCache / sys.memTotal : 0;
  const swapFrac = sys.swapTotal ? sys.swapUsed / sys.swapTotal : 0;

  // Load against cores is the honest form. "49.7" means nothing without the 14
  // beside it; 3.5x oversubscribed means everything.
  const oversub = sys.cores ? sys.load1 / sys.cores : 0;

  const cpuTemp = sys.temps.find((t) => t.name === "cpu");
  // Rank by proximity to each sensor's own critical, not by raw degrees: DIMMs
  // can run at 76°C against an 85°C limit while the CPU sits at 74°C against
  // 110°C, so the hottest number and the closest call are different sensors.
  const worst = [...sys.temps]
    .filter((t) => t.pressure !== undefined)
    .sort((a, b) => (b.pressure ?? 0) - (a.pressure ?? 0))[0];

  const clockFrac = sys.mhz && sys.mhzMax ? sys.mhz / sys.mhzMax : undefined;
  const diskFrac = sys.diskTotal && sys.diskFree ? 1 - sys.diskFree / sys.diskTotal : undefined;

  return (
    // `data-stale` rather than unmounting: the shell already tells you the
    // socket is down, and removing the bar would make a disconnect look like a
    // machine that stopped having a temperature. Dimmed and labelled instead.
    <div className="sysbar" data-open={open} data-stale={stale}>
      <button
        className="sysbar-row"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? "Hide machine detail" : "Show machine detail"}
      >
        {/* ── Cores ── */}
        <span className="sys-cell" title={`${sys.cores} cores, each bar one core`}>
          <span className="corebars" aria-hidden="true">
            {sys.perCore.map((v, i) => (
              <i key={i} style={{ height: `${Math.max(4, v * 100)}%` }} data-hot={v > 0.85} />
            ))}
          </span>
          <span className="sys-figs">
            <b>{Math.round(sys.cpu * 100)}%</b>
            <span className="faint">{sys.cores} cores</span>
          </span>
        </span>

        <Div />

        {/* ── Memory ── */}
        <span
          className="sys-cell"
          title={
            `${gb(memUsed)} in use of ${gb(sys.memTotal)}\n` +
            `${gb(sys.memCache)} page cache — reclaimable, not a shortage\n` +
            (sys.swapTotal ? `swap ${gb(sys.swapUsed)} of ${gb(sys.swapTotal)}` : "no swap")
          }
        >
          <span className="sys-figs">
            <span className="label">memory</span>
            <b>
              {gb(memUsed)}
              <span className="faint"> / {gb(sys.memTotal)}</span>
            </b>
          </span>
          <span className="stackbar" aria-hidden="true">
            {/* Cache is drawn as its own segment because counting it as "used"
                is the classic way to panic about a machine that is fine. */}
            <i className="seg-used" style={{ width: `${memFrac * 100}%` }} />
            <i className="seg-cache" style={{ width: `${cacheFrac * 100}%` }} />
          </span>
        </span>

        {sys.swapTotal > 0 ? (
          <span className="sys-cell narrow" title={`swap ${gb(sys.swapUsed)} of ${gb(sys.swapTotal)}`}>
            <span className="sys-figs">
              <span className="label">swap</span>
              {/* Swap *occupancy* is not a problem — half a gig written out
                  hours ago costs nothing. What hurts is paging under pressure,
                  so this follows the memory stall figure rather than the
                  fraction, which flags a perfectly healthy machine. */}
              <b data-warn={(sys.psiMem ?? 0) > 1 && swapFrac > 0.02}>{gb(sys.swapUsed)}</b>
            </span>
          </span>
        ) : null}

        <Div />

        {/* ── Contention ── */}
        <span
          className="sys-cell narrow"
          title={
            `load ${sys.load1} / ${sys.load5} / ${sys.load15} over 1, 5 and 15 minutes\n` +
            `${sys.cores} cores, so ${oversub.toFixed(1)}x oversubscribed` +
            (sys.runnable ? `\n${sys.runnable} tasks runnable` : "")
          }
        >
          <span className="sys-figs">
            <span className="label">load</span>
            <b data-warn={oversub > 1.5} data-bad={oversub > 3}>
              {sys.load1.toFixed(1)}
              <span className="faint"> {oversub.toFixed(1)}×</span>
            </b>
          </span>
        </span>

        {sys.psiCpu !== undefined ? (
          <span
            className="sys-cell narrow"
            title={
              "Pressure stall: share of the last 10s in which at least one task was stalled.\n" +
              `cpu ${sys.psiCpu.toFixed(0)}%  ·  io ${sys.psiIo?.toFixed(0) ?? "–"}%  ·  memory ${sys.psiMem?.toFixed(0) ?? "–"}%\n` +
              "This is what a slow machine actually feels like — CPU can read 100% with nothing stalled."
            }
          >
            <span className="sys-figs">
              <span className="label">stalled</span>
              <b data-warn={sys.psiCpu > 40} data-bad={sys.psiCpu > 75}>
                {Math.round(sys.psiCpu)}%
              </b>
            </span>
          </span>
        ) : null}

        <Div />

        {/* ── Heat ── */}
        {cpuTemp ? (
          <span
            className="sys-cell narrow"
            title={sys.temps
              .map(
                (t) =>
                  `${t.name} ${t.celsius.toFixed(0)}°C${t.critical ? ` of ${t.critical.toFixed(0)}°C` : ""}`,
              )
              .join("\n")}
          >
            <span className="sys-figs">
              <span className="label">cpu temp</span>
              <b data-warn={(cpuTemp.pressure ?? 0) > 0.8} data-bad={(cpuTemp.pressure ?? 0) > 0.92}>
                {Math.round(cpuTemp.celsius)}°
              </b>
            </span>
          </span>
        ) : null}

        {/* The sensor closest to its own limit, when that is not the CPU — same
            reading, completely different situation, and only one of the two is
            worth a slot. */}
        {worst && worst.name !== "cpu" && (worst.pressure ?? 0) > 0.82 ? (
          <span
            className="sys-cell narrow"
            title={`${worst.name} is at ${worst.celsius.toFixed(0)}°C of its ${worst.critical?.toFixed(0)}°C limit — the closest of any sensor.`}
          >
            <span className="sys-figs">
              <span className="label">{worst.name} temp</span>
              <b data-warn={(worst.pressure ?? 0) > 0.82} data-bad={(worst.pressure ?? 0) > 0.94}>
                {Math.round(worst.celsius)}°
              </b>
            </span>
          </span>
        ) : null}

        {/* Throttling gets a border as well as a colour: it is a condition, not
            a measurement, and an aspect survives a light background. */}
        {sys.throttling || sys.throttleDuty > 0 ? (
          <span
            className="sys-cell narrow throttled"
            title={
              `Thermally throttled ${(sys.throttleDuty * 100).toFixed(0)}% of the last interval.\n` +
              `${sys.throttleCount?.toLocaleString() ?? "?"} throttle events since boot.\n` +
              "The CPU is being clocked down to stay inside its thermal limit."
            }
          >
            <span className="sys-figs">
              <span className="label">throttling</span>
              <b>{Math.round(sys.throttleDuty * 100)}%</b>
            </span>
          </span>
        ) : null}

        {clockFrac !== undefined ? (
          <span
            className="sys-cell narrow"
            title={
              `${(sys.mhz! / 1000).toFixed(2)} GHz average across cores, of ${(sys.mhzMax! / 1000).toFixed(1)} GHz maximum.\n` +
              "A busy CPU running well under its maximum is being held back by heat or a power limit."
            }
          >
            <span className="sys-figs">
              <span className="label">clock</span>
              <b data-warn={clockFrac < 0.5 && sys.cpu > 0.5}>{(sys.mhz! / 1000).toFixed(1)}G</b>
            </span>
          </span>
        ) : null}

        <span className="sys-spacer" />

        {/* ── Standing conditions ── */}
        {diskFrac !== undefined ? (
          <span
            className="sys-cell narrow"
            title={`${gb(sys.diskFree!)} free of ${gb(sys.diskTotal!)} — worktrees and transcripts live here`}
          >
            <span className="sys-figs">
              <span className="label">disk free</span>
              <b data-warn={diskFrac > 0.9} data-bad={diskFrac > 0.96}>
                {gb(sys.diskFree!)}
              </b>
            </span>
          </span>
        ) : null}

        {sys.batteryPct !== undefined ? (
          <span
            className="sys-cell narrow"
            title={`${sys.batteryStatus ?? ""} ${sys.batteryPct}%${sys.watts ? ` · ${sys.watts} W` : ""}`}
          >
            <span className="sys-figs">
              <span className="label">{sys.acOnline ? "on ac" : "battery"}</span>
              <b data-warn={!sys.acOnline && sys.batteryPct < 25}>
                {sys.batteryPct}%{sys.watts ? <span className="faint"> {sys.watts}W</span> : null}
              </b>
            </span>
          </span>
        ) : null}

        {stale ? <span className="sys-stale">not updating</span> : null}
        <span className="sys-chevron" aria-hidden="true">
          {open ? "▾" : "▴"}
        </span>
      </button>

      {open ? <SystemDetail sys={sys} /> : null}
    </div>
  );
}

function Div() {
  return <span className="sys-div" aria-hidden="true" />;
}

/** The expanded sheet: everything the one-line bar had to leave out. */
function SystemDetail({ sys }: { sys: SystemState }) {
  return (
    <div className="sysdetail">
      <Block title="cores">
        <div className="coregrid">
          {sys.perCore.map((v, i) => (
            <div key={i} className="coreslot" title={`core ${i}: ${Math.round(v * 100)}%`}>
              <span className="faint">{i}</span>
              <span className="corebar-h">
                <i style={{ width: `${v * 100}%` }} data-hot={v > 0.85} />
              </span>
              <b>{Math.round(v * 100)}%</b>
            </div>
          ))}
        </div>
      </Block>

      <Block title="memory">
        <Line
          label="in use"
          value={gb(sys.memTotal - sys.memAvailable)}
          frac={(sys.memTotal - sys.memAvailable) / sys.memTotal}
        />
        <Line label="page cache" value={gb(sys.memCache)} frac={sys.memCache / sys.memTotal} />
        <Line label="available" value={gb(sys.memAvailable)} frac={sys.memAvailable / sys.memTotal} />
        {sys.swapTotal ? (
          <Line
            label="swap"
            value={`${gb(sys.swapUsed)} of ${gb(sys.swapTotal)}`}
            frac={sys.swapUsed / sys.swapTotal}
          />
        ) : null}
      </Block>

      {sys.temps.length > 0 ? (
        <Block title="temperatures">
          {sys.temps.map((t) => (
            <Line
              key={t.name}
              label={t.name}
              value={`${t.celsius.toFixed(0)}°C`}
              note={t.critical ? `limit ${t.critical.toFixed(0)}°` : undefined}
              frac={t.pressure}
            />
          ))}
          {sys.throttleCount !== undefined ? (
            <Line
              label="throttled"
              value={sys.throttleCount.toLocaleString()}
              note="since boot"
            />
          ) : null}
        </Block>
      ) : null}

      {sys.psiCpu !== undefined ? (
        <Block title="pressure">
          <Line label="cpu" value={`${sys.psiCpu.toFixed(0)}%`} frac={sys.psiCpu / 100} />
          <Line label="io" value={`${sys.psiIo?.toFixed(0) ?? "–"}%`} frac={(sys.psiIo ?? 0) / 100} />
          <Line
            label="memory"
            value={`${sys.psiMem?.toFixed(0) ?? "–"}%`}
            frac={(sys.psiMem ?? 0) / 100}
          />
          <p className="hint">
            Share of the last ten seconds in which at least one task was stalled waiting for the
            resource. Unlike utilisation, this measures what you feel.
          </p>
        </Block>
      ) : null}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sysblock">
      <div className="label">{title}</div>
      {children}
    </section>
  );
}

function Line({
  label,
  value,
  note,
  frac,
}: {
  label: string;
  value: string;
  note?: string;
  frac?: number;
}) {
  return (
    <div className="sysline">
      <span className="muted">{label}</span>
      {frac !== undefined ? (
        <span className="stackbar thin grow" aria-hidden="true">
          <i className="seg-used" style={{ width: `${Math.min(100, frac * 100)}%` }} />
        </span>
      ) : (
        <span className="grow" />
      )}
      <b>{value}</b>
      {note ? <span className="faint">{note}</span> : null}
    </div>
  );
}
