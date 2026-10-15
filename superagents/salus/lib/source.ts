/** Where crashes come from. PostHog is the one source so far: its `$exception`
 *  events, read with HogQL through a personal API key (scope `query:read`). A
 *  test's source is any object with the same three methods. */
import type { Frame, Sample, Seen } from "./types";

export interface Source {
  /** The crashes of the last `hours`, most frequent first. */
  recent(hours: number, limit: number): Promise<Seen[]>;
  /** How often one crash happened in [since, until), and when it last did. */
  count(key: string, since: number, until: number): Promise<{ count: number; last: number | null }>;
  /** Where a person sees it. */
  link(key: string): string;
}

/** A crash's key: PostHog's issue when it grouped one, else the event's fingerprint. */
const KEY = "coalesce(properties.$exception_issue_id, properties.$exception_fingerprint)";

export class PostHog implements Source {
  constructor(
    private host: string,
    private project: string,
    private key: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async query(sql: string, values: Record<string, unknown>): Promise<unknown[][]> {
    const res = await this.fetcher(`${this.host.replace(/\/$/, "")}/api/projects/${this.project}/query/`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql, values } }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => null)) as { results?: unknown[][]; detail?: string; error?: string } | null;
    if (!res.ok) throw new Error(`PostHog answered ${res.status}: ${body?.detail ?? body?.error ?? "no detail"}`);
    return body?.results ?? [];
  }

  async recent(hours: number, limit: number): Promise<Seen[]> {
    const rows = await this.query(
      `SELECT ${KEY} AS key, count() AS n, min(timestamp), max(timestamp),
         argMax(properties.$exception_list, timestamp), argMax(properties.$current_url, timestamp), argMax(properties.$lib, timestamp)
       FROM events
       WHERE event = '$exception' AND timestamp > now() - toIntervalHour({hours})
       GROUP BY key HAVING notEmpty(ifNull(key, ''))
       ORDER BY n DESC LIMIT {limit}`,
      { hours, limit },
    );
    return rows.map(([key, n, first, last, list, url, lib]) => ({
      key: String(key),
      count: Number(n),
      first: Date.parse(String(first)),
      last: Date.parse(String(last)),
      sample: sampleOf(list, url, lib),
    }));
  }

  async count(key: string, since: number, until: number): Promise<{ count: number; last: number | null }> {
    const [row] = await this.query(
      `SELECT count(), max(timestamp) FROM events
       WHERE event = '$exception' AND ${KEY} = {key}
         AND timestamp >= fromUnixTimestamp64Milli({since}) AND timestamp < fromUnixTimestamp64Milli({until})`,
      { key, since, until },
    );
    const n = Number(row?.[0] ?? 0);
    return { count: n, last: n ? Date.parse(String(row![1])) : null };
  }

  link(key: string): string {
    return `${this.host.replace(/\/$/, "")}/project/${this.project}/error_tracking/${encodeURIComponent(key)}`;
  }
}

/** The first exception of `$exception_list`, its in-app frames first. Anything unexpected reads as unknown, never as an error. */
export function sampleOf(list: unknown, url: unknown, lib: unknown): Sample | null {
  let parsed = list;
  if (typeof list === "string") {
    try {
      parsed = JSON.parse(list);
    } catch {
      return null;
    }
  }
  const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) return null;
  const raw = ((first.stacktrace as { frames?: unknown[] } | undefined)?.frames ?? []) as Record<string, unknown>[];
  const frames: Frame[] = raw
    .map((f) => ({
      file: String(f.filename ?? f.abs_path ?? f.source ?? "?"),
      fn: typeof f.function === "string" ? f.function : null,
      line: typeof f.lineno === "number" ? f.lineno : null,
      inApp: f.in_app === true,
    }))
    .slice(-40);
  return {
    type: String(first.type ?? "Error").slice(0, 200),
    value: String(first.value ?? "").slice(0, 2000),
    frames,
    url: typeof url === "string" && url ? url.split(/[?#]/)[0]!.slice(0, 500) : null,
    lib: typeof lib === "string" ? lib : null,
  };
}
