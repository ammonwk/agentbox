import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSettings, AppState, Repo, SkillInfo } from "../../../src/core/types";
import { api, type Health } from "../api";
import { Button, CommitInput, Confirm, Empty, Field, Icon, Toggle } from "../components";
import "./settings.css";

export function Settings({ state }: { state: AppState }) {
  const { settings, repos, skills, warnings, sessions } = state;
  const { save, saveStateOf } = useSettingsSave();
  const section = { settings, save, saveStateOf };

  return (
    <div className="settings">
      <RunDefaults {...section} />
      <SystemPrompt {...section} />
      <Supervision {...section} />
      <Repositories repos={repos} sessions={sessions} />
      <Skills skills={skills} />
      <Diagnostics warnings={warnings} />
    </div>
  );
}

/**
 * A toggle with its explanation. Deliberately **not** a `Field`.
 *
 * `Field`'s plain-children form renders a `<label>`, and a `<button
 * role="switch">` is a labelable element — so wrapping a `Toggle` in one makes
 * the entire hint paragraph a click target, and reading the sentence that
 * explains a setting flips that setting. `Toggle` already carries its own
 * accessible name via `label`, so it needs nothing from `Field`.
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

// ------------------------------------------------------------ run defaults

function RunDefaults({ settings, save, saveStateOf }: SectionProps) {
  const [minutesError, setMinutesError] = useState<string | null>(null);

  function commitMinutes(raw: string) {
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1) {
      setMinutesError(`"${raw}" is not a whole number of minutes — nothing was saved.`);
      return;
    }
    setMinutesError(null);
    save("maxMinutes", { maxMinutes: n });
  }

  return (
    <section className="card">
      <h3>Run defaults</h3>
      <p className="hint">
        Used by sessions spawned from now on. A session already running keeps
        the values it started with.
      </p>

      <Field
        label="Model"
        hint="The omp model id new sessions run on. A session can be given a different one when you spawn it."
      >
        {(id) => (
          <CommitInput
            id={id}
            value={settings.model}
            placeholder="provider/model"
            onCommit={(v) => save("model", { model: v.trim() })}
          />
        )}
      </Field>
      <SaveMark state={saveStateOf("model")} />

      <ToggleRow
        label="Auto-approve tool calls"
        hint="Answers every permission request with yes, so a session never parks waiting for you."
        checked={settings.autoApprove}
        onChange={(v) => save("autoApprove", { autoApprove: v })}
      />
      <SaveMark state={saveStateOf("autoApprove")} />
      {settings.autoApprove && (
        <p className="warn">
          <Icon.alert size={15} /> omp's own approval mode already defaults to{" "}
          <code>yolo</code>. With this on as well, nothing gates what the agent
          does at any layer — it edits files and runs commands in its worktree
          with no confirmation from anyone. The supervisor below is then the
          only brake, and it reacts after the fact rather than before.
        </p>
      )}

      <Field
        label="Max run time"
        hint="Handed to omp as --max-time. When it runs out omp stops the session where it stands: whatever the agent had already written stays in the worktree, no pull request is opened, nothing is rolled back, and the session turns up in your Inbox. It is a spend cap rather than a deadline the agent knows about — it will not hurry to finish."
      >
        {(id) => (
          <div className="input-row">
            <CommitInput
              id={id}
              value={String(settings.maxMinutes)}
              placeholder="60"
              onCommit={commitMinutes}
            />
            <span className="suffix">minutes</span>
          </div>
        )}
      </Field>
      <SaveMark state={saveStateOf("maxMinutes")} />
      {minutesError && (
        <p className="error" role="alert">
          {minutesError}
        </p>
      )}
    </section>
  );
}

// ----------------------------------------------------------- system prompt

function SystemPrompt({ settings, save, saveStateOf }: SectionProps) {
  return (
    <section className="card">
      <h3>System prompt</h3>
      <p className="hint">
        Text appended to the system prompt of <strong>every</strong> agentbox
        session, on every repo. It is the standing instruction each agent starts
        from, which makes it the most consequential setting on this page: house
        rules belong here, and anything specific to one task does not.
      </p>
      <p className="hint">
        It does not replace a repo's own <code>.omp/APPEND_SYSTEM.md</code>.
        Passing <code>--append-system-prompt</code> stops omp discovering that
        file itself, so agentbox reads it and concatenates the two — a repo
        keeps its own conventions and this sits alongside them.
      </p>

      <Field label="Prompt overlay">
        {(id) => (
          <CommitInput
            id={id}
            value={settings.systemPrompt}
            multiline
            mono
            rows={14}
            placeholder="e.g. Prefer small diffs. Never edit generated files. Run the tests before claiming you are done."
            onCommit={(v) => save("systemPrompt", { systemPrompt: v })}
          />
        )}
      </Field>
      <SaveMark state={saveStateOf("systemPrompt")} />

      <p className="hint">
        Saved changes reach <strong>newly spawned</strong> sessions only. A
        session already running has its prompt file on disk and will not pick
        this up; stop it and start another if the change matters to work in
        flight.
      </p>
    </section>
  );
}

// -------------------------------------------------------------- supervision

function Supervision({ settings, save, saveStateOf }: SectionProps) {
  const { supervisor, advisor } = settings;

  return (
    <section className="card">
      <h3>Supervision</h3>
      <p className="hint">
        Two watchers that do different jobs. The supervisor is agentbox's and it
        can stop a run; the advisor is omp's and it only talks to the agent.
      </p>

      <h4>Supervisor</h4>
      <p className="hint">
        agentbox's own babysitter. It watches the session's tool calls: when the
        agent is drifting off the task it sends a correcting note, and when the
        agent is spiralling — the same failing command again and again, one file
        rewritten six times — it interrupts the run and flags it for you.
        Nothing is lost when it does: a flagged session resumes in one click
        from the Inbox.
      </p>

      <ToggleRow
        label="Enable supervisor"
        checked={supervisor.enabled}
        onChange={(v) => save("supervisor.enabled", { supervisor: { enabled: v } })}
      />
      <SaveMark state={saveStateOf("supervisor.enabled")} />

      <Field
        label="Check every"
        hint="Counted in tool calls, not turns — a single turn can be dozens of tool calls, so turns are far too coarse to catch a loop while it is still cheap to fix. A lower number notices sooner and costs one cheap model call each time it fires. Free heuristics run on every call regardless, and a heuristic hit escalates immediately without waiting for this interval."
      >
        {(id) => (
          <div className="input-row">
            <CommitInput
              id={id}
              value={String(supervisor.everyToolCalls)}
              placeholder="25"
              disabled={!supervisor.enabled}
              onCommit={(v) => {
                const n = Number(v.trim());
                if (Number.isInteger(n) && n >= 1) {
                  save("supervisor.everyToolCalls", { supervisor: { everyToolCalls: n } });
                }
              }}
            />
            <span className="suffix">tool calls</span>
          </div>
        )}
      </Field>
      <SaveMark state={saveStateOf("supervisor.everyToolCalls")} />

      <Field
        label="Judge model"
        hint="Reads a compact summary of the recent tool calls and returns a verdict. Cheap and fast is the right choice — it never sees the whole transcript. It runs through your existing omp login, so there is no extra account or key to set up."
      >
        {(id) => (
          <CommitInput
            id={id}
            value={supervisor.model}
            placeholder="provider/cheap-model"
            disabled={!supervisor.enabled}
            onCommit={(v) => save("supervisor.model", { supervisor: { model: v.trim() } })}
          />
        )}
      </Field>
      <SaveMark state={saveStateOf("supervisor.model")} />
      {supervisor.enabled && supervisor.model.trim() === "" && (
        <p className="warn" role="alert">
          <Icon.alert size={15} /> The supervisor is on but has no judge model,
          so only the free heuristics can fire — a repeated command or a run of
          errors is still caught, drifting off the task is not. Set a model, or
          turn the supervisor off so this page is not claiming a check that is
          not happening.
        </p>
      )}

      <h4>Advisor</h4>
      <p className="hint">
        omp's built-in second opinion, not agentbox's. It reviews each turn as
        the agent works and injects its notes into the running session, where
        they appear in the transcript as advisories. It cannot stop a run or
        flag one — it only advises.
      </p>

      <ToggleRow
        label="Enable advisor"
        checked={advisor.enabled}
        onChange={(v) => save("advisor.enabled", { advisor: { enabled: v } })}
      />
      <SaveMark state={saveStateOf("advisor.enabled")} />

      <Field label="Advisor model" hint="The model omp assigns to its advisor role.">
        {(id) => (
          <CommitInput
            id={id}
            value={advisor.model}
            placeholder="provider/model"
            disabled={!advisor.enabled}
            onCommit={(v) => save("advisor.model", { advisor: { model: v.trim() } })}
          />
        )}
      </Field>
      <SaveMark state={saveStateOf("advisor.model")} />
      {advisor.enabled && advisor.model.trim() === "" && (
        <p className="warn" role="alert">
          <Icon.alert size={15} /> The advisor is on but no model is assigned to
          omp's <code>advisor</code> role. omp accepts the flag and does nothing
          with it — <strong>no advice will ever appear</strong>, and no error is
          reported anywhere. Set a model here, or turn the advisor off.
        </p>
      )}
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

  const usedBy = (repo: Repo) => sessions.filter((s) => s.repo === repo.ref).length;

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
            usedBy(confirming) > 0
              ? `${usedBy(confirming)} session${usedBy(confirming) === 1 ? "" : "s"} still reference this repo and will lose the link to it. Their worktrees stay on disk and nothing is deleted, and the repo can be added back at any time.`
              : "Nothing on disk is deleted and it can be added back at any time."
          }
          onConfirm={() => void remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------------ skills

function Skills({ skills }: { skills: SkillInfo[] }) {
  return (
    <section className="card">
      <h3>Skills</h3>
      <p className="hint">
        Every <code>SKILL.md</code> the agents can reach. Scanned from{" "}
        <code>~/.claude/skills</code>, <code>~/.agents/skills</code>, and{" "}
        <code>.claude/skills</code> under the directory agentbox was started
        from. Read-only here — add one by putting a folder with a{" "}
        <code>SKILL.md</code> in it into any of those three roots.
      </p>
      {skills.length === 0 ? (
        <Empty title="No skills found">
          None of the three roots hold a folder with a <code>SKILL.md</code> in
          it. Agents still run; they just have no skills to draw on.
        </Empty>
      ) : (
        <ul className="skill-list">
          {skills.map((s) => (
            <li key={s.path}>
              <span className={`src ${s.source}`}>{s.source}</span>
              <span className="name">{s.name}</span>
              <span className="desc">
                {s.description || "No description in its frontmatter."}
              </span>
              <span className="mono path">{s.path}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------- diagnostics

function Diagnostics({ warnings }: { warnings: string[] }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Health shells out to look for binaries and is not on the WebSocket, so it
  // is fetched once and then only when asked for. Never polled.
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .health()
      .then(setHealth)
      .catch((e: unknown) => {
        setHealth(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <section className="card">
      <h3>Diagnostics</h3>
      <p className="hint">
        The external programs agentbox drives. Each one is actually run rather
        than just looked for on PATH, so a dependency that is installed but
        unusable — <code>gh</code> present and logged out, most often — reports
        as a problem here instead of passing the check. When one of these is not
        working the feature that needs it goes quiet rather than failing loudly,
        so this is where you find out why something is empty.
      </p>

      <div className="diag-head">
        <Button variant="ghost" icon={Icon.refresh} loading={loading} onClick={refresh}>
          Re-check
        </Button>
        {health && <span className="mono">agentbox {health.version}</span>}
      </div>

      {error && (
        <p className="error" role="alert">
          Could not read /api/health: {error}. If the rest of this page looks
          stale too, the server is probably down.
        </p>
      )}

      {health && (
        <ul className="diag-list">
          <DepRow
            name="omp"
            present={health.omp}
            whenMissing="Nothing can be spawned. Every new session will fail at launch until omp is on PATH."
          />
          <DepRow
            name="gh"
            present={health.gh}
            whenMissing="Pull requests are invisible everywhere in agentbox: the Inbox lists none, and a session whose branch has an open PR never becomes a review item. Install the GitHub CLI, then run `gh auth login` — being logged out fails this check just as a missing binary does."
          />
          <DepRow
            name="git"
            present={health.git}
            whenMissing="No worktree can be created and no diff can be read, so sessions cannot run at all."
          />
        </ul>
      )}

      <h4>Warnings</h4>
      <p className="hint">
        Problems the server hit while doing its own work — a repo it could not
        read, a skills folder it could not scan — rather than a dependency being
        broken, which the check above covers.
      </p>
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

/**
 * `ready` rather than `installed`: the probe runs each program, so the boolean
 * means usable, not merely present on PATH. Saying "installed" would be the
 * claim the server used to make and no longer does.
 *
 * The server also sends `<dep>State` ("ok" | "unusable" | "missing") and a
 * `<dep>Detail` sentence carrying the version when ready and the reason when
 * not. Neither is on `Health` in `api.ts` yet, so this row cannot tell a
 * missing binary from a broken one — it reports the problem without naming
 * which. Wire both once the client type catches up.
 */
function DepRow({
  name,
  present,
  whenMissing,
}: {
  name: string;
  present: Health["omp"];
  whenMissing: string;
}) {
  return (
    <li className={present ? "ok" : "bad"}>
      <span className="mono name">{name}</span>
      <span className="state">
        {present ? <Icon.check size={15} /> : <Icon.alert size={15} />}
        {present ? "ready" : "not working"}
      </span>
      {!present && <p className="consequence">{whenMissing}</p>}
    </li>
  );
}

// --------------------------------------------------------------- save state

type SaveStatus = { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

/** `PUT /api/settings` deep-merges, so each control sends only the leaf it
 *  changed — two edits in quick succession then cannot clobber each other. */
type SettingsPatch = Parameters<typeof api.saveSettings>[0];

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
