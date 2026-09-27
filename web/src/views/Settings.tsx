import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSettings, AppState, BalancerSettings, ReclaimResult, Repo, Schedule, WorktreeScan } from "../../../src/core/types";
import { describeAt, describeRule, isRecurring } from "../../../src/core/schedule";
import { api, fmtBytes, healthRows, type Health, type SettingsPatch } from "../api";
import { PROVIDER_LABEL, PROVIDERS, ProviderBadge } from "../bits";
import { Button, CommitInput, Confirm, Empty, Field, Icon, RelativeTime, Toggle } from "../components";
import { BALANCER_HELP } from "../lib/balancer";
import { hrefOf } from "../route";
import { WhenField } from "./newsession/WhenField";
import { scheduleTitle } from "./session/Scheduled";
import { useAction } from "./session/useAction";
import "./settings.css";

export function Settings({ state }: { state: AppState }) {
  const { settings, repos, warnings, sessions } = state;
  const { save, saveStateOf } = useSettingsSave();
  const section = { settings, save, saveStateOf };

  return (
    <div className="settings">
      <Schedules state={state} />
      <General {...section} />
      <Models {...section} installed={state.providers} />
      <Balancer {...section} />
      <Repositories repos={repos} sessions={sessions} />
      <Disk />
      <Diagnostics warnings={warnings} providers={state.providers} />
    </div>
  );
}

/**
 * A toggle with its explanation. Deliberately **not** a `Field`: a `<button
 * role="switch">` is labelable, so wrapping it in a `<label>` would make the
 * whole hint paragraph a click target.
 */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="field toggle-row">
      <Toggle checked={checked} onChange={onChange} label={label} />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

// --------------------------------------------------------------- schedules

