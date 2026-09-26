import { useMemo, useState } from "react";
import type { AccountView, AppState, LoginFlow, ProviderId } from "../../../src/core/types";
import { api, useNow } from "../api";
import { accountHue, BigBadge, CopyButton, PROVIDER_LABEL, PROVIDERS, ProviderBadge, UsageBar } from "../bits";
import { Button, Confirm, Empty, Field, Icon, Modal, RelativeTime, Spinner, Toggle } from "../components";
import { fmtCountdown, fmtPts, guessHome, tildify } from "../lib/format";
import { outstandingOf, sortWindows } from "../lib/usage";
import { hrefOf } from "../route";
import { Calibration } from "./Calibration";
import { useAction } from "./session/useAction";
import "./accounts.css";

/**
 * Every login agentbox can place sessions on, grouped by provider: how much of
 * each rate-limit window is used, what the running sessions still claim, and
 * how the balancer currently sees it.
 */
export function Accounts({ state, sub }: { state: AppState; sub: "accounts" | "calibration" }) {
  if (sub === "calibration") return <Calibration settings={state.settings} />;
  return <AccountList state={state} />;
}

function AccountList({ state }: { state: AppState }) {
  const [adding, setAdding] = useState<{ provider: ProviderId; expect?: string } | null>(null);
  const [importing, setImporting] = useState<ProviderId | null>(null);
  /** Logins this tab started, until the cold state carries them. */
  const [started, setStarted] = useState<LoginFlow[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home)), [state.accounts]);

  const logins = useMemo(() => {
    const byId = new Map<string, LoginFlow>();
    for (const l of started) byId.set(l.id, l);
    for (const l of state.logins) byId.set(l.id, l); // the server's copy wins
    return [...byId.values()].filter((l) => !dismissed.has(l.id));
  }, [started, state.logins, dismissed]);

  const providers = PROVIDERS.filter(
    (p) => state.providers.some((x) => x.id === p && x.installed) || state.accounts.some((a) => a.provider === p),
  );

  const dismiss = (id: string) => setDismissed((d) => new Set(d).add(id));

  return (
    <div className="acs">
      <p className="hint acs-lede">
        New sessions go to the account with the most room, counting what running sessions still <em>claim</em> — the hatched part of
        each weekly bar. The tick on a bar marks how far through its window we are.{" "}
        <a href={hrefOf({ page: "accounts", sub: "calibration" })}>Calibration</a> checks those claims against what sessions really use.
      </p>

      {providers.map((p) => {
        const all = state.accounts.filter((a) => a.provider === p);
        // Your CLI's login on the same email as an account is that account
        // seen through ~/.claude (one usage pool; see `twinOf`), so it folds
        // into that account's card instead of repeating it. It gets a card
        // of its own again the moment the CLI is logged in as anyone else.
        const cliOf = (a: AccountView) => all.find((x) => x.isDefault && x.twinOf?.id === a.id) ?? null;
        const accounts = all.filter((a) => !(a.isDefault && a.twinOf && all.some((x) => x.id === a.twinOf!.id)));
        // A login whose account is not listed: one just created (not in the
        // state yet), or a failure worth reading. A finished one whose
        // account was forgotten says nothing true any more.
        const orphanLogins = logins.filter(
          (l) => l.provider === p && l.state !== "done" && !accounts.some((a) => a.id === l.accountId),
        );
        const info = state.providers.find((x) => x.id === p);
        return (
          <section key={p} className="acs-sec" aria-labelledby={`acs-${p}`}>
            <header className="acs-sec-head">
              <ProviderBadge provider={p} />
              <h2 id={`acs-${p}`}>{PROVIDER_LABEL[p]}</h2>
              <span className="faint">
                {accounts.length} account{accounts.length === 1 ? "" : "s"}
                {info?.version ? ` · ${info.version}` : info && !info.installed ? " · CLI not installed" : ""}
              </span>
              <span className="acs-sec-actions">
                {p === "omp" ? (
                  <span className="hint">omp balances its own credential pool.</span>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" icon={Icon.folder} onClick={() => setImporting(p)}>
                      Import existing home
                    </Button>
                    <Button size="sm" icon={Icon.plus} disabled={!info?.installed} onClick={() => setAdding({ provider: p })}>
                      Add account
                    </Button>
                  </>
                )}
              </span>
            </header>

            {orphanLogins.map((l) => (
              <LoginPanel key={l.id} login={l} onDismiss={() => dismiss(l.id)} />
            ))}

            {accounts.length === 0 ? (
              <div className="acs-empty">
                No {PROVIDER_LABEL[p]} account yet. <strong>Add account</strong> logs a new one in from here; <strong>Import</strong> uses a
                credential home you already have.
              </div>
            ) : (
              <div className="acs-grid">
                {accounts.map((a) => (
                  <AccountCard
                    key={a.id}
                    account={a}
                    cli={cliOf(a)}
                    state={state}
                    home={home}
                    login={logins.find((l) => l.accountId === a.id || l.accountId === cliOf(a)?.id) ?? null}
                    onLogin={(l) => setStarted((s) => [...s.filter((x) => x.accountId !== l.accountId), l])}
                    onDismissLogin={dismiss}
                    onAddOwn={() => setAdding({ provider: p, expect: a.email ?? undefined })}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {providers.length === 0 ? (
        <Empty title="No provider CLI found">
          Install <code>claude</code>, <code>codex</code>, <code>devin</code> or <code>omp</code> and this page lists its accounts.
        </Empty>
      ) : null}

      {adding ? (
        <AddAccount
          provider={adding.provider}
          expect={adding.expect}
          onClose={() => setAdding(null)}
          onStarted={(l) => {
            setStarted((s) => [...s, l]);
            setAdding(null);
          }}
        />
      ) : null}
      {importing ? <ImportHome provider={importing} onClose={() => setImporting(null)} /> : null}
    </div>
  );
}

// -------------------------------------------------------------------- card

function AccountCard({
  account: a,
  cli,
  state,
  home,
  login,
  onLogin,
  onDismissLogin,
  onAddOwn,
}: {
  account: AccountView;
  /** Your CLI's login, when it is logged in as this account (folded in here). */
  cli: AccountView | null;
  state: AppState;
  home: string | null;
  login: LoginFlow | null;
  onLogin: (l: LoginFlow) => void;
  onDismissLogin: (id: string) => void;
  onAddOwn: () => void;
}) {
  const { run, busy, error, clear } = useAction();
  const refresh = useAction();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(a.label);
  const [forget, setForget] = useState(false);
  const now = useNow(30_000);
  // Sessions started from the CLI claim against this account's pool.
  const claims = cli ? [...a.claims, ...cli.claims] : a.claims;
  const outstanding = outstandingOf(claims);
  const windows = sortWindows(a.usage.windows);
  const hue = accountHue(a.id, state.accounts);
  const c = a.placement;

  const saveLabel = async () => {
    const next = label.trim();
    if (!next || next === a.label) {
      setLabel(a.label);
      setEditing(false);
      return;
    }
    if (await run(() => api.patchAccount(a.id, { label: next }))) setEditing(false);
  };

  return (
    <article className="ac card" data-enabled={a.enabled} style={{ ["--acct" as string]: `var(--acct-${hue})` }} aria-label={`${a.label} account`}>
      <header className="ac-head">
        <span className="ac-swatch" aria-hidden="true" />
        {editing ? (
          <input
            className="ac-label-input"
            aria-label="Account label"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => void saveLabel()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveLabel();
              if (e.key === "Escape") {
                e.stopPropagation();
                setLabel(a.label);
                setEditing(false);
              }
            }}
          />
        ) : (
          <h3 className="ac-label">
            <button className="ac-label-btn" title="Rename" onClick={() => setEditing(true)}>
              {a.label}
              <Icon.edit size={12} className="ac-pen" />
            </button>
          </h3>
        )}
        {a.isDefault && a.provider !== "omp" ? (
          <span className="src ac-default" title={`Your plain ${a.provider} CLI's own login. Logging the CLI in or out changes this card only.`}>
            CLI login
          </span>
        ) : null}
        <span className="ac-toggle">
          <Toggle
            checked={a.enabled}
            label={a.enabled ? "In rotation" : "Out of rotation"}
            disabled={busy}
            onChange={(v) => void run(() => api.patchAccount(a.id, { enabled: v }))}
          />
        </span>
      </header>

      <div className="ac-sub">
        <span>{a.email ?? <span className="faint">no email yet</span>}</span>
        {a.plan ? <span className="ac-plan">{a.plan}</span> : null}
        <AuthBadge account={a} now={now} />
      </div>
      <div className="ac-home mono" title={a.home}>
        {tildify(a.home, home)}
      </div>
      {cli ? (
        <p className="ac-cli-too">
          Your <code>{a.provider}</code> CLI (<span className="mono">{tildify(cli.home, home)}</span>) is logged in as this account too:
          sessions started from it count here.
        </p>
      ) : null}

      {a.auth.detail && a.auth.state !== "ok" ? <p className="ac-auth-detail">{a.auth.detail}</p> : null}
      {a.twinOf && a.isDefault ? (
        <p className="ac-auth-detail">
          Your CLI is logged in as <strong>{a.twinOf.label}</strong>, which agentbox runs as its own account: new sessions go there, and
          sessions started from the CLI count against it.
        </p>
      ) : a.twinOf ? (
        <p className="ac-twin">
          <Icon.alert size={12} />
          <span>
            Same login as <strong>{a.twinOf.label}</strong>, so it is one usage pool: new sessions go there, and
            sessions here claim against it. Log this home into a different account, or forget it.
          </span>
        </p>
      ) : a.isDefault && a.email ? (
        <div className="ac-cli-only">
          <p className="ac-cli-only-head">
            <Icon.alert size={12} /> agentbox is borrowing your CLI's login
          </p>
          <p>
            {a.email} is only logged in here, in your <code>{a.provider}</code> CLI. Log the CLI into another account and agentbox loses
            this one.
          </p>
          <p>
            To keep it, sign your browser into <strong>{a.email}</strong>, then:
          </p>
          <Button size="sm" icon={Icon.plus} onClick={onAddOwn}>
            Give agentbox its own login
          </Button>
        </div>
      ) : null}

      <div className="ac-windows">
        {windows.length === 0 ? (
          <p className="hint">
            {a.auth.state === "missing"
              ? "No usage until it is logged in."
              : a.usage.source === "none"
                ? "This provider publishes no usage windows we can read."
                : "No usage reading yet."}
          </p>
        ) : (
          windows.map((w) => (
            <UsageBar key={w.id} window={w} now={now} outstanding={w.kind === "weekly" && !w.scope ? outstanding : 0} />
          ))
        )}
      </div>

      <div className="ac-usage-foot">
        {a.usage.stale ? (
          <span className="ac-stale" title="The numbers above are the last good reading">
            <Icon.alert size={12} /> {a.usage.stale}
          </span>
        ) : null}
        <span className="faint">
          {a.usage.at ? (
            <>
              via {a.usage.source} · <RelativeTime ts={a.usage.at} />
            </>
          ) : (
            `source: ${a.usage.source}`
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={Icon.refresh}
          loading={refresh.busy}
          onClick={() => void refresh.run(() => api.refreshUsage(a.id))}
          aria-label={`Refresh usage for ${a.label}`}
        />
      </div>
      {refresh.error ? <p className="error-line">Refresh failed: {refresh.error}</p> : null}
      {a.usage.notes.length > 0 ? (
        <ul className="ac-notes">
          {a.usage.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      {claims.length > 0 ? (
        <div className="ac-claims">
          <div className="ac-claims-head">
            <span>Claims</span>
            <span className="faint">
              {claims.filter((x) => !x.lapsed).length} active · {fmtPts(outstanding)} pts outstanding
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th className="num" title="Weekly points claimed at placement">Claim</th>
                <th className="num" title="Weekly points attributed to it so far">Used</th>
                <th className="num" title="Still held against this account">Held</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((cl) => (
                <tr key={cl.sessionId} data-lapsed={cl.lapsed || undefined}>
                  <td>
                    <a href={hrefOf({ page: "session", id: cl.sessionId, tab: "terminal" })} className="ac-claim-title">
                      {cl.title}
                    </a>
                    {cl.big ? <BigBadge /> : null}
                    {cl.lapsed ? <span className="ac-lapsed" title="Idle long enough that its claim no longer counts">lapsed</span> : null}
                  </td>
                  <td className="num">{fmtPts(cl.claim)}</td>
                  <td className="num">{fmtPts(cl.consumed)}</td>
                  <td className="num">{fmtPts(cl.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {c ? (
        <div className={`ac-place${c.eligible ? "" : " no"}`}>
          <Icon.gauge size={13} />
          {c.eligible ? (
            <span>
              Balancer: <strong>eligible</strong>
              {c.legRoom != null ? <> · room {fmtPts(c.legRoom)}</> : null}
              {c.weeklyPerHour != null ? <> · {c.weeklyPerHour.toFixed(2)} wk/h left</> : null}
              {c.legRoom != null ? <> · score {c.score.toFixed(1)}</> : null}
            </span>
          ) : (
            <span>
              Balancer: <strong>not eligible</strong> — {c.reason ?? "no reason given"}
            </span>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="error-line" role="alert">
          {error}{" "}
          <button className="linkish" onClick={clear}>
            dismiss
          </button>
        </p>
      ) : null}

      {login ? <LoginPanel login={login} onDismiss={() => onDismissLogin(login.id)} /> : null}

      <footer className="ac-foot">
        <Button
          size="sm"
          variant="ghost"
          icon={Icon.key}
          disabled={busy || (login != null && login.state !== "done" && login.state !== "failed")}
          onClick={() =>
            void run(async () => {
              onLogin(await api.login(a.id));
            })
          }
        >
          Log in again
        </Button>
        {/* The CLI's own home cannot be forgotten: it is re-registered at the
            next start, and sessions started from the CLI live in it. */}
        {a.isDefault ? null : (
          <Button size="sm" variant="ghost" icon={Icon.trash} className="ac-forget" disabled={busy} onClick={() => setForget(true)}>
            Forget
          </Button>
        )}
      </footer>

      {forget ? (
        <Confirm
          title={`Forget “${a.label}”?`}
          danger
          confirmLabel="Forget"
          body={
            <>
              <p>
                agentbox stops listing and placing sessions on this account. The credential home stays on disk untouched —{" "}
                <span className="mono">{a.home}</span> — and can be imported again.
              </p>
              {a.claims.length > 0 ? <p>{a.claims.length} session(s) pinned here keep running where they are.</p> : null}
            </>
          }
          onCancel={() => setForget(false)}
          onConfirm={() => {
            setForget(false);
            void run(() => api.forgetAccount(a.id));
          }}
        />
      ) : null}
    </article>
  );
}

function AuthBadge({ account: a, now }: { account: AccountView; now: number }) {
  const s = a.auth.state;
  const label =
    s === "ok"
      ? a.auth.expiresAt && a.auth.expiresAt > now
        ? `signed in · token ${fmtCountdown(a.auth.expiresAt - now)}`
        : "signed in"
      : s === "expired"
        ? "token expired"
        : s === "missing"
          ? "not logged in"
          : "auth unknown";
  return (
    <span className={`ac-auth auth-${s}`} title={a.auth.detail ?? label}>
      <span className="ac-auth-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

// ------------------------------------------------------------------- login

const LOGIN_STATE: Record<LoginFlow["state"], string> = {
  starting: "Starting the CLI…",
  "awaiting-user": "Waiting for you",
  verifying: "Checking…",
  done: "Logged in",
  failed: "Login failed",
};

/**
 * One login in progress. The CLI runs server-side in a PTY; this shows what it
 * asked for — a URL to open, a device code to type (Codex), or a box to paste
 * the code the browser hands back (Claude, Devin).
 */
export function LoginPanel({ login: l, onDismiss }: { login: LoginFlow; onDismiss: () => void }) {
  const [paste, setPaste] = useState("");
  const { run, busy, error } = useAction();
  const over = l.state === "done" || l.state === "failed";

  return (
    <div className="lg" data-state={l.state} role="region" aria-label={`${PROVIDER_LABEL[l.provider]} login`}>
      <div className="lg-head">
        {l.state === "starting" || l.state === "verifying" ? <Spinner size={13} /> : l.state === "done" ? <Icon.check size={14} /> : l.state === "failed" ? <Icon.alert size={14} /> : <Icon.key size={14} />}
        <strong>{LOGIN_STATE[l.state]}</strong>
        <span className="lg-head-actions">
          {over ? (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Close
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={Icon.x} disabled={busy} onClick={() => void run(() => api.loginCancel(l.id))}>
              Cancel
            </Button>
          )}
        </span>
      </div>

      <span className="lg-meta faint">
        {PROVIDER_LABEL[l.provider]} login · started <RelativeTime ts={l.startedAt} />
      </span>

      {l.state === "awaiting-user" && l.url ? (
        <ol className="lg-steps">
          <li>
            <span className="lg-step-label">Open this and sign in to the account you want here:</span>
            <span className="lg-url-row">
              <a className="lg-url" href={l.url} target="_blank" rel="noreferrer">
                <Icon.external size={14} />
                <span>{l.url}</span>
              </a>
              <CopyButton text={l.url} label="Copy" />
            </span>
          </li>
          {l.userCode ? (
            <li>
              <span className="lg-step-label">Enter this one-time code on that page:</span>
              <span className="lg-code-row">
                <code className="lg-code">{l.userCode}</code>
                <CopyButton text={l.userCode} label="Copy code" />
              </span>
            </li>
          ) : null}
          {l.needsPaste ? (
            <li>
              <span className="lg-step-label">Paste the code the browser gives you back:</span>
              <form
                className="lg-paste"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (paste.trim()) void run(() => api.loginPaste(l.id, paste.trim()));
                }}
              >
                <input
                  className="mono"
                  aria-label="Code from the browser"
                  placeholder={l.provider === "claude" ? "code#state" : "token"}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!paste.trim()}>
                  Submit
                </Button>
              </form>
            </li>
          ) : null}
          {!l.userCode && !l.needsPaste ? <li className="hint">Finish in the browser; this updates on its own.</li> : null}
        </ol>
      ) : null}

      {l.error ? <p className="error-line">{l.error}</p> : null}
      {error ? <p className="error-line">{error}</p> : null}

      {l.output ? (
        <details className="lg-raw">
          <summary>What the CLI printed</summary>
          <pre>{l.output}</pre>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function AddAccount({
  provider,
  expect,
  onClose,
  onStarted,
}: {
  provider: ProviderId;
  /** The email this login is meant to be (from "Add as its own"). */
  expect?: string;
  onClose: () => void;
  onStarted: (l: LoginFlow) => void;
}) {
  const [label, setLabel] = useState(expect ?? "");
  const { run, busy, error } = useAction();
  return (
    <Modal
      title={`Add a ${PROVIDER_LABEL[provider]} account`}
      hint="agentbox makes a fresh credential home for it and starts the CLI's own login. Nothing is copied from your other accounts."
      onClose={onClose}
    >
      <form
        className="acs-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api.addAccount(provider, label.trim() || undefined);
            onStarted(r.login);
          });
        }}
      >
        <Field label="Label" hint="What you call it — defaults to the email once logged in.">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. work, personal, team-b" />
        </Field>
        {expect ? (
          <p className="ac-twin">
            <Icon.alert size={12} />
            <span>
              Sign in as <strong>{expect}</strong>. The login page uses whoever your browser is signed into, so switch accounts there
              first if it is someone else.
            </span>
          </p>
        ) : null}
        {error ? <p className="error-line">{error}</p> : null}
        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={Icon.key} loading={busy}>
            Start login
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportHome({ provider, onClose }: { provider: ProviderId; onClose: () => void }) {
  const [home, setHome] = useState("");
  const { run, busy, error } = useAction();
  const example = provider === "codex" ? "~/.codex-work" : provider === "devin" ? "~/.local/share/devin-work" : "~/.claude-work";
  return (
    <Modal
      title={`Import a ${PROVIDER_LABEL[provider]} home`}
      hint="Use a credential home that is already logged in — a CLAUDE_CONFIG_DIR or CODEX_HOME you set up by hand. agentbox reads it in place and never moves or copies the credentials."
      onClose={onClose}
    >
      <form
        className="acs-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (home.trim()) void run(async () => {
            await api.importAccount(provider, home.trim());
            onClose();
          });
        }}
      >
        <Field label="Home directory">
          <input autoFocus className="mono" value={home} onChange={(e) => setHome(e.target.value)} placeholder={example} spellCheck={false} />
        </Field>
        {error ? <p className="error-line">{error}</p> : null}
        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!home.trim()}>
            Import
          </Button>
        </div>
      </form>
    </Modal>
  );
}
