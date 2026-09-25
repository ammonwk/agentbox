import { useEffect, useRef, useState } from "react";
import type { AccountView, Candidate, Placement } from "../../../../src/core/types";
import { accountHue } from "../../bits";
import { Icon, Spinner } from "../../components";
import { fmtPts } from "../../lib/format";
import { headlineWindows, usageTone } from "../../lib/usage";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

/**
 * Which subscription the session goes on. The closed control always names
 * the account it will actually land on — for Auto, the balancer's current
 * pick — and the open list is the placement preview: every account with its
 * 5-hour and weekly use, the room the balancer ranks by, and why an account
 * is out.
 */
export function AccountPicker({
  accounts,
  allAccounts,
  value,
  onChange,
  placement,
  placing,
  placeErr,
  claimIdleMin,
}: {
  /** This provider's accounts. */
  accounts: AccountView[];
  /** Every account, for stable colours. */
  allAccounts: AccountView[];
  value: string;
  onChange: (accountId: string) => void;
  placement: Placement | null;
  placing: boolean;
  placeErr: string | null;
  claimIdleMin: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const style = useFloating(btnRef, open, 440);
  useDismiss(open, () => setOpen(false), [btnRef, listRef]);

  const cand = (id: string): Candidate | null => placement?.candidates.find((c) => c.accountId === id) ?? null;
  // Auto first, then the balancer's order: its pick, eligible by score, the rest.
  const ordered = [...accounts].sort((a, b) => {
    const ca = cand(a.id);
    const cb = cand(b.id);
    return (
      Number(b.id === placement?.accountId) - Number(a.id === placement?.accountId) ||
      Number(!!cb?.eligible) - Number(!!ca?.eligible) ||
      (cb?.score ?? -Infinity) - (ca?.score ?? -Infinity)
    );
  });
  const options = ["auto", ...ordered.map((a) => a.id)];

  useEffect(() => {
    if (open) setActive(Math.max(0, options.indexOf(value)));
    // Only on opening: arrows own `active` while the list is up.
  }, [open]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);

  const manual = value !== "auto" ? accounts.find((a) => a.id === value) ?? null : null;
  const autoPick = placement?.accountId ? accounts.find((a) => a.id === placement.accountId) ?? null : null;
  const none = !manual && placement?.mode === "none";
  const shown = manual ?? autoPick;
  /** A pin runs regardless, but say so when the balancer would have refused it. */
  const pinned = manual ? cand(manual.id) : null;
  const pinnedOut = pinned && !pinned.eligible ? pinned : null;

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active]!);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const listId = "ns-acct-list";
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`ns-acct-btn${none ? " none" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `ns-acct-${active}` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={`ns-acct-mode${manual ? " manual" : ""}`}>{manual ? "Pinned" : "Auto"}</span>
        {none ? (
          <span className="ns-acct-none">No account can take it</span>
        ) : shown ? (
          <AccountLine account={shown} all={allAccounts} candidate={cand(shown.id)} />
        ) : placeErr ? (
          <span className="faint">Placement unavailable</span>
        ) : accounts.length === 0 ? (
          <span className="faint">No account set up</span>
        ) : (
          <span className="faint">Asking the balancer…</span>
        )}
        {placing ? <Spinner size={12} /> : null}
        <Icon.chevronDown size={14} />
      </button>
      {manual && (pinnedOut || (autoPick && autoPick.id !== manual.id)) ? (
        <span className={`ns-acct-note${pinnedOut ? " warn" : ""}`}>
          {pinnedOut ? `${pinnedOut.reason ?? "Auto would not place a session here"}. ` : ""}
          {autoPick && autoPick.id !== manual.id ? `Auto would pick ${autoPick.label}.` : ""}
        </span>
      ) : null}

      {open ? (
        <div ref={listRef} id={listId} role="listbox" aria-label="Account" className="ns-pop ns-acct-pop" style={style}>
          <div
            id="ns-acct-0"
            data-index={0}
            role="option"
            aria-selected={value === "auto"}
            className="ns-acct-opt ns-acct-auto"
            data-active={active === 0 || undefined}
            onMouseEnter={() => setActive(0)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick("auto")}
          >
            <span className="ns-radio" aria-hidden="true" />
            <div className="ns-acct-body">
              <div className="ns-acct-title">
                <strong>Auto</strong>
                <span className="faint">— the balancer picks{autoPick ? `: ${autoPick.label}` : ""}</span>
              </div>
              {placeErr ? (
                <p className="error-line">Could not preview placement: {placeErr}</p>
              ) : placement ? (
                <p className="ns-acct-why">
                  {placement.why}
                  {/[.!?]$/.test(placement.why) ? " " : ". "}
                  Claims <strong>{placement.claim}</strong> weekly points until used or idle {claimIdleMin} min.
                </p>
              ) : null}
            </div>
          </div>
          {ordered.map((a, i) => {
            const c = cand(a.id);
            return (
              <div
                key={a.id}
                id={`ns-acct-${i + 1}`}
                data-index={i + 1}
                role="option"
                aria-selected={value === a.id}
                className="ns-acct-opt"
                data-active={active === i + 1 || undefined}
                data-ineligible={(c && !c.eligible) || undefined}
                onMouseEnter={() => setActive(i + 1)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(a.id)}
              >
                <span className="ns-radio" aria-hidden="true" />
                <div className="ns-acct-body">
                  <div className="ns-acct-title">
                    <AccountLine account={a} all={allAccounts} candidate={c} />
                    {a.id === placement?.accountId ? <span className="ns-tag">auto&apos;s pick</span> : null}
                  </div>
                  {c && !c.eligible ? <p className="ns-acct-reason">{c.reason ?? "not eligible"}</p> : null}
                  {!a.enabled ? <p className="ns-acct-reason">Off for auto-placement; a pin still runs there.</p> : null}
                </div>
                {c?.eligible && c.legRoom != null ? (
                  <span className="ns-acct-room" title="5-hour room after claims — what the balancer ranks by">
                    {fmtPts(c.legRoom)}
                    <small>room</small>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/** Dot, label, plan, and the two bars that decide placement. */
function AccountLine({ account: a, all, candidate: c }: { account: AccountView; all: AccountView[]; candidate: Candidate | null }) {
  const hue = accountHue(a.id, all);
  const { short, weekly } = headlineWindows(a.usage);
  const auth = a.auth.state !== "ok" ? a.auth.state : null;
  return (
    <span className="ns-acct-line" style={{ ["--acct" as string]: `var(--acct-${hue})` }}>
      <span className="acct-dot" aria-hidden="true" />
      <span className="ns-acct-label">{a.label}</span>
      {a.plan ? <span className="ns-acct-plan">{a.plan}</span> : null}
      {auth ? <span className="ns-tag ns-tag-warn">{auth}</span> : null}
      <MiniBar label="5h" used={c?.short ?? short?.usedPct ?? null} effective={c?.shortEffective ?? null} />
      <MiniBar label="wk" used={c?.weekly ?? weekly?.usedPct ?? null} effective={c?.weeklyEffective ?? null} />
    </span>
  );
}

/** Use, with outstanding claims hatched on top. */
function MiniBar({ label, used, effective }: { label: string; used: number | null; effective: number | null }) {
  if (used == null) return null;
  const eff = effective ?? used;
  const u = Math.min(100, Math.max(0, used));
  const claimed = Math.max(0, Math.min(100, eff) - u);
  return (
    <span className="ns-mbar" data-tone={usageTone(eff)} title={`${label}: ${Math.round(used)}% used${eff > used ? `, ${Math.round(eff)}% with claims` : ""}`}>
      <span className="ns-mbar-label">{label}</span>
      <span className="ns-mbar-track" aria-hidden="true">
        <i style={{ width: `${u}%` }} />
        {claimed > 0 ? <b style={{ left: `${u}%`, width: `${claimed}%` }} /> : null}
      </span>
      <span className="ns-mbar-pct">{Math.round(used)}%</span>
    </span>
  );
}
