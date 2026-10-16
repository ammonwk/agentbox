import { useMemo, useRef, useState } from "react";
import type { AccountView, AppState, Session } from "../../../../src/core/types";
import { ago, fmtCost, fmtTokens, guessHome, tildify } from "../../api";
import { AccountChip, ContextBar, UsageBar } from "../../bits";
import { Icon } from "../../components";
import { hrefOf } from "../../route";
import { outstandingOf, sortWindows } from "../../lib/usage";
import { useDismiss, useFloating } from "../newsession/popover";

/** The selected session's facts, shared by Sessions and local Agent chat: a
 *  quiet line under the message box. The context is a percentage, the cache
 *  reads are in the tooltip, and the account chip says the provider, so a
 *  Claude model is "opus-5-5". */
export function SessionFacts({session, state}: {session: Session; state: AppState}) {
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home).concat(state.sessions.map((s) => s.cwd))), [state.accounts, state.sessions]);
  const pr = state.prs.find((p) => p.sessionId === session.id) ?? null;
  // What it runs as and on, and what it has spent.
  return (
    <div className="sx-facts">
      <span className="fact">
        <AccountUsage accountId={session.accountId} accounts={state.accounts} cold={session.cold} />
      </span>
      {/* The sidebar names the project; with a branch, the path is in its tooltip. */}
      {session.branch ? (
        <span className="fact mono" title={session.cwd}>
          <Icon.branch size={12} /> {session.branch}
        </span>
      ) : (
        <span className="fact mono fact-cwd" title={session.cwd}>
          <Icon.folder size={12} />
          <span className="fact-cwd-text">
            <span dir="ltr">{tildify(session.cwd, home)}</span>
          </span>
        </span>
      )}
      {session.model ? (
        <span className="fact mono" title={session.model}>
          {session.model.replace(/^claude-/, "")}
          {session.effort ? <span className="muted"> · {session.effort}</span> : null}
        </span>
      ) : null}
      <span className="fact">
        <ContextBar used={session.contextUsed} limit={session.contextLimit} />
      </span>
      <span
        className="fact"
        title={`input ${session.tokens.input.toLocaleString()} · output ${session.tokens.output.toLocaleString()} · cache read ${session.tokens.cacheRead.toLocaleString()} · cache write ${session.tokens.cacheWrite.toLocaleString()}\nCost is what these tokens would cost at API prices — the common unit usage is apportioned in.\nStarted ${new Date(session.startedAt).toLocaleString()}`}
      >
        {fmtTokens(session.tokens.input + session.tokens.output)} tok ·{" "}
        <span className="muted">≈{fmtCost(session.tokens.costEquiv)}</span>
      </span>
      {pr && (
        <a className="fact" href={pr.url} target="_blank" rel="noreferrer">
          <Icon.prs size={12} /> #{pr.number}
          {pr.isDraft ? " (draft)" : ""}
        </a>
      )}
    </div>
  );
}

/**
 * The session's account, and under a press its usage: each limit window as
 * the Accounts page draws it, the weekly one with what sessions still claim.
 */
function AccountUsage({ accountId, accounts, cold }: { accountId: string | null; accounts: readonly AccountView[]; cold: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [wrap, pop]);
  const style = useFloating(wrap, open, 420, 280);
  const a = accounts.find((x) => x.id === accountId) ?? null;
  const toAccounts = hrefOf({ page: "accounts", sub: "accounts" });
  if (!a) return <AccountChip accountId={accountId} accounts={accounts} cold={cold} onClick={() => (location.hash = toAccounts)} />;
  const now = Date.now();
  const outstanding = outstandingOf(a.claims);
  const windows = sortWindows(a.usage.windows);
  return (
    <span className="sx-usage-wrap" ref={wrap}>
      <AccountChip accountId={accountId} accounts={accounts} cold={cold} onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div className="sx-usage" ref={pop} style={style} role="group" aria-label={`Usage of ${a.label}`} onClick={(e) => e.stopPropagation()}>
          <div className="sx-usage-head">
            <strong>{a.label}</strong>
            {a.plan ? <span className="muted">{a.plan}</span> : null}
          </div>
          {windows.length === 0 ? (
            <div className="faint">{a.usage.source === "none" ? "This provider reports no usage." : "No usage read yet."}</div>
          ) : (
            windows.map((w) => <UsageBar key={w.id} window={w} now={now} outstanding={w.kind === "weekly" && !w.scope ? outstanding : 0} />)
          )}
          {a.usage.stale ? (
            <div className="sx-usage-stale">
              <Icon.alert size={12} /> {a.usage.stale}
            </div>
          ) : null}
          <div className="sx-usage-foot">
            <span className="faint">{a.usage.at ? `as of ${ago(a.usage.at)}` : ""}</span>
            <a href={toAccounts}>All accounts</a>
          </div>
        </div>
      ) : null}
    </span>
  );
}
