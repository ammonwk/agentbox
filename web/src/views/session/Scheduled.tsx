/**
 * A one-time scheduled session, before it starts: a row in the list and a page
 * of its own, where what it will say and when can still change. When its time
 * comes it starts under this same id, and the session page takes over.
 */

import { useState, useSyncExternalStore } from "react";
import type { AppState, Schedule } from "../../../../src/core/types";
import { describeRule, isRecurring, until } from "../../../../src/core/schedule";
import { api, clockNow, subscribeToClock } from "../../api";
import { PROVIDER_LABEL, ProviderBadge } from "../../bits";
import { Button, Confirm, Icon } from "../../components";
import { hrefOf } from "../../route";
import { WhenField } from "../newsession/WhenField";
import { useAction } from "./useAction";

export function scheduleTitle(sc: Schedule): string {
  return sc.label?.trim() || sc.spec.prompt?.trim().split("\n")[0]?.slice(0, 80) || "Scheduled session";
}

/** "in 4h", ticking. */
export function Until({ at }: { at: number | null }) {
  const label = useSyncExternalStore(subscribeToClock, () => (at === null ? "—" : until(at, clockNow())));
  return <time dateTime={at ? new Date(at).toISOString() : undefined}>{label}</time>;
}

/** Its row in the list, above the sessions. */
export function ScheduledRow({ sc, current, onCancel }: { sc: Schedule; current: boolean; onCancel: (sc: Schedule) => void }) {
  const [armed, setArmed] = useState(false);
  const failed = !!sc.lastError;
  return (
    <a
      className="rail-row rail-sched"
      href={hrefOf({ page: "session", id: sc.id, tab: "terminal" })}
      aria-current={current ? "page" : undefined}
      data-failed={failed || undefined}
      title={`${scheduleTitle(sc)}\n\n${failed ? `Did not start: ${sc.lastError}` : describeRule(sc.rule)}`}
      onMouseLeave={() => setArmed(false)}
    >
      <span className="rail-sched-icon" aria-hidden="true">
        {failed ? <Icon.alert size={11} /> : <Icon.clock size={11} />}
      </span>
      <span className="rail-text">
        <span className="rail-title">{scheduleTitle(sc)}</span>
      </span>
      <span className="rail-when" title={sc.nextAt ? describeRule({ kind: "once", at: sc.nextAt }) : sc.enabled ? describeRule(sc.rule) : "Not scheduled: give it a new time"}>
        {!sc.enabled ? "off" : sc.rule.kind === "merge" && sc.nextAt === null ? "on merge" : <Until at={sc.nextAt} />}
      </span>
      <span className="rail-load" />
      <button
        type="button"
        className="rail-x"
        data-armed={armed || undefined}
        aria-label={`Cancel ${scheduleTitle(sc)}`}
        title={armed ? "Click again to delete it" : "Cancel: it will not start"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!armed) return setArmed(true);
          onCancel(sc);
        }}
      >
        {armed ? "Delete?" : <Icon.x size={12} />}
      </button>
    </a>
  );
}

