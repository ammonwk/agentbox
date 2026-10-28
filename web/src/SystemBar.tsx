import { useRef, useState, type ReactNode } from "react";
import type { CleanupState } from "../../src/core/cleanup";
import type { AccountView, Session, UsageWindow } from "../../src/core/types";
import { api, useMetrics, useNow, type SystemState } from "./api";
import { Icon, Spinner } from "./components";
import { selectScope } from "./route";
import "./cleanup.css";
import { accountHue, PROVIDER_LABEL } from "./bits";
import { fmtCountdown } from "./lib/format";
import { headlineWindows, resetText, usageTone, usedNow } from "./lib/usage";

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
* Subscriptions are not in the line: with a session open, its own account's
 * 5-hour and weekly windows sit in the session's facts (`AccountLimit`), so the
 * usage shown is always the usage being spent. The sheet the bar opens lists
 * every enabled account, newest activity first.
 *
 * Every cell is conditional on its own field. On a kernel without PSI, a
 * desktop with no battery, or a chip whose sensors we cannot name, the cell is
 * absent rather than showing a zero we cannot support.
 *
 * With a session open, the bar starts with that session's facts — id, context,
 * provider, account and that account's usage. SessionView puts them in `slotRef`.
 *
 * The heartbeat at the end pauses every session and starts one cleanup agent
 * (`src/core/cleanup.ts`); while the pause holds, it says how many are paused
 * and its play button resumes them.
 */

function gb(n: number): string {
  const g = n / 1024 ** 3;
  return g >= 100 ? `${Math.round(g)}G` : `${g.toFixed(1)}G`;
}

export function SystemBar({
  accounts,
  sessions,
  focusAccount,
  slotRef,
  cleanup,
}: {
  accounts: readonly AccountView[];
  sessions: readonly Session[];
  focusAccount: string | null;
  cleanup: CleanupState | null;
  /** Gets the element the open session's facts go in. */
  slotRef?: (el: HTMLElement | null) => void;
}) {
  const { metrics, stale } = useMetrics();
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);
  const sys = metrics?.system;
  const limits = recentAccounts(accounts, sessions, focusAccount);

  const slot = <div className="sys-session" ref={slotRef} />;
  // No machine figures: the first sweep has not landed, or this system gives
  // none. An empty strip would be a permanent piece of furniture claiming a
  // measurement, so only a session's facts show, and the cleanup control.
  if (!sys) {
    return (
      <div className="sysbar" data-stale={stale}>
        <div className="sysbar-line">
          {slot}
          <span className="sys-spacer" />
          <CleanupControl state={cleanup} stale={stale} />
        </div>
      </div>
    );
  }

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
      <div className="sysbar-line">
      {slot}
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
      <CleanupControl state={cleanup} stale={stale} />
      </div>

      {open ? <SystemDetail sys={sys} limits={limits} now={now} /> : null}
    </div>
  );
}

