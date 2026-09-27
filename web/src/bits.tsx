/** Domain primitives: the small pieces every agentbox screen shares — provider
 *  badges, account chips, status, context and usage bars. Generic controls
 *  live in components.tsx; these know what a session and an account are. */

import { useEffect, useRef, useState } from "react";
import type { AccountView, ProviderId, SessionHost, SessionStatus, UsageWindow } from "../../src/core/types";
import { Icon } from "./components";
import { contextPct, type Shape } from "./lib/board";
import { fmtTokens } from "./lib/format";
import { barSegments, resetText, usageTone, usedNow, windowElapsed, windowLabel } from "./lib/usage";

// --------------------------------------------------------------- provider

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  devin: "Devin",
  omp: "omp",
};

export const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "devin", "omp"];

/** A text badge in the provider's colour. No logos: no external assets, and
 *  the word is more legible at 11px than any mark. */
export function ProviderBadge({ provider, short }: { provider: ProviderId; short?: boolean }) {
  return (
    <span className={`prov prov-${provider}`} title={PROVIDER_LABEL[provider]}>
      {short ? PROVIDER_LABEL[provider].slice(0, 2) : PROVIDER_LABEL[provider]}
    </span>
  );
}

// ---------------------------------------------------------------- account

const ACCOUNT_HUES = 8;

/**
 * A stable colour slot per account: its position among all accounts by age,
 * so adding one never recolours the others. Unknown ids hash.
 */
export function accountHue(accountId: string | null, accounts: readonly Pick<AccountView, "id" | "createdAt">[]): number {
  if (!accountId) return -1;
  const ordered = [...accounts].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const i = ordered.findIndex((a) => a.id === accountId);
  if (i >= 0) return i % ACCOUNT_HUES;
  let h = 0;
  for (const ch of accountId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % ACCOUNT_HUES;
}

export function AccountChip({
  accountId,
  accounts,
  detail,
  onClick,
  plain,
  cold,
}: {
  accountId: string | null;
  accounts: readonly AccountView[];
  /** Idle past the claim window: no longer pinned. Shown as a hollow ring
   *  and "any account", with where it last ran in the tooltip. */
  cold?: boolean;
  /** Extra text after the label, e.g. a usage summary. */
  detail?: string;
  onClick?: () => void;
  /** Dot and text only — for a column of them, where pills become a wall. */
  plain?: boolean;
}) {
  const a = accounts.find((x) => x.id === accountId) ?? null;
  const hue = accountHue(accountId, accounts);
  const label = a?.label ?? (accountId ? accountId : "no account");
  const title = a
    ? `${a.label}${a.email ? ` · ${a.email}` : ""}${a.plan ? ` · ${a.plan}` : ""}${a.enabled ? "" : " · disabled"}`
    : accountId
      ? `Account ${accountId} (not found — forgotten?)`
      : "Not pinned to an account";
  if (cold && a) {
    const coldTitle = `Unpinned: idle long enough that its prompt cache is cold, so it wakes on whichever ${a.provider} account has room. Last ran on ${a.label}.`;
    const coldInner = (
      <>
        <span className="acct-dot" aria-hidden="true" />
        <span className="acct-label">any account</span>
      </>
    );
    const coldCls = `acct acct-cold${plain ? " acct-plain" : ""}`;
    const coldStyle = { ["--acct" as string]: `var(--acct-${hue})` };
    return onClick ? (
      <button type="button" className={coldCls} style={coldStyle} title={coldTitle} onClick={onClick}>
        {coldInner}
      </button>
    ) : (
      <span className={coldCls} style={coldStyle} title={coldTitle}>
        {coldInner}
      </span>
    );
  }
  const inner = (
    <>
      <span className="acct-dot" aria-hidden="true" />
      <span className="acct-label">{label}</span>
      {detail ? <span className="acct-detail">{detail}</span> : null}
    </>
  );
  const cls = `acct${hue < 0 ? " acct-none" : ""}${a && !a.enabled ? " acct-off" : ""}${plain ? " acct-plain" : ""}`;
  const style = hue >= 0 ? { ["--acct" as string]: `var(--acct-${hue})` } : undefined;
  return onClick ? (
    <button type="button" className={cls} style={style} title={title} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span className={cls} style={style} title={title}>
      {inner}
    </span>
  );
}

// ----------------------------------------------------------------- status

const STATUS_LABEL: Record<SessionStatus, string> = {
  blocked: "Blocked",
  waiting: "Your turn",
  running: "Running",
  stopped: "Stopped",
  closed: "Closed",
};

const STATUS_TITLE: Record<SessionStatus, string> = {
  blocked: "Showing a prompt it needs answered — a permission, a trust dialog, a login",
  waiting: "The turn is over; the process is alive and waiting for you",
  running: "Mid-turn",
  stopped: "No process — the conversation can be resumed on the same account",
  closed: "Stopped and off the list; still resumable",
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`pill pill-${status}`} title={STATUS_TITLE[status]}>
      <span className="pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const SHAPE_PATH: Record<Shape, string> = {
  circle: "M5 1a4 4 0 1 1 0 8 4 4 0 0 1 0-8z",
  square: "M2.3 1.3h5.4a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H2.3a1 1 0 0 1-1-1V2.3a1 1 0 0 1 1-1z",
  triangle: "M5 .8 9.5 9H.5z",
  diamond: "M5 .3 9.7 5 5 9.7.3 5z",
  star: "M5 .5 6.2 3.7 9.7 3.9 7 6 7.9 9.4 5 7.5 2.1 9.4 3 6 .3 3.9 3.8 3.7z",
  down: "M5 9.2 9.5 1H.5z",
  cross: "M3.6.8h2.8v2.8h2.8v2.8H6.4v2.8H3.6V6.4H.8V3.6h2.8z",
};