/** Its page: when, what it will say, where it will run — and Start now. */
export function ScheduledDetail({ sc, state, onCancel }: { sc: Schedule; state: AppState; onCancel: (sc: Schedule) => void }) {
  const { run, busy, error, clear } = useAction();
  const [confirm, setConfirm] = useState(false);
  const [when, setWhen] = useState(() => describeRule(sc.rule));
  const [prompt, setPrompt] = useState(sc.spec.prompt ?? "");
  const whenChanged = when.trim() !== describeRule(sc.rule);
  const promptChanged = prompt !== (sc.spec.prompt ?? "");
  const repo = sc.spec.repoId ? state.repos.find((r) => r.id === sc.spec.repoId) : null;
  const account = sc.spec.accountId && sc.spec.accountId !== "auto" ? state.accounts.find((a) => a.id === sc.spec.accountId) : null;
  const where = repo
    ? sc.spec.branch
      ? `branch ${sc.spec.branch}`
      : sc.spec.worktree
        ? "in a new worktree"
        : "in the main checkout"
    : sc.spec.cwd ?? "—";

  const save = () =>
    void run(async () => {
      const next = await api.patchSchedule(sc.id, { ...(whenChanged ? { when } : {}), ...(promptChanged ? { prompt } : {}) });
      // Made recurring: that kind lives in Settings.
      if (isRecurring(next.rule)) location.hash = hrefOf({ page: "settings" });
      else setWhen(describeRule(next.rule));
    });

  return (
    <div className="sv-main">
      <header className="sx-header">
        <div className="sx-header-top">
          <ProviderBadge provider={sc.spec.provider} />
          <h2 className="sd-title">{scheduleTitle(sc)}</h2>
          <span className="pill pill-scheduled" title={describeRule(sc.rule)}>
            <Icon.clock size={11} />
            {!sc.enabled ? (
              "Not scheduled"
            ) : sc.rule.kind === "merge" && sc.nextAt === null ? (
              `Starts when #${sc.rule.pr} merges`
            ) : (
              <>
                Starts <Until at={sc.nextAt} />
              </>
            )}
          </span>
          <div className="sx-header-actions">
            <Button
              size="sm"
              variant="primary"
              icon={Icon.play}
              disabled={busy}
              onClick={() => void run(async () => void (await api.runSchedule(sc.id)))}
            >
              Start now
            </Button>
            <Button size="sm" icon={Icon.x} disabled={busy} onClick={() => setConfirm(true)}>
              Cancel
            </Button>
          </div>
        </div>
      </header>

      <div className="sd-body">
        {sc.lastError ? (
          <p className="sd-failed" role="alert">
            <Icon.alert size={13} /> It did not start: {sc.lastError}.{" "}
            {sc.enabled && sc.nextAt ? `Trying again ${describeRule({ kind: "once", at: sc.nextAt }).toLowerCase()}.` : "Give it a new time, or Start now."}
          </p>
        ) : null}

        <WhenField value={when} onChange={setWhen} />

        <div className="field">
          <label className="field-label" htmlFor="sd-prompt">
            Prompt
          </label>
          <textarea id="sd-prompt" className="sd-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} spellCheck />
        </div>

        {error ? (
          <p className="error-line" role="alert">
            {error}{" "}
            <button type="button" className="linkish" onClick={clear}>
              dismiss
            </button>
          </p>
        ) : null}

        <div className="sd-save">
          <Button variant="primary" disabled={busy || (!whenChanged && !promptChanged) || !prompt.trim()} onClick={save}>
            Save changes
          </Button>
          {whenChanged || promptChanged ? (
            <Button
              disabled={busy}
              onClick={() => {
                setWhen(describeRule(sc.rule));
                setPrompt(sc.spec.prompt ?? "");
              }}
            >
              Revert
            </Button>
          ) : null}
        </div>

        <dl className="sd-facts">
          <dt>Agent</dt>
          <dd>{PROVIDER_LABEL[sc.spec.provider]}</dd>
          {sc.rule.kind === "merge" && sc.rule.repo ? (
            <>
              <dt>Waits for</dt>
              <dd>
                <a href={`https://github.com/${sc.rule.repo}/pull/${sc.rule.pr}`} target="_blank" rel="noreferrer">
                  {sc.rule.repo}#{sc.rule.pr}
                </a>
                {sc.rule.title ? ` · ${sc.rule.title}` : ""}
              </dd>
            </>
          ) : null}
          <dt>Where</dt>
          <dd>
            {repo ? (
              <select
                className="sd-repo"
                aria-label="Repository"
                value={repo.id}
                disabled={busy}
                onChange={(e) => void run(() => api.patchSchedule(sc.id, { repoId: e.target.value }))}
              >
                {state.repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            ) : null}{" "}
            <span className="mono">{where}</span>
          </dd>
          <dt>Model</dt>
          <dd>
            {sc.spec.model ?? `Default${state.settings.models[sc.spec.provider] ? ` (${state.settings.models[sc.spec.provider]})` : ""}`}
            {sc.spec.effort ? ` · ${sc.spec.effort}` : ""}
            {sc.spec.big ? " · Big" : ""}
          </dd>
          <dt>Account</dt>
          <dd>{account ? account.label : "Auto: the balancer picks when it starts"}</dd>
        </dl>
      </div>

      {confirm ? (
        <Confirm
          title={`Cancel “${scheduleTitle(sc)}”?`}
          confirmLabel="Delete it"
          body={<p>It will not start, and its prompt is deleted with it.</p>}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onCancel(sc);
          }}
        />
      ) : null}
    </div>
  );
}