function CleanupControl({ state, stale }: { state: CleanupState | null; stale: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const run = async (resume = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await (resume ? api.resumeCleanup() : api.startCleanup());
      if (!resume && next?.sessionId && !next.error) selectScope("project", null, { page: "session", id: next.sessionId, tab: "timeline" });
      if (next?.error) setError(next.error);
    } catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="sys-cleanup" data-active={!!state}>
    {state ? <>
      <button className="sys-cleanup-link" disabled={state.phase !== "paused" || !!state.error} onClick={() => selectScope("project", null, { page: "session", id: state.sessionId, tab: "timeline" })} title="Open the machine cleanup agent">
        <Icon.pause size={14} /><span>{state.phase === "pausing" ? "Pausing…" : state.phase === "resuming" ? "Resuming…" : `${state.sessions.length} paused`}</span>
      </button>
      <button className="sys-cleanup-action" disabled={busy || stale || state.phase !== "paused"} onClick={() => void run(true)} aria-label="Finish cleanup and resume sessions" title="Finish cleanup and resume sessions">
        {busy ? <Spinner size={16} /> : <Icon.play size={18} />}
      </button>
    </> : <button className="sys-cleanup-action" disabled={busy || stale} onClick={() => void run()} aria-label="Pause sessions and clean up" title="Pause all sessions and start an agent to clean up wasted CPU and memory">
      {busy ? <Spinner size={16} /> : <Icon.heartbeat size={19} />}
    </button>}
    {error || state?.error ? <div className="sys-cleanup-error" role="alert">
      <span>{error || state?.error}</span>
      {error && !state?.error ? <button onClick={() => setError(null)} aria-label="Dismiss cleanup error"><Icon.x size={14} /></button> : null}
    </div> : null}
  </div>;
}

/** How many subscriptions the sheet lists: the ones in use, newest first. */
const LIMIT_CELLS = 6;

/**
 * The subscriptions in the sheet: every enabled account across every
 * provider, most recently active first — a session on it (started or touched),
 * or else its last usage reading. The open session's account is always among
 * them, and the list is capped so the sheet stays as tall as its other blocks.
 */
function recentAccounts(
  accounts: readonly AccountView[],
  sessions: readonly Session[],
  focusAccount: string | null,
): AccountView[] {
  const active = new Map<string, number>();
  for (const s of sessions) {
    if (!s.accountId) continue;
    const at = Math.max(s.lastActivityAt, s.startedAt);
    if (at > (active.get(s.accountId) ?? 0)) active.set(s.accountId, at);
  }
  const recency = (a: AccountView) => Math.max(active.get(a.id) ?? 0, a.usage.at ?? 0);
  const ranked = accounts
    .filter((a) => a.enabled)
    .sort((a, b) => recency(b) - recency(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, LIMIT_CELLS);
  if (focusAccount && !ranked.some((a) => a.id === focusAccount)) {
    const focused = accounts.find((a) => a.id === focusAccount);
    if (focused) ranked.splice(Math.max(0, ranked.length - 1), 1, focused);
  }
  return ranked;
}

/**
 * The open session's account, in its facts on the bar: a dot in its colour and
 * two hairline bars, 5-hour over weekly, each with its figure and the time until
 * it resets. Quiet by default; only amber or red pulls the eye.
 */
export function AccountLimit({ accountId, accounts }: { accountId: string | null; accounts: readonly AccountView[] }) {
  const now = useNow(30_000);
  const account = accounts.find((x) => x.id === accountId);
  if (!account) return null;
  const hue = accountHue(account.id, accounts);
  const { short, weekly } = headlineWindows(account.usage);
  return (
    <span
      className="sys-limit"
      data-stale={account.usage.stale ? true : undefined}
      style={hue >= 0 ? { ["--acct" as string]: `var(--acct-${hue})` } : undefined}
      title={limitTitle(account, now)}
    >
      <i className="sys-limit-dot" aria-hidden="true" />
      <LimitRow kind="5h" w={short} now={now} />
      <LimitRow kind="wk" w={weekly} now={now} />
    </span>
  );
}

/**
 * An account's windows in words, for the hover. The first line names the
 * service and the login it is showing usage for — several providers and
 * several logins on one of them are otherwise a row of identical-looking bars.
 */
function limitTitle(account: AccountView, now: number): string {
  const { short, weekly } = headlineWindows(account.usage);
  const line = (w: UsageWindow | null, name: string) =>
    w ? `${name}: ${Math.round(usedNow(w, now))}% used, ${resetText(w.resetsAt, now)}` : `${name}: no data`;
  return (
    `${whoOf(account)}\n` +
    `${line(short, "5-hour")}\n${line(weekly, "Weekly")}` +
    (account.usage.stale ? `\nStale: ${account.usage.stale}` : "")
  );
}

/** "Claude · dev@example.com · max" — service, login, plan. */
function whoOf(account: AccountView): string {
  const name = account.label || account.email || account.id;
  const email = account.email && account.email !== name ? ` · ${account.email}` : "";
  return `${PROVIDER_LABEL[account.provider]} · ${name}${email}${account.plan ? ` · ${account.plan}` : ""}`;
}

/** 5-hour on top in the accent, weekly under it in grey. The tooltip names them. */
function LimitRow({ kind, w, now }: { kind: "5h" | "wk"; w: UsageWindow | null; now: number }) {
  const pct = w ? Math.round(usedNow(w, now)) : null;
  // A 5-hour window nobody has touched has no reset time: it starts on use.
  // One that reset after the last reading is empty, like the balancer says.
  const reset = !w ? "" : w.resetsAt == null ? "idle" : w.resetsAt <= now ? "reset" : fmtCountdown(w.resetsAt - now);
  return (
    <>
      <span className="sys-limit-bar" data-tone={usageTone(pct)} data-kind={kind}>
        <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <b className="sys-limit-pct" data-tone={usageTone(pct)}>
        {pct == null ? "–" : `${pct}%`}
      </b>
      <span className="sys-limit-reset">{reset}</span>
    </>
  );
}

function Div() {
  return <span className="sys-div" aria-hidden="true" />;
}

/** The expanded sheet: everything the one-line bar had to leave out. */
function SystemDetail({ sys, limits, now }: { sys: SystemState; limits: AccountView[]; now: number }) {
  return (
    <div className="sysdetail">
      {limits.length > 0 ? (
        <Block title="subscriptions">
          <div className="syslimits">
            {/* Two lines an account — its name, then both windows side by
                side — so four accounts are as tall as the other blocks. */}
            {limits.map((a) => {
              const { short, weekly } = headlineWindows(a.usage);
              return (
                <div key={a.id} className="syslimits-acct" data-stale={a.usage.stale ? true : undefined} title={limitTitle(a, now)}>
                  <span className="muted syslimits-name">{whoOf(a)}</span>
                  <span className="syslimits-row">
                    <span className="faint">5h</span>
                    <LimitRow kind="5h" w={short} now={now} />
                    <span className="faint syslimits-wk">wk</span>
                    <LimitRow kind="wk" w={weekly} now={now} />
                  </span>
                </div>
              );
            })}
          </div>
        </Block>
      ) : null}

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
