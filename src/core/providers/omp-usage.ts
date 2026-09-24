/** omp's own usage report (`omp usage --json`), as agentbox usage windows.
 *
 * omp balances its own credential pool, so agentbox cannot ask each provider
 * itself; omp already does, per authenticated account, and prints one report
 * per provider account. Every limit in every report becomes one window.
 */

import type { AccountUsage, UsageWindow, WindowKind } from "../types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Which bucket a window of this length belongs to. Generous bounds, since
 *  providers report "5 hour", "daily", "7 day", "30 day" and odd ones between. */
export function kindForDuration(ms: number): WindowKind {
  if (ms <= 12 * HOUR) return "short";
  if (ms <= 2 * DAY) return "daily";
  if (ms <= 10 * DAY) return "weekly";
  return "monthly";
}

/** A duration for limits that name their window but do not measure it. */
function durationFromName(s: string): number | null {
  const t = s.toLowerCase();
  const h = /(\d+)\s*-?\s*h(ou)?r?/.exec(t);
  if (h) return Number(h[1]) * HOUR;
  if (/week|7\s*-?\s*d/.test(t)) return 7 * DAY;
  if (/month|30\s*-?\s*d/.test(t)) return 30 * DAY;
  if (/day|daily|24\s*-?\s*h/.test(t)) return DAY;
  return null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Pure mapping from the parsed JSON to an `AccountUsage`. Limits that give no
 * way to compute a fraction are skipped (and said so in `notes`) rather than
 * shown as 0% — an unknown is not the same as unused.
 */
export function parseOmpUsage(json: unknown, accountId: string): AccountUsage {
  const doc = (json ?? {}) as { generatedAt?: unknown; reports?: unknown };
  const reports = Array.isArray(doc.reports) ? (doc.reports as any[]) : [];
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const seen = new Map<string, number>();
  let at: number | null = null;

  for (const r of reports) {
    const provider = typeof r?.provider === "string" ? r.provider : "unknown";
    const fetched = num(r?.fetchedAt);
    // The oldest reading is when the set as a whole was last true.
    if (fetched !== null) at = at === null ? fetched : Math.min(at, fetched);
    const plan = typeof r?.metadata?.planType === "string" ? r.metadata.planType : null;
    if (plan) notes.push(`${provider}: ${plan}`);
    for (const n of Array.isArray(r?.notes) ? r.notes : []) if (typeof n === "string") notes.push(`${provider}: ${n}`);

    for (const l of Array.isArray(r?.limits) ? r.limits : []) {
      const limitId = typeof l?.id === "string" ? l.id : "limit";
      const amount = l?.amount ?? {};
      let frac = num(amount.usedFraction);
      if (frac === null && num(amount.remainingFraction) !== null) frac = 1 - num(amount.remainingFraction)!;
      if (frac === null && num(amount.used) !== null && num(amount.limit)) frac = num(amount.used)! / num(amount.limit)!;
      if (frac === null && l?.status === "exhausted") frac = 1;
      const label = `${provider} ${typeof l?.label === "string" ? l.label : limitId}`;
      if (frac === null) {
        notes.push(`${label}: no usage figure`);
        continue;
      }
      const w = l?.window ?? {};
      const windowMs =
        num(w.durationMs) ?? durationFromName(`${w.id ?? ""} ${w.label ?? ""} ${limitId}`) ?? null;
      if (windowMs === null) {
        notes.push(`${label}: unknown window length`);
        continue;
      }
      // Two accounts on one provider report the same limit ids.
      const base = `${provider}:${limitId}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const win: UsageWindow = {
        id: count === 1 ? base : `${base}#${count}`,
        kind: kindForDuration(windowMs),
        label,
        usedPct: Math.max(0, Math.min(100, frac * 100)),
        resetsAt: num(w.resetsAt),
        windowMs,
      };
      if (typeof l?.scope?.modelId === "string" && l.scope.modelId) win.scope = { model: l.scope.modelId };
      windows.push(win);
    }
  }

  return {
    accountId,
    at: at ?? num(doc.generatedAt),
    windows,
    stale: null,
    source: "cli",
    notes,
  };
}

/** Env for running omp against the default agent dir; see `ompAccountEnv`. */
const OMP_REDIRECT_VARS = [
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

export function ompRedirectVars(): string[] {
  return [...OMP_REDIRECT_VARS];
}

/**
 * Run `omp usage --json` and map it. Never throws: a failure is a usage with
 * no windows and `stale` saying why, which is what the Accounts page shows.
 */
export async function ompUsage(
  accountId: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<AccountUsage> {
  const fail = (why: string): AccountUsage => ({
    accountId,
    at: null,
    windows: [],
    stale: why,
    source: "none",
    notes: [],
  });
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of OMP_REDIRECT_VARS) delete env[k];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.bin ?? "omp", "usage", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch (e) {
    return fail(`omp not runnable: ${(e as Error).message}`);
  }
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    if (timedOut) return fail(`omp usage timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (code !== 0) return fail(`omp usage exited ${code}`);
    try {
      return parseOmpUsage(JSON.parse(out), accountId);
    } catch {
      return fail("omp usage printed something that is not JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}
