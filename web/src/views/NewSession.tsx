import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, Placement, ProviderId } from "../../../src/core/types";
import { api, type NewSessionInput } from "../api";
import { AccountChip, PROVIDER_LABEL, PROVIDERS } from "../bits";
import { Button, Field, Icon, Modal, Spinner } from "../components";
import { candidateTable, placementHeadline } from "../lib/placement";
import { usageSummary } from "../lib/usage";
import "./newsession.css";

/** Remembered between openings: the last provider and where, not the prompt. */
let lastProvider: ProviderId | null = null;
let lastRepo: string | null = null;

/**
 * Start a session: which CLI, where, what to do, and on which account — with
 * the balancer's reasoning shown live, so "Auto" is never a black box.
 */
export function NewSession({
  state,
  onClose,
  onCreated,
}: {
  state: AppState;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const installed = state.providers.filter((p) => p.installed).map((p) => p.id);
  const [provider, setProvider] = useState<ProviderId>(
    lastProvider && installed.includes(lastProvider) ? lastProvider : installed[0] ?? "claude",
  );
  const [where, setWhere] = useState<"repo" | "path">(state.repos.length > 0 ? "repo" : "path");
  const [repoId, setRepoId] = useState<string>(
    lastRepo && state.repos.some((r) => r.id === lastRepo) ? lastRepo : state.repos[0]?.id ?? "",
  );
  const [worktree, setWorktree] = useState(true);
  const [path, setPath] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [big, setBig] = useState(false);
  const [accountId, setAccountId] = useState<string>("auto");
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  // After the Modal's own focus handling (child effects run first), so the
  // prompt, not the close button, is where typing lands.
  useEffect(() => promptRef.current?.focus(), []);

  const accounts = useMemo(() => state.accounts.filter((a) => a.provider === provider), [state.accounts, provider]);
  const b = state.settings.balancer;

  // A manual pick that belongs to another provider is not a pick.
  useEffect(() => {
    if (accountId !== "auto" && !accounts.some((a) => a.id === accountId)) setAccountId("auto");
  }, [accounts, accountId]);

  // Live placement: re-asked whenever the things it depends on change. The
  // model matters only for scoped weekly limits, so it is debounced.
  useEffect(() => {
    let cancelled = false;
    setPlacing(true);
    setPlaceErr(null);
    const t = setTimeout(() => {
      api
        .placement({ provider, big, ...(model.trim() ? { model: model.trim() } : {}) })
        .then((p) => !cancelled && setPlacement(p))
        .catch((e: unknown) => !cancelled && setPlaceErr(e instanceof Error ? e.message : String(e)))
        .finally(() => !cancelled && setPlacing(false));
    }, model ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [provider, big, model]);

  const manual = accountId !== "auto" ? accounts.find((a) => a.id === accountId) ?? null : null;
  const noEligible = !manual && placement?.mode === "none";
  const whereOk = where === "repo" ? !!repoId : path.trim().length > 0;
  const canSubmit = whereOk && !busy && !noEligible && installed.includes(provider);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const input: NewSessionInput = {
      provider,
      ...(where === "repo" ? { repoId, worktree } : { cwd: path.trim() }),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      big,
      accountId,
    };
    try {
      const r = await api.createSession(input);
      lastProvider = provider;
      if (where === "repo") lastRepo = repoId;
      onCreated(r.session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const rows = placement ? candidateTable(placement, manual?.id ?? null) : [];

  return (
    <Modal title="New session" onClose={onClose} wide>
      <form
        className="ns"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="ns-grid">
          <div className="ns-col">
            <div className="field">
              <span className="field-label" id="ns-agent">
                Agent
              </span>
              <div className="seg ns-providers" role="group" aria-labelledby="ns-agent">
                  {PROVIDERS.map((p) => {
                    const info = state.providers.find((x) => x.id === p);
                    const ok = !!info?.installed;
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={provider === p}
                        disabled={!ok}
                        title={ok ? `${PROVIDER_LABEL[p]} ${info?.version ?? ""}`.trim() : `${PROVIDER_LABEL[p]} is not installed`}
                        onClick={() => setProvider(p)}
                      >
                        <span className={`ns-pdot prov-${p}`} aria-hidden="true" />
                        {PROVIDER_LABEL[p]}
                      </button>
                    );
                  })}
              </div>
            </div>

            <div className="field">
              <div className="ns-where-head">
                <span className="field-label">Where</span>
                <div className="seg seg-sm" role="group" aria-label="Where to run">
                  <button type="button" aria-pressed={where === "repo"} disabled={state.repos.length === 0} onClick={() => setWhere("repo")}>
                    Repository
                  </button>
                  <button type="button" aria-pressed={where === "path"} onClick={() => setWhere("path")}>
                    Folder
                  </button>
                </div>
              </div>
              {where === "repo" ? (
                <div className="ns-where">
                  <select aria-label="Repository" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                    {state.repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName} — {r.fullName ?? r.ref}
                      </option>
                    ))}
                  </select>
                  <label className="ns-check">
                    <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                    <span>
                      New worktree
                      <span className="field-hint">
                        A fresh branch off {state.repos.find((r) => r.id === repoId)?.defaultBranch ?? "the default branch"}, so it cannot
                        collide with anything else running there.
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <input
                  aria-label="Folder path"
                  className="mono"
                  placeholder="/home/you/code/project"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  spellCheck={false}
                />
              )}
            </div>

            <Field label="Prompt" hint="Optional. Leave empty to start at the CLI's own prompt.">
              <textarea
                className="ns-prompt"
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should it do?"
                rows={6}
              />
            </Field>

            <div className="ns-row2">
              <Field label="Model">
                <input
                  className="mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={state.settings.models[provider] || "provider default"}
                  spellCheck={false}
                />
              </Field>
              <Field label="Account">
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="auto">Auto (recommended)</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} — {usageSummary(a)}
                      {!a.enabled ? " · disabled" : a.auth.state !== "ok" ? ` · ${a.auth.state}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <label className="ns-check ns-big">
              <input type="checkbox" checked={big} onChange={(e) => setBig(e.target.checked)} />
              <span>
                <strong>Big session</strong>
                <span className="field-hint">
                  Claims {b.claimBig}% of the account&apos;s weekly instead of {b.claimNormal}%, so the balancer keeps room for a long
                  run and steers other sessions elsewhere.
                </span>
              </span>
            </label>
          </div>

          <aside className="ns-place" aria-label="Placement preview" aria-busy={placing}>
            <div className="ns-place-head">
              <span className="section-label">Placement</span>
              {placing ? <Spinner size={12} /> : null}
            </div>
            {placeErr ? (
              <p className="error-line">Could not preview placement: {placeErr}</p>
            ) : !placement ? (
              <p className="hint">Asking the balancer…</p>
            ) : (
              <>
                <div className={`ns-choice${noEligible ? " none" : ""}`}>
                  <span className="ns-choice-head">{placementHeadline(placement, manual?.label ?? null)}</span>
                  {!noEligible ? (
                    <AccountChip accountId={manual?.id ?? placement.accountId} accounts={state.accounts} />
                  ) : null}
                </div>
                <p className="ns-why">
                  {manual
                    ? manual.enabled
                      ? `You picked ${manual.label}. Auto would choose ${placement.candidates.find((c) => c.accountId === placement.accountId)?.label ?? "nothing"}: ${placement.why}`
                      : `${manual.label} is disabled for auto-placement, but a manual pick still runs there.`
                    : placement.why}
                </p>
                {rows.length > 0 ? (
                  <table className="ns-table">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th className="num" title="Weekly % used → with outstanding claims (W′)">Weekly</th>
                        <th className="num" title="5-hour % used → with claims (F′)">5h</th>
                        <th className="num" title="5-hour room after claims, raised as the reset nears">Room</th>
                        <th className="num" title="Ordering key; higher wins">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <Fragment key={r.accountId}>
                          <tr data-chosen={r.chosen || undefined} data-eligible={r.eligible} className={r.eligible ? undefined : "has-reason"}>
                            <td>
                              <span className="ns-t-acct">
                                {r.chosen ? <Icon.check size={12} /> : <span className="ns-t-spacer" />}
                                {r.label}
                              </span>
                            </td>
                            <td className="num">{r.weekly}</td>
                            <td className="num">{r.short}</td>
                            <td className="num">{r.legRoom}</td>
                            <td className="num">{r.eligible ? r.score : "—"}</td>
                          </tr>
                          {!r.eligible ? (
                            <tr className="ns-reason" data-chosen={r.chosen || undefined}>
                              <td colSpan={5}>{r.verdict}</td>
                            </tr>
                          ) : null}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="hint">No {PROVIDER_LABEL[provider]} account is set up. Add one on the Accounts page.</p>
                )}
                <p className="hint ns-claim">
                  This session will claim <strong>{placement.claim}</strong> weekly points until it has used them or goes idle{" "}
                  {b.claimIdleMin} min.
                </p>
              </>
            )}
          </aside>
        </div>

        {error ? (
          <p className="error-line" role="alert">
            {error}
          </p>
        ) : null}

        <div className="modal-actions">
          <span className="ns-foot-hint faint">
            <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to start
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={Icon.play} loading={busy} disabled={!canSubmit}>
            Start {PROVIDER_LABEL[provider]}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