/** Recurring sessions. One-time ones are in the session list, like sessions. */
function Schedules({ state }: { state: AppState }) {
  const recurring = state.schedules.filter((s) => isRecurring(s.rule));
  return (
    <section className="card" id="schedules">
      <h3>Scheduled sessions</h3>
      <p className="hint">
        Sessions that start on their own, each time a new one. Add one from New session: open the ▾ beside Start, pick{" "}
        <strong>Schedule…</strong>, and say something like “every weekday at 9am” or “every 2 hours”. One-time ones wait in the
        session list instead.
      </p>
      {recurring.length === 0 ? (
        <Empty title="Nothing recurring yet">Schedule one from New session and it is listed here, to pause, change or delete.</Empty>
      ) : (
        <ul className="sched-list">
          {recurring.map((sc) => (
            <ScheduleItem key={sc.id} sc={sc} state={state} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ScheduleItem({ sc, state }: { sc: Schedule; state: AppState }) {
  const { run, busy, error, clear } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [label, setLabel] = useState(sc.label ?? "");
  const [when, setWhen] = useState(describeRule(sc.rule));
  const [prompt, setPrompt] = useState(sc.spec.prompt ?? "");
  const repo = sc.spec.repoId ? state.repos.find((r) => r.id === sc.spec.repoId) : null;
  const where = repo ? repo.displayName : sc.spec.cwd ?? "";
  const startEdit = () => {
    setLabel(sc.label ?? "");
    setWhen(describeRule(sc.rule));
    setPrompt(sc.spec.prompt ?? "");
    clear();
    setEditing(true);
  };
  const save = () =>
    void run(async () => {
      await api.patchSchedule(sc.id, {
        ...(label.trim() !== (sc.label ?? "") ? { label: label.trim() || null } : {}),
        ...(when.trim() !== describeRule(sc.rule) ? { when } : {}),
        ...(prompt !== (sc.spec.prompt ?? "") ? { prompt } : {}),
      });
      setEditing(false);
    });

  return (
    <li className="sched-item" data-off={!sc.enabled || undefined}>
      <div className="sched-row">
        <Toggle
          checked={sc.enabled}
          label={sc.enabled ? "On" : "Paused"}
          labelHidden
          disabled={busy}
          onChange={(on) => void run(() => api.patchSchedule(sc.id, { enabled: on }))}
        />
        <ProviderBadge provider={sc.spec.provider} short />
        <span className="sched-name" title={sc.spec.prompt}>
          {scheduleTitle(sc)}
        </span>
        <span className="sched-rule">
          <Icon.repeat size={12} /> {describeRule(sc.rule)}
        </span>
        <span className="sched-actions">
          <Button size="sm" icon={Icon.play} disabled={busy} title="Start one now; the schedule carries on as it was" onClick={() => void run(() => api.runSchedule(sc.id))}>
            Run now
          </Button>
          <Button size="sm" icon={Icon.edit} disabled={busy} aria-label={`Edit ${scheduleTitle(sc)}`} onClick={() => (editing ? setEditing(false) : startEdit())} />
          <Button size="sm" variant="danger" icon={Icon.trash} disabled={busy} aria-label={`Delete ${scheduleTitle(sc)}`} onClick={() => setConfirming(true)} />
        </span>
      </div>
      <p className="sched-meta">
        {sc.enabled && sc.nextAt ? <>Next {lowerFirst(describeAt(sc.nextAt))}</> : "Paused"}
        {where ? <> · <span className="mono">{where}</span></> : null}
        {sc.lastRunAt ? (
          <>
            {" "}
            · last ran <RelativeTime ts={sc.lastRunAt} />
            {sc.lastSessionId && !sc.lastError ? (
              <>
                {" "}
                (<a href={hrefOf({ page: "session", id: sc.lastSessionId, tab: "terminal" })}>{sc.lastSessionId}</a>)
              </>
            ) : null}
          </>
        ) : null}
      </p>
      {sc.lastError ? (
        <p className="error" role="alert">
          Last time it did not start: {sc.lastError}
        </p>
      ) : null}
      {editing ? (
        <div className="sched-edit">
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={label} placeholder={scheduleTitle({ ...sc, label: null })} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <WhenField value={when} onChange={setWhen} />
          <label className="field">
            <span className="field-label">Prompt</span>
            <textarea className="sched-prompt" value={prompt} rows={6} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="sched-edit-actions">
            <Button variant="primary" disabled={busy || !prompt.trim()} onClick={save}>
              Save
            </Button>
            <Button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <Confirm
          title={`Delete “${scheduleTitle(sc)}”?`}
          confirmLabel="Delete"
          danger
          body={<p>It stops starting new sessions. Sessions it already started are not touched.</p>}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run(() => api.deleteSchedule(sc.id));
          }}
        />
      ) : null}
    </li>
  );
}

const lowerFirst = (s: string) => (/^(Today|Tomorrow)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// ----------------------------------------------------------------- general

function General({ settings, save, saveStateOf }: SectionProps) {
  return (
    <section className="card">
      <h3>General</h3>

      <Field label="Theme" hint="Also on the switch at the bottom of the sidebar.">
        {(id) => (
          <div className="seg" role="group" aria-label="Theme" id={id}>
            {(["light", "system", "dark"] as const).map((t) => (
              <button key={t} type="button" aria-pressed={settings.theme === t} onClick={() => save("theme", { theme: t })}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        )}
      </Field>
      <SaveMark state={saveStateOf("theme")} />

      <Field label="Board history" hint="How many days a session with no activity stays on the board before it drops off. Open sessions agentbox started are kept regardless; closed ones stay findable under See closed while they are inside this window.">
        {(id) => (
          <div className="input-row">
            <CommitInput
              id={id}
              value={String(settings.boardDays)}
              onCommit={(v) => {
                const n = Number(v.trim());
                if (Number.isFinite(n) && n >= 1) save("boardDays", { boardDays: Math.round(n) });
              }}
            />
            <span className="suffix">days</span>
          </div>
        )}
      </Field>
      <SaveMark state={saveStateOf("boardDays")} />

      <ToggleRow
        label="Auto-approve tool calls"
        hint="Starts new sessions with each provider's own bypass flag (--dangerously-skip-permissions, --full-auto, …), so they never park on a permission prompt."
        checked={settings.autoApprove}
        onChange={(v) => save("autoApprove", { autoApprove: v })}
      />
      <SaveMark state={saveStateOf("autoApprove")} />
      {settings.autoApprove && (
        <p className="warn">
          <Icon.alert size={15} /> Nothing gates what a new session does: it edits files and runs commands with no confirmation from
          anyone. Sessions already running keep the mode they started in.
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ models

function Models({
  settings,
  save,
  saveStateOf,
  installed,
}: SectionProps & { installed: AppState["providers"] }) {
  return (
    <section className="card">
      <h3>Default models</h3>
      <p className="hint">
        What a new session runs on when the dialog&apos;s Model box is left empty. Empty here means the provider&apos;s own default.
      </p>
      <div className="models-grid">
        {PROVIDERS.map((p) => {
          const info = installed.find((x) => x.id === p);
          return (
            <Field key={p} label={PROVIDER_LABEL[p]} hint={info?.installed ? info.version ?? undefined : "not installed"}>
              {(id) => (
                <>
                  <CommitInput
                    id={id}
                    mono
                    value={settings.models[p] ?? ""}
                    placeholder="provider default"
                    onCommit={(v) => save(`models.${p}`, { models: { [p]: v.trim() } })}
                  />
                  <SaveMark state={saveStateOf(`models.${p}`)} />
                </>
              )}
            </Field>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- balancer

const BALANCER_KEYS = Object.keys(BALANCER_HELP) as (keyof BalancerSettings)[];

function Balancer({ settings, save, saveStateOf }: SectionProps) {
  return (
    <section className="card">
      <h3>Balancer</h3>
      <p className="hint">
        How new sessions are placed across accounts. Everything is in weekly percentage points. The{" "}
        <a href={hrefOf({ page: "accounts", sub: "calibration" })}>Calibration</a> page suggests values from what your sessions actually
        used.
      </p>
      <div className="balancer-grid">
        {BALANCER_KEYS.map((k) => (
          <Field key={k} label={BALANCER_HELP[k].label} hint={BALANCER_HELP[k].help}>
            {(id) => (
              <>
                <div className="input-row">
                  <CommitInput
                    id={id}
                    value={String(settings.balancer[k])}
                    onCommit={(v) => {
                      const n = Number(v.trim());
                      if (Number.isFinite(n) && n >= 0) save(`balancer.${k}`, { balancer: { [k]: n } });
                    }}
                  />
                  <span className="suffix">{BALANCER_HELP[k].unit}</span>
                </div>
                <SaveMark state={saveStateOf(`balancer.${k}`)} />
              </>
            )}
          </Field>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ repositories

function Repositories({ repos, sessions }: { repos: Repo[]; sessions: AppState["sessions"] }) {
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRef, setPendingRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Repo | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function add() {
    const value = ref.trim();
    if (!value || busy) return;
    setBusy(true);
    setPendingRef(value);
    setError(null);
    try {
      await api.addRepo(value);
      setRef("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const usedBy = (repo: Repo) =>
    sessions.filter((s) => s.status !== "closed" && (s.repoRoot ?? s.cwd).startsWith(repo.ref)).length;

  async function remove(repo: Repo) {
    setConfirming(null);
    setRemoveError(null);
    try {
      await api.deleteRepo(repo.id);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="card">
      <h3>Repositories</h3>
      <p className="hint">
        What sessions can be spawned against. Give a local absolute path, or an{" "}
        <code>owner/repo</code> slug to clone. Registering also resolves the
        branch new worktrees are cut from and the GitHub slug used to find pull
        requests, so adding a remote repo is not instant — it clones first.
      </p>

      <div className="repo-add">
        <label className="sr-only" htmlFor="repo-ref">
          Repository path or owner/repo slug
        </label>
        <input
          id="repo-ref"
          className="input"
          placeholder="/path/to/repo or owner/repo"
          value={ref}
          disabled={busy}
          aria-describedby={error ? "repo-add-error" : undefined}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Button
          variant="primary"
          icon={Icon.plus}
          loading={busy}
          disabled={ref.trim() === ""}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>

      {busy && (
        <p className="hint" role="status">
          Registering <span className="mono">{pendingRef}</span> — resolving its
          default branch, and cloning it first if it is not already local. This
          can take a while.
        </p>
      )}

      {error && (
        <p className="error" id="repo-add-error" role="alert">
          {error}
        </p>
      )}

      {repos.length === 0 ? (
        <Empty title="No repositories yet">
          A session needs a repo to work in. Add a local path or an{" "}
          <code>owner/repo</code> slug above and it will be listed here.
        </Empty>
      ) : (
        <ul className="repo-list">
          {repos.map((r) => (
            <li className="repo-row" key={r.id}>
              <span className={`src ${r.kind}`}>{r.kind}</span>
              <span className="name">{r.displayName}</span>
              <span className="mono ref">{r.ref}</span>
              <span className="mono branch">
                <Icon.branch size={13} /> {r.defaultBranch}
              </span>
              {r.fullName ? (
                <span className="mono slug">{r.fullName}</span>
              ) : (
                <span
                  className="faint"
                  title="No GitHub slug was resolved for this repo, so its pull requests cannot be found or matched to sessions."
                >
                  no GitHub remote
                </span>
              )}
              <Button
                variant="danger"
                size="sm"
                icon={Icon.trash}
                aria-label={`Remove ${r.displayName}`}
                onClick={() => setConfirming(r)}
              />
            </li>
          ))}
        </ul>
      )}

      {removeError && (
        <p className="error" role="alert">
          {removeError}
        </p>
      )}

      {confirming && (
        <Confirm
          title={`Remove ${confirming.displayName}?`}
          confirmLabel="Remove"
          danger={usedBy(confirming) > 0}
          body={
            <>
              {/* The full ref, not just the display name: two registered repos
                  can share a basename, and the path is the only thing that
                  tells them apart. A dialog that names the ambiguous one is
                  not a confirmation. */}
              <p className="mono">{confirming.ref}</p>
              <p>
                {usedBy(confirming) > 0
                  ? `${usedBy(confirming)} session${usedBy(confirming) === 1 ? "" : "s"} still reference this repo and will lose the link to it. Their worktrees stay on disk and nothing is deleted, and the repo can be added back at any time.`
                  : "Nothing on disk is deleted and it can be added back at any time."}
              </p>
            </>
          }
          onConfirm={() => void remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

// -------------------------------------------------------------------- disk

/**
 * Reclaim disk from worktrees.
 *
 * This exists because Close (and Stop) deliberately keep a session's
 * checkout: the branch is what makes a session resumable, and a close that
 * destroyed a gigabyte to clear a row off the board was the wrong trade. So the disk is reclaimed here
 * instead — explicitly, over worktrees rather than sessions, after the human has
 * read what is about to go.
 *
 * Nothing on this screen runs on its own. The scan shells out to git several
 * times per worktree, which is far too expensive to put behind a render.
 */
function Disk() {
  const [scope, setScope] = useState<"all" | "agentbox">("all");
  const [scan, setScan] = useState<WorktreeScan | null>(null);
  const [busy, setBusy] = useState<null | "scan" | "safe" | "nuke">(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReclaimResult | null>(null);
  const [confirmNuke, setConfirmNuke] = useState(false);

  const removable = scan ? scan.items.filter((w) => !w.isMain && !w.live) : [];
  const safe = removable.filter((w) => w.verdict.safe);
  const safeBytes = safe.reduce((n, w) => n + w.bytes, 0);
  const allBytes = removable.reduce((n, w) => n + w.bytes, 0);

  async function act<T>(kind: "scan" | "safe" | "nuke", fn: () => Promise<T>) {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function rescan(next = scope) {
    const s = await act("scan", () => api.scanWorktrees(next));
    if (s) {
      setScan(s);
      setResult(null);
    }
  }

  async function reclaim(kind: "safe" | "nuke", paths: string[], force: boolean) {
    const r = await act(kind, () => api.reclaimWorktrees(paths, force));
    if (!r) return;
    setResult(r);
    // The list the human is looking at just became wrong. Re-deriving it from
    // `removed` would drift from what is actually on disk; asking again cannot.
    const fresh = await api.scanWorktrees(scope).catch(() => null);
    if (fresh) setScan(fresh);
  }

  return (
    <section className="card">
      <h3>Disk</h3>
      <p className="hint">
        Every session keeps its worktree when it stops or is closed, because the checkout
        is what Resume comes back to. They add up — a worktree of a large repo is
        a gigabyte — so this is where you get the space back. Removing a worktree
        never touches its branch: a session whose worktree is gone still resumes,
        it just checks the branch out again first.
      </p>

      <div className="input-row">
        <Button
          variant="primary"
          icon={Icon.search}
          loading={busy === "scan"}
          disabled={busy !== null}
          onClick={() => void rescan()}
        >
          Scan for worktrees
        </Button>
        <Toggle
          checked={scope === "all"}
          onChange={(v) => {
            const next = v ? "all" : "agentbox";
            setScope(next);
            if (scan) void rescan(next);
          }}
          label="Include worktrees agentbox did not create"
        />
      </div>

      {busy === "scan" && (
        <p className="hint" role="status">
          Scanning — reading every worktree of every registered repo, checking
          each for changes, asking GitHub what became of each branch, and sizing
          it all on disk. Tens of seconds is normal.
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {scan && scan.ghUnavailable && (
        <p className="warn">
          <Icon.alert size={15} /> The pull requests of a repo here are not loaded
          from GitHub yet (see the warnings if <code>gh</code> is the reason), so no
          branch could be checked for a merged or closed pull request. Only
          worktrees that are clean <em>and</em> have nothing their base branch is
          missing count as safe below.
        </p>
      )}

      {scan && (
        <>
          <p className="hint" role="status">
            {removable.length === 0
              ? "Nothing removable found."
              : `${removable.length} worktree${removable.length === 1 ? "" : "s"}, ${fmtBytes(allBytes)} on disk.`}
          </p>

          {removable.length > 0 && (
            <div className="input-row">
              <Button
                icon={Icon.trash}
                loading={busy === "safe"}
                disabled={busy !== null || safe.length === 0}
                title={
                  safe.length === 0
                    ? "Nothing is safe to delete — every worktree below has changes, an open PR, or could not be checked."
                    : "Removes only worktrees with nothing to lose: clean, and either merged, closed, or holding no commits their base branch does not have."
                }
                onClick={() => void reclaim("safe", safe.map((w) => w.path), false)}
              >
                Delete {safe.length} safe ({fmtBytes(safeBytes)})
              </Button>
              <Button
                variant="danger"
                icon={Icon.alert}
                loading={busy === "nuke"}
                disabled={busy !== null}
                onClick={() => setConfirmNuke(true)}
              >
                Delete all {removable.length} ({fmtBytes(allBytes)})
              </Button>
            </div>
          )}

          {result && (
            <p className={result.failed.length > 0 ? "warn" : "hint"} role="status">
              Removed {result.removed.length}, freeing {fmtBytes(result.bytesFreed)}.
              {result.failed.length > 0 && (
                <>
                  {" "}
                  {result.failed.length} could not be removed:{" "}
                  {result.failed.map((f) => `${f.path} (${f.error})`).join("; ")}
                </>
              )}
            </p>
          )}

          {scan.items.length > 0 && (
            <ul className="worktree-list">
              {scan.items.map((w) => (
                <li className="worktree-row" key={w.path}>
                  <span className={`src ${w.verdict.safe ? "safe" : "keep"}`}>
                    {w.verdict.safe ? "safe" : "keep"}
                  </span>
                  <span className="mono size">{fmtBytes(w.bytes)}</span>
                  <span className="mono ref" title={w.path}>
                    {w.path}
                  </span>
                  <span className="mono branch">
                    <Icon.branch size={13} /> {w.branch ?? "detached"}
                  </span>
                  <span className="name">{w.repoName}</span>
                  {!w.ours && !w.isMain && (
                    <span className="faint" title="Not created by agentbox.">
                      foreign
                    </span>
                  )}
                  <span className="faint reason">{w.verdict.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {confirmNuke && (
        <Confirm
          title={`Delete all ${removable.length} worktrees?`}
          body={
            <>
              This removes {fmtBytes(allBytes)} across {removable.length} worktree
              {removable.length === 1 ? "" : "s"}, including{" "}
              {removable.length - safe.length} that {removable.length - safe.length === 1 ? "is" : "are"}{" "}
              <strong>not</strong> safe — uncommitted changes and commits that were
              never pushed are gone for good. Branches are kept, so anything
              committed and on a branch survives. The repo's own checkout and any
              worktree a running session is using are skipped.
            </>
          }
          danger
          confirmLabel={`Delete ${removable.length} worktrees`}
          onCancel={() => setConfirmNuke(false)}
          onConfirm={() => {
            setConfirmNuke(false);
            void reclaim("nuke", removable.map((w) => w.path), true);
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------- diagnostics

const STATE_LABEL = { ok: "ready", unusable: "installed, not usable", missing: "not found" } as const;

function Diagnostics({ warnings, providers }: { warnings: string[]; providers: AppState["providers"] }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The probe runs subprocesses, so it is fetched on mount and on Re-check only.
  const load = useCallback((force: boolean) => {
    setLoading(true);
    setError(null);
    api
      .health(force)
      .then(setHealth)
      .catch((e: unknown) => {
        setHealth(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(false), [load]);
  const rows = health ? healthRows(health) : [];

  return (
    <section className="card">
      <h3>Diagnostics</h3>
      <p className="hint">
        The programs agentbox drives. Each is actually run, not just looked up, so one that is installed but unusable — <code>gh</code>{" "}
        logged out, most often — shows here instead of passing.
      </p>

      <div className="diag-head">
        <Button variant="ghost" icon={Icon.refresh} loading={loading} onClick={() => load(true)}>
          Re-check
        </Button>
      </div>

      {error && (
        <p className="error" role="alert">
          Could not read /api/health: {error}
        </p>
      )}

      <ul className="diag-list">
        {rows.length > 0
          ? rows.map((r) => (
              <li key={r.name} className={r.state === "ok" ? "ok" : "bad"}>
                <span className="mono name">{r.name}</span>
                <span className="state">
                  {r.state === "ok" ? <Icon.check size={15} /> : <Icon.alert size={15} />}
                  {STATE_LABEL[r.state]}
                </span>
                {r.detail && <span className="mono detail">{r.detail}</span>}
              </li>
            ))
          : providers.map((p) => (
              <li key={p.id} className={p.installed ? "ok" : "bad"}>
                <span className="mono name">{p.id}</span>
                <span className="state">
                  {p.installed ? <Icon.check size={15} /> : <Icon.alert size={15} />}
                  {p.installed ? "installed" : "not found"}
                </span>
                {p.version && <span className="mono detail">{p.version}</span>}
              </li>
            ))}
      </ul>

      <h4>Warnings</h4>
      {warnings.length === 0 ? (
        <p className="hint">Nothing to report.</p>
      ) : (
        <ul className="diag-warnings">
          {warnings.map((w) => (
            <li key={w}>
              <Icon.alert size={15} /> {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --------------------------------------------------------------- save state

type SaveStatus = { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

interface SectionProps {
  settings: AgentSettings;
  save: (key: string, patch: SettingsPatch) => void;
  saveStateOf: (key: string) => SaveStatus | undefined;
}

/**
 * Per-control save state. A settings write that fails has to say so next to the
 * control — otherwise the field just snaps back to the server's value on the
 * next `cold` push and it looks like the edit never happened.
 */
function useSettingsSave() {
  const [states, setStates] = useState<Record<string, SaveStatus | undefined>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const save = useCallback((key: string, patch: SettingsPatch) => {
    setStates((s) => ({ ...s, [key]: { phase: "saving" } }));
    api
      .saveSettings(patch)
      .then(() => {
        setStates((s) => ({ ...s, [key]: { phase: "saved" } }));
        const running = timers.current.get(key);
        if (running) clearTimeout(running);
        timers.current.set(
          key,
          setTimeout(() => {
            setStates((s) => ({ ...s, [key]: undefined }));
            timers.current.delete(key);
          }, 2500),
        );
      })
      .catch((e: unknown) => {
        setStates((s) => ({
          ...s,
          [key]: { phase: "error", message: e instanceof Error ? e.message : String(e) },
        }));
      });
  }, []);

  const saveStateOf = useCallback((key: string) => states[key], [states]);

  return { save, saveStateOf };
}

function SaveMark({ state }: { state: SaveStatus | undefined }) {
  if (!state) return null;
  if (state.phase === "saving") {
    return (
      <span className="save-mark saving" role="status">
        Saving…
      </span>
    );
  }
  if (state.phase === "saved") {
    return (
      <span className="save-mark saved" role="status">
        <Icon.check size={14} /> Saved
      </span>
    );
  }
  return (
    <span className="save-mark error" role="alert">
      <Icon.alert size={14} /> Not saved: {state.message}
    </span>
  );
}