/** A repo's shape on its own, for a heading. */
export function ShapeMark({ shape }: { shape: Shape }) {
  return (
    <svg className="st-shape" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d={SHAPE_PATH[shape]} />
    </svg>
  );
}

/** Status as a dot: its colour is the status, and given a `shape`, its shape
 *  is the repo — a list sorted by time still says both at a glance. */
export function StatusDot({ status, shape, repo }: { status: SessionStatus; shape?: Shape; repo?: string }) {
  const title = `${STATUS_LABEL[status]} — ${STATUS_TITLE[status]}${repo ? `\nIn ${repo}` : ""}`;
  if (!shape) return <span className={`st-dot st-${status}`} title={title} role="img" aria-label={STATUS_LABEL[status]} />;
  return (
    <svg className={`st-shape st-${status}`} viewBox="0 0 10 10" width="10" height="10" role="img" aria-label={STATUS_LABEL[status]}>
      <title>{title}</title>
      <path d={SHAPE_PATH[shape]} />
    </svg>
  );
}

const HOST_LABEL: Record<SessionHost, string> = { tmux: "tmux", external: "external", none: "no process" };
const HOST_TITLE: Record<SessionHost, string> = {
  tmux: "In agentbox's tmux — attach from a terminal or type here",
  external: "Running in a terminal agentbox did not start — read-only until adopted",
  none: "No live process",
};

export function HostBadge({ host }: { host: SessionHost }) {
  return (
    <span className={`host host-${host}`} title={HOST_TITLE[host]}>
      {host === "tmux" ? <Icon.terminal size={12} /> : host === "external" ? <Icon.external size={12} /> : null}
      {HOST_LABEL[host]}
    </span>
  );
}

export function BigBadge() {
  return (
    <span className="big-badge" title="Big session: claims the larger share of the account's weekly">
      <Icon.bolt size={11} />
      Big
    </span>
  );
}

// ---------------------------------------------------------------- context

