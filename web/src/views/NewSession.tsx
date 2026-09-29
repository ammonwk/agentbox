import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, ModelOption, Placement, PrInfo, ProviderId, Repo, Schedule } from "../../../src/core/types";
import { parseWhen } from "../../../src/core/schedule";
import { api, type NewSessionInput } from "../api";
import { PROVIDER_LABEL, PROVIDERS } from "../bits";
import { AttachButton, useAttachments } from "../attachments";
import { Button, Icon, Modal } from "../components";
import {
  loadPrefs,
  loadRepoChoices,
  noteRepoChoice,
  parseWorktreeRef,
  promptPrs,
  prsOf,
  rankModels,
  recentFolders,
  reposByChoice,
  reposByRecency,
  savePrefs,
  skillsFor,
  worktreeDefault,
  type NewSessionPrefs,
} from "../lib/newsession";
import { AccountPicker } from "./newsession/AccountPicker";
import { ModelPicker } from "./newsession/ModelPicker";
import { EffortPicker } from "./newsession/EffortPicker";
import { PromptBox } from "./newsession/PromptBox";
import { WorktreeField } from "./newsession/WorktreeField";
import { WhenField } from "./newsession/WhenField";
import { useDismiss, useFloating } from "./newsession/popover";
import "./newsession.css";

/** The select's extra row: picking it opens the "other repo" input below. */
const OTHER = "__other__";

/**
 * Start a session: which CLI, where, what to do, on which model and account.
 * Every choice is remembered (lib/newsession.ts), so the next session starts
 * the way the last one did; the account picker carries the balancer's
 * reasoning, so "Auto" is never a black box.
 */
