import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AppState, InsightSession, Rebuild, RebuildCause, Spend, SpendPart, UsageInsights } from "../../../src/core/types";
import { api } from "../api";
import { accountHue, ProviderBadge } from "../bits";
import { Button, Empty, Icon, Spinner } from "../components";
import { baseName, fmtBytes, fmtDur } from "../lib/format";
import { hrefOf } from "../route";
import "./insights.css";

/**
 * Where one account's usage went over the last days: every model call in its
 * transcripts, priced at API rates so reads, writes and output add up
 * (`src/core/insights.ts`). Leads with what the numbers say, in sentences,
 * then the charts and tables they come from.
 */
export function Insights({ state, accountId }: { state: AppState; accountId: string }) {
  const account = state.accounts.find((a) => a.id === accountId || a.alsoAt.some((h) => h.id === accountId)) ?? null;
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UsageInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .insights(accountId, days)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [accountId, days]);
  useEffect(load, [load]);

  const hue = account ? accountHue(account.id, state.accounts) : 0;
  const titleOf = useCallback(
    (s: { sessionId: string | null; title: string }) =>
      s.sessionId ? (state.sessions.find((x) => x.id === s.sessionId)?.title ?? s.title) : s.title,
    [state.sessions],
  );

  return (
    <div data-nav-region="detail" tabIndex={-1} aria-label="Account insights" className="ins" style={{ ["--acct" as string]: `var(--acct-${hue})` }}>
      <header className="ins-head">
        <a data-nav-back className="ins-back" href={hrefOf({ page: "accounts", sub: "accounts" })}>
          <Icon.chevronLeft size={14} /> Accounts
        </a>
        <div className="ins-who">
          <span className="ins-swatch" aria-hidden="true" />
          <h2>{account?.label ?? accountId}</h2>
          {account ? <ProviderBadge provider={account.provider} /> : null}
          {account?.plan ? <span className="ins-plan">{account.plan}</span> : null}
        </div>
        <div className="ins-controls">
          <div className="seg" role="group" aria-label="Span">
            {[1, 3, 7].map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                {d === 1 ? "24 hours" : `${d} days`}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" icon={Icon.refresh} loading={loading} onClick={load} aria-label="Read again" />
        </div>
      </header>

      {error ? (
        <Empty title="Could not read this account's usage" action={<Button onClick={load}>Try again</Button>}>
          <p className="mono">{error}</p>
        </Empty>
      ) : !data || data.accountId !== (account?.id ?? accountId) ? (
        <div className="ins-loading card">
          <Spinner size={16} />
          <div>
            <strong>Reading this account's transcripts…</strong>
            <p className="hint">
              The first look reads the whole week — a gigabyte or more for a busy Claude account, a few seconds per gigabyte. After that only what was
              added since is read.
            </p>
          </div>
        </div>
      ) : (
        <Report data={data} titleOf={titleOf} />
      )}
    </div>
  );
}

type TitleOf = (s: { sessionId: string | null; title: string }) => string;

