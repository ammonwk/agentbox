/** Pure formatting. No DOM, no clock of its own: every function that depends
 *  on "now" takes it as an argument, so tests are not clock-dependent. */

export function ago(ts: number | string, at: number = Date.now()): string {
  const n = typeof ts === "string" ? new Date(ts).getTime() : ts;
  if (!Number.isFinite(n)) return "—";
  const s = Math.max(0, (at - n) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Time of day, for tooltips: when a thing actually happened. */
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Elapsed as a duration, for "running for 4m 12s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * A countdown, coarse on purpose: "3h 12m", "2d 4h", "12m", "<1m". Minutes are
 * the finest grain a rate-limit window is worth reading at.
 */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "<1m";
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  if (h < 24) return `${h}h ${totalMin % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function fmtCost(cost: number | null | undefined): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `${(cost * 100).toFixed(2)}¢`;
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost).toLocaleString()}`;
}

export function fmtTokens(t: number | null | undefined): string {
  if (t == null) return "—";
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1000) return `${(t / 1000).toFixed(t >= 100_000 ? 0 : 1)}k`;
  return `${t}`;
}

/** Binary units, because that is what `du` reports. */
export function fmtBytes(b: number): string {
  if (b <= 0) return "0 B";
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${Math.round(b / (1 << 20))} MB`;
  if (b >= 1 << 10) return `${Math.round(b / (1 << 10))} KB`;
  return `${b} B`;
}

/** Last path segment: `/home/me/code/agentbox/` → `agentbox`. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** `/home/me/x` → `~/x` when we can tell what home is. */
export function tildify(path: string, home: string | null): string {
  if (home && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

/** Guess the user's home from any absolute path under /home/<u> or /Users/<u>. */
export function guessHome(paths: readonly string[]): string | null {
  for (const p of paths) {
    const m = /^(\/home\/[^/]+|\/Users\/[^/]+)(\/|$)/.exec(p);
    if (m) return m[1];
  }
  return null;
}

/** Weekly points, as the balancer speaks them: one decimal below 100 (and
 *  none when it is a whole number), whole numbers above. */
export function fmtPts(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Math.abs(n) < 100 ? Math.round(n * 10) / 10 : Math.round(n);
  return String(Object.is(r, -0) ? 0 : r);
}

export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
