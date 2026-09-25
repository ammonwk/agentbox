/** Domain primitives: the small pieces every agentbox screen shares — provider
 *  badges, account chips, status, context and usage bars. Generic controls
 *  live in components.tsx; these know what a session and an account are. */

import { useEffect, useRef, useState } from "react";
import type { AccountView, ProviderId, SessionHost, SessionStatus, UsageWindow } from "../../src/core/types";
import { Icon } from "./components";
import { contextPct } from "./lib/board";
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
  archived: "Archived",
};

const STATUS_TITLE: Record<SessionStatus, string> = {
  blocked: "Showing a prompt it needs answered — a permission, a trust dialog, a login",
  waiting: "The turn is over; the process is alive and waiting for you",
  running: "Mid-turn",
  stopped: "No process — the conversation can be resumed on the same account",
  archived: "Put away; still resumable",
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`pill pill-${status}`} title={STATUS_TITLE[status]}>
      <span className="pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Status as a dot, for lists already sectioned by status: the heading says
 *  "Your turn" once, the rows need not say it eighteen times. */
export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`st-dot st-${status}`} title={`${STATUS_LABEL[status]} — ${STATUS_TITLE[status]}`} role="img" aria-label={STATUS_LABEL[status]} />;
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
      <span className="ctx-num">{Math.round(p)}%</span>
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
  compact,
}: {
  window: UsageWindow;
  outstanding?: number;
  now: number;
  compact?: boolean;
}) {
  const used = usedNow(w, now);
  const seg = barSegments(used, outstanding);
  const tone = usageTone(outstanding > 0 ? seg.effective : used);
  const elapsed = windowElapsed(w, now);
  const label = windowLabel(w);
  const claimText = outstanding > 0 ? ` + ${Math.round(outstanding * 10) / 10} claimed = ${Math.round(seg.effective)}` : "";
  return (
    <div className={`ubar ubar-${w.kind}${w.scope ? " ubar-scoped" : ""}${compact ? " ubar-compact" : ""}`} data-tone={tone}>
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
        void navigator.clipboard?.writeText(text).then(
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