function Report({ data, titleOf }: { data: UsageInsights; titleOf: TitleOf }) {
  const total = costOf(data.total);
  if (data.total.calls === 0) {
    return (
      <Empty title="Nothing spent in this span">
        No model calls on this account{" "}
        {data.to - data.from > 2 * DAY ? `in the last ${Math.round((data.to - data.from) / DAY)} days` : "in the last day"}.
      </Empty>
    );
  }
  const bySession = new Map(data.sessions.map((s) => [s.key, s]));
  return (
    <>
      <Findings data={data} titleOf={titleOf} />
      <Tiles data={data} total={total} />
      <div className="ins-cols">
        <Section
          title="Where it went"
          hint="API-equivalent dollars: what these tokens would cost at list prices. The plan does not bill them, but it is the one scale on which a cache read, a cache write and an output token add up."
        >
          <Composition spend={data.total} provider={data.provider} />
        </Section>
        <Section
          title="Over time"
          hint={`Spend per hour${data.weekly ? ", and the weekly bar over the same hours" : ""}. Tap or hover for the hour.`}
        >
          <Timeline data={data} />
        </Section>
      </div>
      <Sessions data={data} titleOf={titleOf} total={total} />
      {data.rebuilds && data.rebuilds.count > 0 ? <Rebuilds data={data} bySession={bySession} titleOf={titleOf} total={total} /> : null}
      <div className="ins-cols">
        {data.context.length ? <Context data={data} total={total} /> : null}
        {data.agents ? <Agents data={data} total={total} /> : null}
        {data.models.length > 1 ? <Models data={data} total={total} /> : null}
      </div>
      <p className="hint ins-foot">
        {data.source === "transcripts" ? (
          <>
            Read from {data.scan.files.toLocaleString()} transcripts
            {data.scan.bytes ? ` (${fmtBytes(data.scan.bytes)} new)` : ""} in {fmtDur(data.scan.ms)}. Calls a session made before it was moved here
            from another account are left out; a session moved away takes its calls with it.
          </>
        ) : (
          <>
            {data.provider} keeps no per-call usage agentbox can read, so this is built from the token totals agentbox sampled as each session moved:
            no cache, context or wait detail.
          </>
        )}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- vocabulary

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PARTS: SpendPart[] = ["cacheRead", "write1h", "write5m", "output", "input"];

const PART: Record<SpendPart, { label: string; what: string }> = {
  cacheRead: {
    label: "Cache reads",
    what: "Context already cached, read again by every call: the whole conversation so far, each time.",
  },
  write1h: {
    label: "Cache writes, 1 hour",
    what: "New context a session adds, kept an hour, at twice the input price.",
  },
  write5m: {
    label: "Cache writes, 5 minutes",
    what: "Subagents' new context, kept five minutes, at 1.25× the input price.",
  },
  output: { label: "Output", what: "What the model wrote." },
  input: { label: "Uncached input", what: "Input read without a cache." },
};

const CAUSE: Record<RebuildCause, { label: string; what: string }> = {
  teammate: {
    label: "Waiting on a message",
    what: "from its lead, a teammate or another session",
  },
  subagent: {
    label: "Waiting on its own subagent",
    what: "a subagent it started outlasted its cache",
  },
  command: {
    label: "Waiting on a long tool call",
    what: "a CI watch, a build, a sleep",
  },
  background: {
    label: "Woken by a background task",
    what: "a background command or agent finished, or a wakeup fired",
  },
  you: { label: "Waiting for you", what: "it sat until your next message" },
  compact: {
    label: "Compaction",
    what: "the summary that replaces the conversation is new context",
  },
  miss: {
    label: "Missed with no long wait",
    what: "a restart, or a change of model, tools or settings",
  },
};

const costOf = (s: Spend): number => PARTS.reduce((a, p) => a + s.cost[p], 0);

function money(n: number): string {
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `${Math.max(1, Math.round(n * 100))}¢`;
  return "$0";
}
/** Tokens, to the billion: a week of cache reads runs to billions. */
function fmtTokens(n: number): string {
  const r = (x: number) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString();
  if (n >= 1e9) return `${r(n / 1e9)}B`;
  if (n >= 1e6) return `${r(n / 1e6)}M`;
  if (n >= 1e3) return `${r(n / 1e3)}K`;
  return String(Math.round(n));
}
const share = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");

const DAY_FMT = new Intl.DateTimeFormat([], {
  weekday: "short",
  day: "numeric",
});
const WHEN_FMT = new Intl.DateTimeFormat([], {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const HOUR_FMT = new Intl.DateTimeFormat([], { hour: "numeric" });

// ------------------------------------------------------------------ findings

/** What the numbers say that the charts would make you work for, as
 *  sentences: each one only when it is big enough to matter. */
function Findings({ data, titleOf }: { data: UsageInsights; titleOf: TitleOf }) {
  const items = findingsOf(data, titleOf);
  if (!items.length) return null;
  return (
    <section className="ins-findings card" aria-label="Findings">
      <h3>What stands out</h3>
      <ul>
        {items.map((f, i) => (
          <li key={i} data-tone={f.tone}>
            {f.tone === "warn" ? <Icon.alert size={14} /> : <Icon.bolt size={14} />}
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function findingsOf(d: UsageInsights, titleOf: TitleOf): { tone?: "warn"; text: ReactNode }[] {
  const out: { tone?: "warn"; text: ReactNode }[] = [];
  const total = costOf(d.total);
  const w = d.weekly;

  if (w && w.atLimit.cost > total * 0.02 && w.limitAt) {
    out.push({
      tone: "warn",
      text: (
        <>
          <b>{money(w.atLimit.cost)}</b> ({share(w.atLimit.cost, total)} of the span, {w.atLimit.calls.toLocaleString()} calls) ran after the weekly
          bar read 100% on {WHEN_FMT.format(w.limitAt)}. {d.provider === "codex" ? "Codex" : "Claude"} serves calls past the weekly limit only from extra usage or credits, billed apart from the plan.
        </>
      ),
    });
  }

  const read = d.total.cost.cacheRead;
  if (read > total * 0.35) {
    out.push({
      text: (
        <>
          <b>Cache reads were {share(read, total)}</b> of the spend, output only {share(d.total.cost.output, total)}. Every call reads the whole
          conversation again, so a long session pays for its context on each tool call — {fmtTokens(d.total.tokens.cacheRead)} tokens read for{" "}
          {fmtTokens(d.total.tokens.output)} written.
        </>
      ),
    });
  }

  const top = d.sessions[0];
  if (top && costOf(top.spend) > total * 0.2) {
    const own = costOf(top.spend) - costOf(top.agentSpend);
    out.push({
      text: (
        <>
          One session, <b>“{titleOf(top)}”</b>, was {share(costOf(top.spend), total)} of it
          {top.agentCount > 0 ? (
            <>
              {" "}
              — {share(costOf(top.agentSpend), costOf(top.spend))} of that in its {top.agentCount} subagents, {money(own)} in the session itself
            </>
          ) : null}
          {top.prompts > 0 ? <>, on {top.prompts === 1 ? "one message" : `${top.prompts} messages`} from you</> : null}.
        </>
      ),
    });
  } else if (d.sessions.length >= 5) {
    const five = d.sessions.slice(0, 5).reduce((a, s) => a + costOf(s.spend), 0);
    if (five > total * 0.5)
      out.push({
        text: (
          <>
            The top five of {d.sessionCount} sessions were <b>{share(five, total)}</b> of the spend.
          </>
        ),
      });
  }

  if (d.agents && costOf(d.agents.spend) > total * 0.2) {
    out.push({
      text: (
        <>
          <b>Subagents and teammates spent {share(costOf(d.agents.spend), total)}</b> — {d.agents.count.toLocaleString()} of them. The board shows one
          row per session; this is the work under those rows.
        </>
      ),
    });
  }

  const rb = d.rebuilds;
  if (rb && rb.cost > total * 0.03) {
    const worst = rb.causes[0]!;
    out.push({
      text: (
        <>
          <b>{money(rb.cost)}</b> ({share(rb.cost, total)}) went to writing contexts again after their cache had expired; read warm, the same tokens
          would have cost {money(rb.warmCost)}. Most of it was <b>{CAUSE[worst.cause].label.toLowerCase()}</b> ({money(worst.cost)}).
        </>
      ),
    });
    const burst = rb.bursts[0];
    if (burst && burst.cost > total * 0.005) {
      const more = rb.bursts.length - 1;
      out.push({
        text: (
          <>
            On {WHEN_FMT.format(burst.at)}, <b>{burst.sessions} sessions</b> that had sat an hour or more rebuilt their caches within ten minutes of each other (
            {money(burst.cost)}): something woke them together — a restart, a recovery, one message sent to all of them.
            {more > 0 ? ` It happened ${more === 1 ? "once more" : `${more} more times`} in the span.` : ""}
          </>
        ),
      });
    }
    if (rb.agents.cost > rb.cost * 0.4) {
      out.push({
        text: (
          <>
            A session's cache lasts an hour, a subagent's <b>five minutes</b>: {rb.agents.count} of those rebuilds ({money(rb.agents.cost)}) were
            subagents that waited longer than that — on a teammate, a subagent of their own, a CI watch — and then wrote their whole context again.
          </>
        ),
      });
    }
  }

  const big = d.context.filter((c) => c.from >= 400_000);
  const small = d.context.filter((c) => (c.to ?? Infinity) <= 100_000);
  const bigCost = big.reduce((a, c) => a + c.cost, 0);
  const bigCalls = big.reduce((a, c) => a + c.calls, 0);
  const smallCalls = small.reduce((a, c) => a + c.calls, 0);
  if (bigCost > total * 0.25 && bigCalls > 0 && smallCalls > 0) {
    const smallAvg = small.reduce((a, c) => a + c.cost, 0) / smallCalls;
    out.push({
      text: (
        <>
          Calls carrying <b>over 400K of context</b> were {share(bigCalls, d.total.calls)} of the calls and {share(bigCost, total)} of the spend:
          about {money(bigCost / bigCalls)} each, against {money(smallAvg)} under 100K. Starting fresh, or handing a task to a subagent with a short
          brief, is cheaper than one more turn at 700K.
        </>
      ),
    });
  }

  // How bursty: the fewest hours that hold half the spend.
  const sorted = d.hours.map(costOf).sort((a, b) => b - a);
  let acc = 0;
  let n = 0;
  while (n < sorted.length && acc < total / 2) acc += sorted[n++]!;
  if (d.hours.length >= 48 && n <= d.hours.length / 8) {
    out.push({
      text: (
        <>
          Half the spend came in{" "}
          <b>
            {n} of the {d.hours.length} hours
          </b>
          .
        </>
      ),
    });
  }

  if (w?.perPoint) {
    out.push({
      text: (
        <>
          A weekly point here was worth about <b>{money(w.perPoint)}</b> at API prices, so the whole week's allowance is roughly{" "}
          {money(w.perPoint * 100)}.
        </>
      ),
    });
  }

  if (d.total.thinking > d.total.tokens.output * 0.3) {
    out.push({
      text: <>Thinking was {share(d.total.thinking, d.total.tokens.output)} of the output tokens.</>,
    });
  }
  return out;
}

// --------------------------------------------------------------------- tiles

function Tiles({ data, total }: { data: UsageInsights; total: number }) {
  const w = data.weekly;
  const days = Math.round((data.to - data.from) / DAY);
  return (
    <div className="ins-tiles">
      <Tile
        label="API-equivalent spend"
        value={money(total)}
        note={`${data.total.calls.toLocaleString()} calls · ${days <= 1 ? "24 hours" : `${days} days`}`}
        hero
      />
      {w ? (
        <Tile
          label="Weekly bar"
          value={`+${Math.round(w.gained)} pts`}
          note={w.perPoint ? `≈ ${money(w.perPoint)} a point` : "too little movement to price a point"}
        />
      ) : null}
      {data.agents ? (
        <Tile
          label="Subagents"
          value={share(costOf(data.agents.spend), total)}
          note={`${data.agents.count.toLocaleString()} of them · ${money(costOf(data.agents.spend))}`}
        />
      ) : null}
      {data.rebuilds ? (
        <Tile
          label="Cache rebuilds"
          value={money(data.rebuilds.cost)}
          note={`${data.rebuilds.count} calls · ${share(data.rebuilds.cost, total)} of spend`}
        />
      ) : null}
      {w && w.atLimit.calls > 0 ? (
        <Tile label="Past the weekly limit" value={money(w.atLimit.cost)} note={`${w.atLimit.calls.toLocaleString()} calls at 100%`} tone="warn" />
      ) : null}
      <Tile
        label="Sessions"
        value={data.sessionCount.toLocaleString()}
        note={data.limitHits.length ? `${data.limitHits.length} limit ${data.limitHits.length === 1 ? "stop" : "stops"}` : "no limit stops"}
      />
    </div>
  );
}

function Tile({ label, value, note, hero, tone }: { label: string; value: string; note: string; hero?: boolean; tone?: "warn" }) {
  return (
    <div className="ins-tile card" data-hero={hero || undefined} data-tone={tone}>
      <span className="ins-tile-label">{label}</span>
      <b>{value}</b>
      <span className="ins-tile-note">{note}</span>
    </div>
  );
}

function Section({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`ins-sec card ${className ?? ""}`}>
      <h3>{title}</h3>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

// --------------------------------------------------------------- composition

function Composition({ spend, provider }: { spend: Spend; provider: UsageInsights["provider"] }) {
  const total = costOf(spend);
  const parts = PARTS.filter((p) => spend.cost[p] > 0 || spend.tokens[p] > 0);
  return (
    <div className="ins-comp">
      <div className="ins-stack" role="img" aria-label={parts.map((p) => `${PART[p].label} ${share(spend.cost[p], total)}`).join(", ")}>
        {parts.map((p) =>
          spend.cost[p] / total >= 0.004 ? (
            <span key={p} data-part={p} style={{ flexGrow: spend.cost[p] }} title={`${PART[p].label}: ${money(spend.cost[p])}`} />
          ) : null,
        )}
      </div>
      <table className="ins-table ins-legend">
        <thead>
          <tr>
            <th>Part</th>
            <th className="num">Tokens</th>
            <th className="num">Spend</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={p}>
              <td className="ins-legend-cell">
                <span className="ins-key" data-part={p} aria-hidden="true" />
                <span>
                  <span className="ins-part">{PART[p].label}</span>
                  <span className="ins-what">
                    {p === "output" && spend.thinking > 0
                      ? `${PART[p].what} ${share(spend.thinking, spend.tokens.output)} of it thinking.`
                      : p === "input" && provider === "codex"
                        ? "Input it had not cached."
                        : PART[p].what}
                  </span>
                </span>
              </td>
              <td className="num">{fmtTokens(spend.tokens[p])}</td>
              <td className="num">{money(spend.cost[p])}</td>
              <td className="num">{share(spend.cost[p], total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A tidy axis maximum and its ticks: 1, 2 or 5 times a power of ten. */
function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(v);
  return out;
}

/** The spans where the weekly read 100%: from that reading to the next below it. */
function fullSpans(d: UsageInsights): [number, number][] {
  const pts = d.weekly?.points ?? [];
  const out: [number, number][] = [];
  pts.forEach((p, i) => {
    if (p.pct < 100 || (i > 0 && pts[i - 1]!.pct >= 100)) return;
    out.push([p.at, pts.slice(i + 1).find((q) => q.pct < 100)?.at ?? d.to]);
  });
  return out;
}

const PAD = { left: 40, right: 6 };

/** Spend per hour as stacked columns, and under it — its own chart, its own
 *  axis, the same hours — the weekly bar. */
function Timeline({ data }: { data: UsageInsights }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.hours.length;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const band = n ? plotW / n : 0;
  const xOf = (t: number) => PAD.left + ((t - data.from) / HOUR) * band;
  const narrow = width < 520;
  const H = narrow ? 150 : 190;
  const top = 8;
  const bottom = 20;
  const costs = data.hours.map(costOf);
  const ticks = niceTicks(Math.max(...costs, 0.01));
  const yMax = ticks[ticks.length - 1]!;
  const yOf = (v: number) => top + (H - top - bottom) * (1 - v / yMax);
  const full = fullSpans(data);

  // Day lines at local midnight; over one day, every six hours.
  const marks: { t: number; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = data.from + i * HOUR;
    const h = new Date(t).getHours();
    if (n <= 24 ? h % 6 === 0 : h === 0)
      marks.push({
        t,
        label: n <= 24 ? HOUR_FMT.format(t) : DAY_FMT.format(t),
      });
  }

  const pick = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - PAD.left) / band);
    setHover(i >= 0 && i < n ? i : null);
  };
  const hours = hover !== null ? data.hours[hover]! : null;
  const at = hover !== null ? data.from + hover * HOUR : 0;
  const weeklyAt = hover !== null ? [...(data.weekly?.points ?? [])].reverse().find((p) => p.at <= at + HOUR) : undefined;

  const W = data.weekly;
  const wH = 64;
  const wy = (p: number) => 6 + (wH - 12) * (1 - Math.min(100, p) / 100);
  const wPath = W?.points.length
    ? W.points
        .map((p, i) => {
          const x = Math.max(PAD.left, Math.min(width - PAD.right, xOf(p.at)));
          return i === 0 ? `M${x},${wy(p.pct)}` : `H${x}V${wy(p.pct)}`;
        })
        .join("") + `H${xOf(data.to)}`
    : "";

  return (
    <div className="ins-time" ref={ref}>
      {width > 0 ? (
        <>
          <div className="ins-chart-legend" aria-hidden="true">
            {PARTS.filter((p) => data.total.cost[p] > 0).map((p) => (
              <span key={p}>
                <span className="ins-key" data-part={p} />
                {PART[p].label}
              </span>
            ))}
            {full.length ? (
              <span>
                <span className="ins-key ins-key-full" />
                Weekly at 100%
              </span>
            ) : null}
          </div>
          <svg
            width={width}
            height={H}
            className="ins-svg"
            role="img"
            aria-label={`Spend per hour, at most ${money(Math.max(...costs))}`}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
          >
            {full.map(([a, b]) => (
              <rect
                key={a}
                className="ins-full"
                x={Math.max(PAD.left, xOf(a))}
                y={top}
                width={Math.max(0, Math.min(width - PAD.right, xOf(b)) - Math.max(PAD.left, xOf(a)))}
                height={H - top - bottom}
              />
            ))}
            {ticks.map((v) => (
              <g key={v}>
                <line className="ins-grid" x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} />
                <text className="ins-axis" x={PAD.left - 6} y={yOf(v)} dy="0.32em" textAnchor="end">
                  {v === 0 ? "$0" : money(v)}
                </text>
              </g>
            ))}
            {marks.map((m) => (
              <g key={m.t}>
                <line className="ins-grid" x1={xOf(m.t)} x2={xOf(m.t)} y1={top} y2={H - bottom + 4} />
                <text className="ins-axis" x={xOf(m.t) + 3} y={H - 6}>
                  {narrow && n > 24 ? m.label.split(" ")[0]!.slice(0, 2) : m.label}
                </text>
              </g>
            ))}
            {hover !== null ? <rect className="ins-hover" x={PAD.left + hover * band} y={top} width={band} height={H - top - bottom} /> : null}
            {data.hours.map((h, i) => {
              let y = yOf(0);
              const bw = Math.max(1, Math.min(24, band - (band >= 4 ? 1 : 0)));
              const x = PAD.left + i * band + (band - bw) / 2;
              return (
                <g key={i}>
                  {PARTS.map((p) => {
                    const v = h.cost[p];
                    if (v <= 0) return null;
                    const hgt = (H - top - bottom) * (v / yMax);
                    y -= hgt;
                    return <rect key={p} data-part={p} x={x} y={y} width={bw} height={hgt} />;
                  })}
                </g>
              );
            })}
          </svg>
          {W && W.points.length ? (
            <>
              <div className="ins-sub-label">Weekly bar</div>
              <svg
                width={width}
                height={wH}
                className="ins-svg"
                role="img"
                aria-label="The weekly bar over the same hours"
                onPointerMove={pick}
                onPointerDown={pick}
                onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
              >
                {[0, 50, 100].map((v) => (
                  <g key={v}>
                    <line className="ins-grid" x1={PAD.left} x2={width - PAD.right} y1={wy(v)} y2={wy(v)} />
                    <text className="ins-axis" x={PAD.left - 6} y={wy(v)} dy="0.32em" textAnchor="end">
                      {v}%
                    </text>
                  </g>
                ))}
                {hover !== null ? <rect className="ins-hover" x={PAD.left + hover * band} y={0} width={band} height={wH} /> : null}
                <path className="ins-weekly" d={wPath} />
                {data.limitHits.map((t) => (
                  <circle key={t} className="ins-hit" cx={xOf(t)} cy={wy(100)} r={4}>
                    <title>Stopped at a limit {WHEN_FMT.format(t)}</title>
                  </circle>
                ))}
              </svg>
            </>
          ) : null}
          {hours && hover !== null ? (
            <div
              className="ins-tip"
              data-docked={narrow || undefined}
              style={narrow ? undefined : { left: Math.min(Math.max(PAD.left + hover * band + band / 2, 100), width - 100) }}
            >
              <div className="ins-tip-head">
                {WHEN_FMT.format(at)}
                <b>{money(costOf(hours))}</b>
              </div>
              {PARTS.filter((p) => hours.cost[p] > 0).map((p) => (
                <div key={p} className="ins-tip-row">
                  <span className="ins-key" data-part={p} />
                  <span>{PART[p].label}</span>
                  <span className="num">{money(hours.cost[p])}</span>
                </div>
              ))}
              <div className="ins-tip-row faint">
                <span />
                <span>
                  {hours.calls.toLocaleString()} calls
                  {weeklyAt ? ` · weekly ${Math.round(weeklyAt.pct)}%` : ""}
                </span>
                <span />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ sessions

function Sessions({ data, titleOf, total }: { data: UsageInsights; titleOf: TitleOf; total: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const max = Math.max(...data.sessions.map((s) => costOf(s.spend)), 0.01);
  const shown = all ? data.sessions : data.sessions.slice(0, 10);
  const hasAgents = data.sessions.some((s) => s.agentCount > 0);
  return (
    <Section
      title="Sessions"
      hint={`The costliest of ${data.sessionCount}, each with its subagents and teammates. Open one for who spent it.`}
    >
      {hasAgents ? (
        <div className="ins-chart-legend" aria-hidden="true">
          <span>
            <span className="ins-key ins-key-own" />
            The session itself
          </span>
          <span>
            <span className="ins-key ins-key-agents" />
            Its subagents
          </span>
        </div>
      ) : null}
      <ol className="ins-sessions">
        {shown.map((s) => (
          <SessionRow
            key={s.key}
            s={s}
            title={titleOf(s)}
            max={max}
            total={total}
            open={open === s.key}
            onToggle={() => setOpen(open === s.key ? null : s.key)}
          />
        ))}
      </ol>
      {data.sessions.length > shown.length || all ? (
        <Button size="sm" variant="ghost" icon={all ? Icon.chevronUp : Icon.chevronDown} className="ins-more" onClick={() => setAll(!all)}>
          {all ? "Show the top 10" : `Show all ${data.sessions.length}`}
        </Button>
      ) : null}
    </Section>
  );
}

function SessionRow({
  s,
  title,
  max,
  total,
  open,
  onToggle,
}: {
  s: InsightSession;
  title: string;
  max: number;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  const cost = costOf(s.spend);
  const agents = costOf(s.agentSpend);
  return (
    <li className="ins-srow" data-open={open || undefined}>
      <div className="ins-srow-main">
        <div className="ins-srow-text">
          {s.sessionId ? (
            <a
              className="ins-srow-title"
              href={hrefOf({
                page: "session",
                id: s.sessionId,
                tab: "timeline",
              })}
            >
              {title}
            </a>
          ) : (
            <span className="ins-srow-title">{title}</span>
          )}
          <span className="ins-srow-meta">
            {s.cwd ? <span className="mono">{baseName(s.cwd)}</span> : null}
            <span>{WHEN_FMT.format(s.lastAt)}</span>
            <span>{s.spend.calls.toLocaleString()} calls</span>
            {s.prompts > 0 ? (
              <span title="Spend per message you sent it">
                {s.prompts} msg · {money(cost / s.prompts)} each
              </span>
            ) : null}
            {s.peakContext > 0 ? <span title="The most context one call carried">peak {fmtTokens(s.peakContext)}</span> : null}
            {s.rebuildCost > 0.005 * total ? <span title="Cache rebuilds">rebuilds {money(s.rebuildCost)}</span> : null}
          </span>
        </div>
        <div className="ins-srow-cost">
          <b>{money(cost)}</b>
          <span className="faint">{share(cost, total)}</span>
        </div>
        {s.agentCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            icon={open ? Icon.chevronUp : Icon.chevronDown}
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} its ${s.agentCount} subagents`}
          />
        ) : (
          <span className="ins-srow-pad" />
        )}
      </div>
      <div className="ins-srow-bar" aria-hidden="true">
        <span className="ins-own" style={{ width: `${((cost - agents) / max) * 100}%` }} />
        {agents > 0 ? <span className="ins-agents" style={{ width: `${(agents / max) * 100}%` }} /> : null}
      </div>
      {open ? (
        <table className="ins-table ins-agents-table">
          <thead>
            <tr>
              <th>
                Subagent
                {s.agentCount > s.agents.length ? ` (top ${s.agents.length} of ${s.agentCount})` : ""}
              </th>
              <th className="num">Calls</th>
              <th className="num hide-narrow">Peak context</th>
              <th className="num hide-narrow">Rebuilds</th>
              <th className="num">Spend</th>
            </tr>
          </thead>
          <tbody>
            {s.agents.map((a, i) => (
              <tr key={i}>
                <td>
                  <span className="ins-agent-name">{a.name}</span>
                  {a.type && a.type !== a.name ? <span className="ins-agent-type">{a.type}</span> : null}
                </td>
                <td className="num">{a.spend.calls.toLocaleString()}</td>
                <td className="num hide-narrow">{fmtTokens(a.peakContext)}</td>
                <td className="num hide-narrow">{a.rebuildCost > 0 ? money(a.rebuildCost) : "—"}</td>
                <td className="num">{money(costOf(a.spend))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

// ------------------------------------------------------------------ rebuilds

function Rebuilds({
  data,
  bySession,
  titleOf,
  total,
}: {
  data: UsageInsights;
  bySession: Map<string, InsightSession>;
  titleOf: TitleOf;
  total: number;
}) {
  const rb = data.rebuilds!;
  const max = Math.max(...rb.causes.map((c) => c.cost), 0.01);
  return (
    <Section
      title="Cache rebuilds"
      hint={`Calls that wrote a whole context again because its cache had expired while it waited: ${money(rb.cost)} (${share(rb.cost, total)}), where reading it warm would have cost ${money(rb.warmCost)}. A session's cache lasts an hour; a subagent's five minutes.`}
    >
      <div className="ins-causes">
        {rb.causes.map((c) => (
          <div key={c.cause} className="ins-cause">
            <div className="ins-cause-text">
              <span className="ins-part">{CAUSE[c.cause].label}</span>
              <span className="ins-what">
                {CAUSE[c.cause].what} · {c.count} {c.count === 1 ? "call" : "calls"}
              </span>
            </div>
            <div className="ins-cause-bar" aria-hidden="true">
              <span style={{ width: `${(c.cost / max) * 100}%` }} />
            </div>
            <b className="num">{money(c.cost)}</b>
          </div>
        ))}
      </div>
      <h4 className="ins-h4">The costliest</h4>
      <ol className="ins-rebuilds">
        {rb.worst.map((r, i) => (
          <RebuildRow key={i} r={r} session={bySession.get(r.key)} titleOf={titleOf} />
        ))}
      </ol>
    </Section>
  );
}

function RebuildRow({ r, session, titleOf }: { r: Rebuild; session: InsightSession | undefined; titleOf: TitleOf }) {
  const title = session ? titleOf(session) : r.key.slice(0, 8);
  return (
    <li className="ins-rebuild">
      <div className="ins-rebuild-who">
        {session?.sessionId ? (
          <a
            href={hrefOf({
              page: "session",
              id: session.sessionId,
              tab: "timeline",
            })}
          >
            {title}
          </a>
        ) : (
          <span>{title}</span>
        )}
        {r.agent ? <span className="ins-agent-type">{r.agent}</span> : null}
      </div>
      <div className="ins-rebuild-why">
        {WHEN_FMT.format(r.at)} · waited {fmtDur(r.gapMs)} · {CAUSE[r.cause].label.toLowerCase()}
        {r.detail ? <span className="mono ins-detail">{r.detail}</span> : null}
      </div>
      <div className="ins-rebuild-cost">
        <b>{money(r.cost)}</b>
        <span className="faint">{fmtTokens(r.tokens)}</span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------- context, agents

function Context({ data, total }: { data: UsageInsights; total: number }) {
  const rows = data.context.filter((c) => c.calls > 0);
  const maxAvg = Math.max(...rows.map((c) => c.cost / c.calls), 0.0001);
  return (
    <Section
      title="Context size"
      hint="Calls by how much context each carried. A call's price grows with everything it re-reads, so the same tool call costs several times more late in a long session."
    >
      <table className="ins-table">
        <thead>
          <tr>
            <th>Context</th>
            <th className="num">Calls</th>
            <th className="num">Spend</th>
            <th>Per call</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.from}>
              <td className="ins-nowrap">{c.to === null ? `${fmtTokens(c.from)}+` : `${fmtTokens(c.from)}–${fmtTokens(c.to)}`}</td>
              <td className="num">{share(c.calls, data.total.calls)}</td>
              <td className="num">{share(c.cost, total)}</td>
              <td>
                <div className="ins-avg">
                  <span className="ins-avg-bar" aria-hidden="true">
                    <span style={{ width: `${(c.cost / c.calls / maxAvg) * 100}%` }} />
                  </span>
                  <span className="num">{money(c.cost / c.calls)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Agents({ data, total }: { data: UsageInsights; total: number }) {
  const a = data.agents!;
  // Named teammates are each a type of their own; fold the singletons.
  const named = a.byType.filter((t) => t.count > 1);
  const rest = a.byType.filter((t) => t.count === 1);
  const rows = [
    ...named,
    ...(rest.length
      ? [
          {
            type: rest.length === 1 ? rest[0]!.type : `${rest.length} named teammates`,
            count: rest.length,
            cost: rest.reduce((x, t) => x + t.cost, 0),
          },
        ]
      : []),
  ].sort((x, y) => y.cost - x.cost);
  return (
    <Section title="Subagents by kind" hint={`${a.count.toLocaleString()} subagents and teammates, ${share(costOf(a.spend), total)} of the spend.`}>
      <table className="ins-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th className="num">How many</th>
            <th className="num">Each</th>
            <th className="num">Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.type}>
              <td>{t.type}</td>
              <td className="num">{t.count}</td>
              <td className="num">{money(t.cost / t.count)}</td>
              <td className="num">{money(t.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Models({ data, total }: { data: UsageInsights; total: number }) {
  return (
    <Section title="Models">
      <table className="ins-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Calls</th>
            <th className="num">Spend</th>
          </tr>
        </thead>
        <tbody>
          {data.models.map((m) => (
            <tr key={m.model}>
              <td className="mono">{m.model}</td>
              <td className="num">{m.calls.toLocaleString()}</td>
              <td className="num">
                {money(m.cost)} <span className="faint">{share(m.cost, total)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