/** Context-window fill: amber past 75%, red past 90% — when compaction bites. */
export function ContextBar({
  used,
  limit,
  wide,
}: {
  used: number | null;
  limit: number | null;
  wide?: boolean;
}) {
  const p = contextPct({ contextUsed: used, contextLimit: limit });
  if (p == null) return <span className="ctx ctx-none faint">—</span>;
  const tone = usageTone(p);
  return (
    <span
      className={`ctx${wide ? " ctx-wide" : ""}`}
      data-tone={tone}
      title={`Context: ${fmtTokens(used)} of ${fmtTokens(limit)} tokens (${Math.round(p)}%)`}
    >
      <span className="ctx-track" aria-hidden="true">
        <i style={{ width: `${p}%` }} />
      </span>
      {/* The session header has room to say what the bar is and how many
          tokens that is — which is also what a cold start re-sends. */}
      <span className="ctx-num">{wide ? `${fmtTokens(used)} of ${fmtTokens(limit)} context` : `${Math.round(p)}%`}</span>
    </span>
  );
}

// ------------------------------------------------------------------ usage

/**
 * One rate-limit window as a bar. The weekly bar can carry the account's
 * outstanding claims as a hatched segment on top of real use, which is the
 * picture the balancer actually gates on. A small tick marks how far through
 * the window we are, so "60% used, 90% of the way through" reads as fine.
 */
export function UsageBar({
  window: w,
  outstanding = 0,
  now,
}: {
  window: UsageWindow;
  outstanding?: number;
  now: number;
}) {
  const used = usedNow(w, now);
  const seg = barSegments(used, outstanding);
  const tone = usageTone(outstanding > 0 ? seg.effective : used);
  const elapsed = windowElapsed(w, now);
  const label = windowLabel(w);
  const claimText = outstanding > 0 ? ` + ${Math.round(outstanding * 10) / 10} claimed = ${Math.round(seg.effective)}` : "";
  return (
    <div className={`ubar ubar-${w.kind}${w.scope ? " ubar-scoped" : ""}`} data-tone={tone}>
      <div className="ubar-head">
        <span className="ubar-label">{label}</span>
        <span className="ubar-pct">
          {Math.round(used)}%
          {outstanding > 0 ? <span className="ubar-claim"> +{Math.round(outstanding * 10) / 10}</span> : null}
        </span>
        <span className="ubar-reset">{resetText(w.resetsAt, now)}</span>
      </div>
      <div
        className="ubar-track"
        role="meter"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={`${Math.round(used)}% used${claimText}, ${resetText(w.resetsAt, now)}`}
        title={`${Math.round(used)}% used${claimText}${seg.overCommitted ? " — over-committed" : ""}\n${resetText(w.resetsAt, now)}`}
      >
        <i className="ubar-used" style={{ width: `${seg.used}%` }} />
        {seg.claimed > 0 ? <i className="ubar-claimed" style={{ left: `${seg.used}%`, width: `${seg.claimed}%` }} /> : null}
        {elapsed != null ? <b className="ubar-tick" style={{ left: `${elapsed * 100}%` }} /> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- copy

/** Copies, and says so for a moment. Falls back to selecting when the
 *  clipboard API is refused (plain http on a non-loopback host). */
/** `navigator.clipboard` exists only in a secure context, and a phone on the
 *  tailnet reaches us over plain http; the old selection copy still works there. */
function copyText(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error("copy refused"));
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (t.current) clearTimeout(t.current);
  }, []);
  return (
    <button
      type="button"
      className={`copy-btn${done ? " done" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label ? undefined : `Copy ${text}`}
      title={`Copy: ${text}`}
      onClick={() => {
        void copyText(text).then(
          () => {
            setDone(true);
            if (t.current) clearTimeout(t.current);
            t.current = setTimeout(() => setDone(false), 1400);
          },
          () => window.prompt("Copy this:", text),
        );
      }}
    >
      {done ? <Icon.check size={13} /> : <Icon.copy size={13} />}
      {label ? <span>{done ? "Copied" : label}</span> : null}
    </button>
  );
}