export function NewSession({
  state,
  onClose,
  onCreated,
  onScheduled,
}: {
  state: AppState;
  onClose: () => void;
  onCreated: (id: string) => void;
  onScheduled: (s: Schedule) => void;
}) {
  const [prefs] = useState<NewSessionPrefs>(loadPrefs);
  const installed = state.providers.filter((p) => p.installed).map((p) => p.id);
  const [provider, setProvider] = useState<ProviderId>(
    prefs.provider && installed.includes(prefs.provider) ? prefs.provider : installed[0] ?? "claude",
  );
  /** Repos registered from this dialog ("Select other…") whose cold frame has
   *  not landed yet, so the select can show the new one at once. */
  const [added, setAdded] = useState<Repo[]>([]);
  const knownRepos = useMemo(() => {
    const ids = new Set(state.repos.map((r) => r.id));
    return [...state.repos, ...added.filter((a) => !ids.has(a.id))];
  }, [state.repos, added]);
  const [repoChoices, setRepoChoices] = useState<Record<string, number>>(loadRepoChoices);
  const repos = useMemo(
    () => reposByChoice(reposByRecency(knownRepos, state.sessions), repoChoices),
    [knownRepos, state.sessions, repoChoices],
  );
  const [where, setWhere] = useState<"repo" | "path">(state.repos.length === 0 ? "path" : prefs.where ?? "repo");
  const [repoId, setRepoId] = useState<string>(
    prefs.repoId && state.repos.some((r) => r.id === prefs.repoId) ? prefs.repoId : repos[0]?.id ?? "",
  );
  const [worktree, setWorktree] = useState(prefs.worktree ?? true);
  /** With "New worktree" off: blank (main checkout), `new`, or a PR. Not
   *  remembered — a PR is a one-off. */
  const [wtText, setWtText] = useState("");
  const [path, setPath] = useState(prefs.path ?? "");
  const [prompt, setPrompt] = useState(prefs.draft ?? "");
  const [big, setBig] = useState(prefs.big ?? false);
  const [perProvider, setPerProvider] = useState(prefs.perProvider ?? {});
  const model = perProvider[provider]?.model ?? "";
  const accountId = perProvider[provider]?.accountId ?? "auto";
  const providerEfforts = state.providers.find((p) => p.id === provider)?.efforts ?? [];
  const setChoice = (patch: { model?: string; accountId?: string; effort?: string }) =>
    setPerProvider((p) => ({ ...p, [provider]: { ...p[provider], ...patch } }));

  const [placement, setPlacement] = useState<Placement | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Start it now, or later: the ▾ beside Start switches. */
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [when, setWhen] = useState("");
  const whenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "schedule") whenRef.current?.focus();
  }, [mode]);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const images = useAttachments({ text: prompt, setText: setPrompt, textareaRef: promptRef, initial: prefs.draftImages });
  // After the Modal's own focus handling (child effects run first), so the
  // prompt, not the close button, is where typing lands — at the end of a
  // restored draft.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const accounts = useMemo(() => state.accounts.filter((a) => a.provider === provider), [state.accounts, provider]);
  const b = state.settings.balancer;

  // A remembered pin to an account that is gone is not a pin.
  useEffect(() => {
    if (accountId !== "auto" && !accounts.some((a) => a.id === accountId)) setChoice({ accountId: "auto" });
  }, [accounts, accountId]);

  // Live placement: re-asked whenever the things it depends on change. The
  // model matters only for scoped weekly limits, so it is debounced.
  useEffect(() => {
    let cancelled = false;
    setPlacing(true);
    setPlaceErr(null);
    const t = setTimeout(() => {
      api
        .placement({ provider, big, ...(model ? { model } : {}) })
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
  // The account whose models to offer: the pin, else where Auto would go.
  const target = manual ?? accounts.find((a) => a.id === placement?.accountId) ?? accounts[0] ?? null;

  useEffect(() => {
    if (!target) return setCatalog([]);
    let cancelled = false;
    api
      .models(target.id)
      .then((m) => !cancelled && setCatalog(m))
      .catch(() => !cancelled && setCatalog([]));
    return () => {
      cancelled = true;
    };
  }, [target?.id]);

  const models = useMemo(
    () => rankModels(catalog, state.sessions, provider),
    [catalog, state.sessions, provider],
  );
  // A catalog entry can pin its own levels (codex's models_cache names them
  // per model); the picked model's list wins over the provider's static one.
  const efforts = models.find((m) => m.id === model)?.efforts ?? providerEfforts;
  const effortPref = perProvider[provider]?.effort ?? "";
  const effort = efforts.includes(effortPref) ? effortPref : "";
  const repo = knownRepos.find((r) => r.id === repoId) ?? null;
  const repoPrs = useMemo(() => prsOf(state.prs, repo), [state.prs, repo]);
  const wt = parseWorktreeRef(wtText, repoPrs);

  // A PR named in the prompt is where the session should run: one PR fills
  // the worktree box with it; two or more name no single branch, so it goes
  // back to a new worktree. Only when the set of PRs changes, so a choice
  // made by hand after that sticks — and dropping the PR from the prompt
  // undoes only what the prompt did, not something you typed since.
  const mentioned = useMemo(
    () => (where === "repo" ? promptPrs(prompt, repoPrs, repo?.fullName ?? null) : []),
    [where, prompt, repoPrs, repo?.fullName],
  );
  const mentionedKey = mentioned.join(",");
  const autoWt = useRef<string | null>(null);
  useEffect(() => {
    if (mentioned.length === 1) {
      const t = `#${mentioned[0]}`;
      setWorktree(false);
      setWtText(t);
      autoWt.current = t;
    } else if (mentioned.length > 1) {
      setWorktree(true);
      setWtText("");
      autoWt.current = null;
    } else if (autoWt.current !== null) {
      if (wtText === autoWt.current) {
        setWorktree(true);
        setWtText("");
      }
      autoWt.current = null;
    }
  }, [mentionedKey]);
  const wtFromPrompt = !worktree && autoWt.current !== null && wtText === autoWt.current;

  // Picking a repo sets the box to where that repo's sessions usually run —
  // only on the switch, so unticking it afterwards sticks. A PR the prompt
  // names wins: the effect above puts the session on it. Every pick is
  // remembered, so the list sorts by most recently chosen next time.
  function pickRepo(id: string) {
    if (id === OTHER) {
      setOtherRef("");
      setOtherErr(null);
      setOtherOpen(true);
      return;
    }
    setOtherOpen(false);
    noteRepoChoice(id);
    setRepoChoices((c) => ({ ...c, [id]: Date.now() }));
    setRepoId(id);
    const next = knownRepos.find((r) => r.id === id);
    if (!next || promptPrs(prompt, prsOf(state.prs, next), next.fullName).length > 0) return;
    const def = worktreeDefault(next);
    if (def === null) return;
    setWorktree(def);
    setWtText("");
  }

  // "Select other…": register a repo the list does not know — a local path or
  // an owner/repo slug — and run against it from now on. The server resolves
  // the branch and the GitHub slug, so a slug that is not local yet clones
  // first and can take a while.
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherRef, setOtherRef] = useState("");
  const [otherBusy, setOtherBusy] = useState(false);
  const [otherErr, setOtherErr] = useState<string | null>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (otherOpen) otherInputRef.current?.focus();
  }, [otherOpen]);
  // Escape and an outside press close the input, not the dialog (the Modal's
  // own Escape listener is document-capture; this one is window-capture).
  useDismiss(otherOpen, () => setOtherOpen(false), [otherInputRef]);

  async function addOther() {
    const value = otherRef.trim();
    if (!value || otherBusy) return;
    setOtherBusy(true);
    setOtherErr(null);
    try {
      const r = await api.addRepo(value);
      if (!r) {
        // The mock registers nothing; closing is its no-op.
        setOtherOpen(false);
        return;
      }
      noteRepoChoice(r.id);
      setRepoChoices((c) => ({ ...c, [r.id]: Date.now() }));
      setAdded((a) => [...a.filter((x) => x.id !== r.id), r]);
      setRepoId(r.id);
      setOtherOpen(false);
      setOtherRef("");
      if (promptPrs(prompt, prsOf(state.prs, r), r.fullName).length > 0) return;
      const def = worktreeDefault(r);
      if (def !== null) {
        setWorktree(def);
        setWtText("");
      }
    } catch (e) {
      setOtherErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOtherBusy(false);
    }
  }

  // Remember everything as it changes, so Cancel keeps it too.
  const draftImages = images.saved();
  const draftImagesKey = JSON.stringify(draftImages);
  useEffect(() => {
    // A PR the prompt ticked off is not a preference for next time.
    savePrefs({ provider, where, repoId, worktree: worktree || wtFromPrompt, path, big, perProvider, draft: prompt, draftImages });
  }, [provider, where, repoId, worktree, wtFromPrompt, path, big, perProvider, prompt, draftImagesKey]);
  // Typing `new` is the same as ticking the box again.
  useEffect(() => {
    if (!worktree && wt.kind === "new") {
      setWtText("");
      setWorktree(true);
    }
  }, [worktree, wt.kind]);
  const skills = useMemo(() => skillsFor(state.skills, provider, where === "repo" ? repo : null), [state.skills, provider, where, repo]);
  const folders = useMemo(() => recentFolders(state.sessions), [state.sessions]);

  const noEligible = !manual && placement?.mode === "none";
  const whereOk = where === "repo" ? !!repoId : path.trim().length > 0;

  // The pick that just ran becomes the repo's remembered default — but only a
  // choice the user made: a PR named in the prompt put the session in a
  // worktree on its own, and a branch or PR picked in the field runs where
  // that ref lives, which is not where sessions "usually" run either.
  function rememberRepoDefault() {
    if (where !== "repo" || !repoId || wtFromPrompt) return;
    if (!worktree && wt.kind !== "main") return;
    void api.setRepoWorktreeDefault(repoId, worktree);
  }
  // Later, the balancer places it when it starts: no account with room now is
  // not a reason not to schedule it.
  const whenOk = mode === "now" || (!!when.trim() && !("error" in parseWhen(when)));
  const canSubmit =
    whereOk && !busy && installed.includes(provider) && (mode === "now" ? !noEligible : whenOk && prompt.trim().length > 0);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    let text: string;
    try {
      text = (await images.resolve(prompt)).trim();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    const input: NewSessionInput = {
      provider,
      ...(where === "path"
        ? { cwd: path.trim() }
        : worktree || wt.kind === "new"
          ? { repoId, worktree: true }
          : wt.kind === "main"
            ? { repoId, worktree: false }
            : { repoId, branch: wt.branch, ...(wt.kind === "pr" ? { pr: wt.number } : {}) }),
      ...(text ? { prompt: text } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      big,
      accountId,
    };
    try {
      if (mode === "schedule") {
        const sc = await api.createSchedule({ when, spec: input });
        savePrefs({ provider, where, repoId, worktree: worktree || wtFromPrompt, path, big, perProvider });
        rememberRepoDefault();
        onScheduled(sc);
        return;
      }
      const r = await api.createSession(input);
      savePrefs({ provider, where, repoId, worktree: worktree || wtFromPrompt, path, big, perProvider });
      rememberRepoDefault();
      onCreated(r.session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const defaultModel = state.settings.models[provider] ? `Default (${state.settings.models[provider]})` : `${PROVIDER_LABEL[provider]}'s default`;

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
          } else if (e.altKey && /^[1-4]$/.test(e.key)) {
            // Alt+1..4 picks the agent without leaving the prompt.
            const p = PROVIDERS[Number(e.key) - 1];
            if (p && installed.includes(p)) {
              e.preventDefault();
              setProvider(p);
            }
          }
        }}
      >
        <div className="ns-top">
          <div className="field">
            <span className="field-label" id="ns-agent">
              Agent
            </span>
            <div className="seg ns-providers" role="group" aria-labelledby="ns-agent">
              {PROVIDERS.map((p, i) => {
                const info = state.providers.find((x) => x.id === p);
                const ok = !!info?.installed;
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={provider === p}
                    disabled={!ok}
                    title={ok ? `${PROVIDER_LABEL[p]} ${info?.version ?? ""} · Alt+${i + 1}`.trim() : `${PROVIDER_LABEL[p]} is not installed`}
                    onClick={() => setProvider(p)}
                  >
                    <span className={`ns-pdot prov-${p}`} aria-hidden="true" />
                    {PROVIDER_LABEL[p]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field ns-where-field">
            <span className="field-label" id="ns-where">
              Where
            </span>
            <div className="seg" role="group" aria-labelledby="ns-where">
              <button type="button" aria-pressed={where === "repo"} disabled={state.repos.length === 0} onClick={() => setWhere("repo")}>
                <Icon.branch size={13} />
                Repository
              </button>
              <button type="button" aria-pressed={where === "path"} onClick={() => setWhere("path")}>
                <Icon.folder size={13} />
                Folder
              </button>
            </div>
          </div>
        </div>

        {where === "repo" ? (
          <>
            <div className="ns-where">
              <select aria-label="Repository" value={repoId} onChange={(e) => pickRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName} — {r.fullName ?? r.ref}
                  </option>
                ))}
                <option value={OTHER}>Select other…</option>
              </select>
              <WorktreeField on={worktree} onToggle={setWorktree} text={wtText} onText={setWtText} prs={repoPrs} />
            </div>
            {otherOpen ? (
              <>
                <input
                  ref={otherInputRef}
                  aria-label="Repository path or owner/repo slug"
                  className="mono"
                  placeholder="/path/to/repo or owner/repo"
                  value={otherRef}
                  disabled={otherBusy}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setOtherRef(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter would submit the whole dialog: here it registers
                    // the repo instead. Escape is useDismiss's.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addOther();
                    }
                  }}
                />
                {otherErr ? (
                  <p className="error-line" role="alert">
                    {otherErr}
                  </p>
                ) : null}
              </>
            ) : null}
            {!worktree ? (
              <p className="ns-wt-hint">
                {wtFromPrompt ? <span className="ns-tag">from the prompt</span> : null}
                {worktreeHint(wt, repo?.ref ?? null, repoPrs)}
              </p>
            ) : mentioned.length > 1 ? (
              <p className="ns-wt-hint">
                The prompt names {mentioned.length} PRs ({mentioned.map((n) => `#${n}`).join(", ")}), so it gets a new worktree; untick to pick one.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <input
              aria-label="Folder path"
              className="mono"
              placeholder="/home/you/code/project"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
              list="ns-folders"
            />
            <datalist id="ns-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </>
        )}

        <div className="field">
          <label className="field-head ns-prompt-head" htmlFor="ns-prompt">
            <span className="field-label">Prompt</span>
            <span className="field-hint">
              {mode === "schedule" ? "Needed to schedule." : "Optional."} <kbd>/</kbd> for skills{skills.length ? ` (${skills.length})` : ""}, paste images.
              <AttachButton a={images} />
              {prompt ? (
                <button type="button" className="ns-linkbtn" onClick={() => setPrompt("")}>
                  Clear
                </button>
              ) : null}
            </span>
          </label>
          <PromptBox id="ns-prompt" value={prompt} onChange={setPrompt} skills={skills} textareaRef={promptRef} attachments={images} />
        </div>

        <div className="field">
          <span className="field-label ns-label">Account</span>
          <AccountPicker
            accounts={accounts}
            allAccounts={state.accounts}
            value={accountId}
            onChange={(id) => setChoice({ accountId: id })}
            placement={placement}
            placing={placing}
            placeErr={placeErr}
            claimIdleMin={b.claimIdleMin}
          />
        </div>

        <div className="ns-row2">
          <div className="field">
            <label className="field-label ns-label" htmlFor="ns-model">
              Model
            </label>
            <div className="ns-model-row">
              <ModelPicker
                id="ns-model"
                models={models}
                value={model}
                onChange={(m) => setChoice({ model: m })}
                defaultLabel={defaultModel}
              />
              {efforts.length ? <EffortPicker levels={efforts} value={effort} onChange={(e) => setChoice({ effort: e })} /> : null}
            </div>
          </div>
          <label className="ns-big" data-on={big || undefined} title={`Claims ${b.claimBig}% of the account's weekly instead of ${b.claimNormal}%, so the balancer keeps room for a long run and steers other sessions elsewhere.`}>
            <input type="checkbox" checked={big} onChange={(e) => setBig(e.target.checked)} />
            <Icon.bolt size={13} />
            <span>
              <strong>Big session</strong>
              <span className="field-hint">
                Claims {b.claimBig}% of the weekly, not {b.claimNormal}%
              </span>
            </span>
          </label>
        </div>

        {mode === "schedule" ? <WhenField value={when} onChange={setWhen} inputRef={whenRef} /> : null}

        {error ? (
          <p className="error-line" role="alert">
            {error}
          </p>
        ) : null}

        <div className="modal-actions">
          <span className="ns-foot-hint faint">
            {mode === "schedule" && !prompt.trim() ? (
              "A scheduled session needs a prompt"
            ) : (
              <>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to {mode === "now" ? "start" : "schedule"}
              </>
            )}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <StartButton mode={mode} onMode={setMode} busy={busy} disabled={!canSubmit} />
        </div>
      </form>
    </Modal>
  );
}

/** Start, with a ▾ beside it for Schedule. */
function StartButton({
  mode,
  onMode,
  busy,
  disabled,
}: {
  mode: "now" | "schedule";
  onMode: (m: "now" | "schedule") => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [wrap, menu]);
  const style = useFloating(wrap, open, 200, 250, "end");
  const pick = (m: "now" | "schedule") => {
    onMode(m);
    setOpen(false);
  };
  return (
    <div className="ns-split" ref={wrap} data-busy={busy || undefined}>
      <Button type="submit" variant="primary" icon={mode === "now" ? Icon.play : Icon.clock} loading={busy} disabled={disabled}>
        {mode === "now" ? "Start" : "Schedule"}
      </Button>
      <button
        type="button"
        className="ns-split-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Start now or schedule for later"
        title="Start now or schedule for later"
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        <Icon.chevronDown size={12} />
      </button>
      {open ? (
        <div className="ns-split-menu" role="menu" ref={menu} style={style}>
          {(
            [
              ["now", Icon.play, "Start now", "Starts as soon as you click."],
              ["schedule", Icon.clock, "Schedule…", "Later, or every so often."],
            ] as const
          ).map(([m, Glyph, title, sub]) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={mode === m} onClick={() => pick(m)}>
              <Glyph size={14} />
              <span>
                <strong>{title}</strong>
                <span>{sub}</span>
              </span>
              <span className="ns-split-check">{mode === m ? <Icon.check size={13} /> : null}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One line under the worktree box: where the session will actually run. */
function worktreeHint(wt: ReturnType<typeof parseWorktreeRef>, repoPath: string | null, prs: readonly PrInfo[]): string {
  switch (wt.kind) {
    case "main":
    case "new":
      return `Runs in the main checkout${repoPath ? `, ${repoPath}` : ""}, on whatever branch it has out.`;
    case "pr":
      // `67` on the way to `6730` is not a claim about PR #67.
      if (!wt.pr && prs.some((p) => String(p.number).startsWith(String(wt.number)))) return "Pick a PR from the list, or type its whole number.";
      return wt.pr
        ? `PR #${wt.number}, ${wt.branch}: runs in the worktree that has it checked out, or a new one.`
        : `PR #${wt.number} is not among the open PRs; its head is fetched as ${wt.branch}.`;
    case "branch":
      return `Branch ${wt.branch}: runs in the worktree that has it checked out, or a new one.`;
  }
}
