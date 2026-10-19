import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, HubNodeView, ModelOption, Placement, PrInfo, ProviderId, Repo, Schedule } from "../../../src/core/types";
import { parseWhen } from "../../../src/core/schedule";
import { accountProvider } from "../../../src/core/providers/account";
import { api, type NewSessionInput } from "../api";
import { PROVIDER_LABEL, PROVIDERS } from "../bits";
import { AttachButton, useAttachments } from "../attachments";
import type { PromptHistoryEntry } from "../lib/prompthistory";
import { Button, Icon, Modal } from "../components";
import {
  forgetFolder,
  loadFolderChoices,
  loadPrefs,
  loadRepoChoices,
  noteFolderChoice,
  noteRepoChoice,
  parseWorktreeRef,
  promptPrs,
  promptProjects,
  prsOf,
  rankModels,
  recentFolders,
  reposByChoice,
  reposByRecency,
  saveFolderChoices,
  savePrefs,
  skillsFor,
  tidyFolderChoices,
  worktreeDefault,
  type NewSessionPrefs,
} from "../lib/newsession";
import { AccountPicker } from "./newsession/AccountPicker";
import { ModelPicker } from "./newsession/ModelPicker";
import { EffortPicker } from "./newsession/EffortPicker";
import { PromptBox } from "./newsession/PromptBox";
import { WorktreeField } from "./newsession/WorktreeField";
import { WherePicker } from "./newsession/WherePicker";
import { NodePicker } from "./newsession/NodePicker";
import { WhenField } from "./newsession/WhenField";
import { Dropdown } from "./newsession/Dropdown";
import { useDismiss, useFloating } from "./newsession/popover";
import { noteStarted } from "./session/started";
import "./newsession.css";

/**
 * Start a session: which CLI, where, what to do, on which model and account.
 * The prompt is the dialog; every other choice is a pill that opens a menu —
 * agent and where above it, account, model and effort inside its bottom edge.
 * Every choice is remembered (lib/newsession.ts), so the next session starts
 * the way the last one did; the account menu carries the balancer's
 * reasoning, so "Auto" is never a black box.
 */
export function NewSession({
  state,
  project = null,
  onClose,
  onCreated,
  onScheduled,
}: {
  state: AppState;
  /** The selected project: its dialog remembers on its own and starts in its repo. */
  project?: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
  onScheduled: (s: Schedule) => void;
}) {
  const [prefs] = useState<NewSessionPrefs>(() => loadPrefs(project));
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
  // The repo's default from Settings, over whatever the last session did.
  const [worktree, setWorktree] = useState(() => {
    const r = knownRepos.find((x) => x.id === repoId);
    return (r && worktreeDefault(r)) ?? prefs.worktree ?? true;
  });
  /** With "New worktree" off: blank (main checkout), `new`, or a PR. Not
   *  remembered — a PR is a one-off. */
  const [wtText, setWtText] = useState("");
  const [path, setPath] = useState(prefs.path ?? "");
  const [prompt, setPrompt] = useState(prefs.draft ?? "");
  const [wherePicked, setWherePicked] = useState(prefs.wherePicked ?? false);
  // Closed sessions' too, which the board does not carry: from the server.
  const [history, setHistory] = useState<PromptHistoryEntry[]>([]);
  useEffect(() => {
    let live = true;
    api.prompts().then(
      (h) => live && setHistory(h),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  // On a hub, its joined nodes: a session in a repo may start on one (docs/hub.md).
  const [nodes, setNodes] = useState<HubNodeView[] | null>(null);
  const [node, setNode] = useState("");
  useEffect(() => {
    let live = true;
    api.hub().then(
      (h) => live && setNodes(h.role === "hub" ? (h.nodes ?? []) : null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const [perProvider, setPerProvider] = useState(prefs.perProvider ?? {});
  const [catalog, setCatalog] = useState<ModelOption[]>([]);
  /** Why the account's models could not be listed: the picker offers Default and typing one. */
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [catalogTry, setCatalogTry] = useState(0);
  // A model remembered from an earlier visit that the account no longer lists
  // (a plan without it, a retired id) runs as Default: the CLI would refuse
  // every turn. One picked or typed in this visit goes through as asked.
  const picked = perProvider[provider]?.model ?? "";
  const stale =
    picked !== "" &&
    picked === prefs.perProvider?.[provider]?.model &&
    catalog.length > 0 &&
    !catalog.some((m) => m.id === picked);
  const model = stale ? "" : picked;
  const accountId = perProvider[provider]?.accountId ?? "auto";
  const providerEfforts = state.providers.find((p) => p.id === provider)?.efforts ?? [];
  const setChoice = (patch: { model?: string; accountId?: string; effort?: string }) =>
    setPerProvider((p) => ({ ...p, [provider]: { ...p[provider], ...patch } }));

  const [placement, setPlacement] = useState<Placement | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
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

  const accounts = useMemo(() => state.accounts.filter((a) => a.provider === accountProvider(provider)), [state.accounts, provider]);
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
        .placement({ provider, ...(model ? { model } : {}) })
        .then((p) => !cancelled && setPlacement(p))
        .catch((e: unknown) => !cancelled && setPlaceErr(e instanceof Error ? e.message : String(e)))
        .finally(() => !cancelled && setPlacing(false));
    }, model ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [provider, model]);

  const manual = accountId !== "auto" ? accounts.find((a) => a.id === accountId) ?? null : null;
  // The account whose models to offer: the pin, else where Auto would go.
  const target = manual ?? accounts.find((a) => a.id === placement?.accountId) ?? accounts[0] ?? null;

  useEffect(() => {
    setCatalogErr(null);
    if (!target) return setCatalog([]);
    let cancelled = false;
    api.models(target.id, provider).then(
      (m) => !cancelled && setCatalog(m),
      (e: unknown) => {
        if (cancelled) return;
        setCatalog([]);
        setCatalogErr(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target?.id, provider, catalogTry]);

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
  }, [mentionedKey, repoId, where]);
  const wtFromPrompt = !worktree && autoWt.current !== null && wtText === autoWt.current;

  // Picking a repo sets the box to where that repo's sessions usually run —
  // only on the switch, so unticking it afterwards sticks. A PR the prompt
  // names wins: the effect above puts the session on it. Every pick is
  // remembered, so the list sorts by most recently chosen next time.
  function pickRepo(id: string) {
    setWherePicked(true);
    selectRepo(id);
  }

  function selectRepo(id: string) {
    setWhere("repo");
    noteRepoChoice(id);
    setRepoChoices((c) => ({ ...c, [id]: Date.now() }));
    setRepoId(id);
    if (repoId !== id || where !== "repo") setWtText("");
    const next = knownRepos.find((r) => r.id === id);
    if (!next || promptPrs(prompt, prsOf(state.prs, next), next.fullName).length > 0) return;
    const def = worktreeDefault(next);
    if (def === null) return;
    setWorktree(def);
    setWtText("");
  }

  // A folder picked in the Where menu. It is remembered once a session
  // starts there (submit), so a guess that went nowhere is not kept.
  const [folderChoices, setFolderChoices] = useState<Record<string, number>>(loadFolderChoices);
  function pickFolder(p: string) {
    setWherePicked(true);
    setWhere("path");
    setPath(p);
  }
  function dropFolder(p: string) {
    forgetFolder(p);
    setFolderChoices(loadFolderChoices);
  }

  // Once per opening, the server says which remembered folders are still
  // folders: `~/x` and `/home/me/x` become one, and the rest leave the menu
  // (and the choices, for good).
  useEffect(() => {
    const paths = Object.keys(folderChoices);
    if (paths.length === 0) return;
    let live = true;
    api
      .resolveDirs(paths)
      .then((r) => {
        if (!live || !r) return;
        const tidy = tidyFolderChoices(loadFolderChoices(), r);
        saveFolderChoices(tidy);
        setFolderChoices(tidy);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // "Add repository …" in the Where menu: register a repo the list does not
  // know — a local path or an owner/repo slug — and run against it from now
  // on. The server resolves the branch and the GitHub slug, so a slug that is
  // not local yet clones first and can take a while.
  const [otherBusy, setOtherBusy] = useState(false);
  const [otherErr, setOtherErr] = useState<string | null>(null);

  async function addOther(value: string) {
    if (!value || otherBusy) return;
    setWherePicked(true);
    setOtherBusy(true);
    setOtherErr(null);
    try {
      const r = await api.addRepo(value);
      // The mock registers nothing.
      if (!r) return;
      noteRepoChoice(r.id);
      setRepoChoices((c) => ({ ...c, [r.id]: Date.now() }));
      setAdded((a) => [...a.filter((x) => x.id !== r.id), r]);
      setRepoId(r.id);
      setWhere("repo");
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
    savePrefs({ provider, where, repoId, worktree: worktree || wtFromPrompt, path, perProvider, wherePicked, draft: prompt, draftImages }, project);
  }, [provider, where, repoId, worktree, wtFromPrompt, path, perProvider, wherePicked, prompt, draftImagesKey]);
  // Typing `new` is the same as ticking the box again.
  useEffect(() => {
    if (!worktree && wt.kind === "new") {
      setWtText("");
      setWorktree(true);
    }
  }, [worktree, wt.kind]);
  const skills = useMemo(() => skillsFor(state.skills, provider, where === "repo" ? repo : null), [state.skills, provider, where, repo]);
  const folders = useMemo(
    () => recentFolders(folderChoices, knownRepos.map((r) => r.ref), 12),
    [folderChoices, knownRepos],
  );

  const projectMatches = useMemo(
    () => promptProjects(prompt, knownRepos, recentFolders(folderChoices, knownRepos.map((r) => r.ref), Infinity)),
    [prompt, knownRepos, folderChoices],
  );
  const promptProject = projectMatches.length === 1 ? projectMatches[0] : null;
  useEffect(() => {
    if (wherePicked || !promptProject) return;
    if (promptProject.kind === "repo") selectRepo(promptProject.repo.id);
    else {
      setWhere("path");
      setPath(promptProject.path);
    }
  }, [promptProject?.key, wherePicked]);
  useEffect(() => {
    if (!prompt.trim()) setWherePicked(false);
  }, [prompt]);

  // Elsewhere, that machine's balancer places it, among the accounts it lends.
  const placedElsewhere = !!nodes && where === "repo" && mode === "now" && node !== "";
  const noEligible = !manual && !placedElsewhere && placement?.mode === "none";
  const whereOk = where === "repo" ? !!repoId : path.trim().length > 0;

  // Later, the balancer places it when it starts: no account with room now is
  // not a reason not to schedule it.
  const parsedWhen = mode === "schedule" && when.trim() ? parseWhen(when) : null;
  /** What stops Start, said on its tooltip and, if you press it anyway, under the form. */
  const whyNot = !installed.includes(provider)
    ? `${PROVIDER_LABEL[provider]} is not installed on this machine`
    : !whereOk
      ? where === "repo" ? "Pick a repository" : "Give it a folder to work in"
      : mode === "now"
        ? noEligible ? placement?.why || `No ${PROVIDER_LABEL[provider]} account has room` : null
        : !when.trim()
          ? "Say when to start it"
          : parsedWhen && "error" in parsedWhen
            ? parsedWhen.error
            : !prompt.trim() ? "A scheduled session needs a prompt" : null;
  const canSubmit = !busy && !whyNot;

  /** Start was pressed while something stopped it: say what, until it no longer does. */
  const [tried, setTried] = useState(false);

  async function submit() {
    if (whyNot) setTried(true);
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
      // An account is this machine's; a node picks among its own.
      ...(placedElsewhere ? { node } : { accountId }),
    };
    try {
      if (mode === "schedule") {
        const sc = await api.createSchedule({ when, spec: input });
        savePrefs({ provider, where, repoId, worktree: worktree || wtFromPrompt, path, perProvider }, project);
        onScheduled(sc);
        return;
      }
      const r = await api.createSession(input);
      noteStarted(r.session);
      if (where === "path") noteFolderChoice(r.session.cwd ?? path.trim());
      savePrefs({ provider, where, repoId, worktree: worktree || wtFromPrompt, path, perProvider }, project);
      onCreated(r.session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const hint = where === "repo" && !worktree ? worktreeHint(wt, repo?.ref ?? null, repoPrs) : undefined;
  const wtNote =
    where === "repo" && worktree && mentioned.length > 1
      ? `The prompt names ${mentioned.length} PRs (${mentioned.map((n) => `#${n}`).join(", ")}), so it gets a new worktree.`
      : undefined;

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
          } else if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
            // Alt+1… picks the agent, in the list's order, without leaving the prompt.
            const p = PROVIDERS[Number(e.code.slice(5)) - 1];
            if (p && installed.includes(p)) {
              e.preventDefault();
              setProvider(p);
            }
          }
        }}
      >
        <div className="ns-row">
          <AgentPicker state={state} value={provider} onChange={setProvider} />
          <WherePicker
            repos={repos}
            folders={folders}
            where={where}
            repoId={repoId}
            path={path}
            adding={otherBusy}
            onRepo={pickRepo}
            onFolder={pickFolder}
            onForgetFolder={dropFolder}
            onAddRepo={(v) => void addOther(v)}
          />
          {nodes && nodes.some((n) => n.approvedAt !== null) && where === "repo" && mode === "now" ? <NodePicker nodes={nodes} value={node} onChange={setNode} /> : null}
          {where === "repo" && repo ? (
            <WorktreeField on={worktree} onToggle={setWorktree} text={wtText} onText={setWtText} prs={repoPrs} hint={hint} fromPrompt={wtFromPrompt} note={wtNote} />
          ) : null}
          <StartButton mode={mode} onMode={setMode} busy={busy} disabled={!canSubmit} why={whyNot} />
        </div>

        {!wherePicked && projectMatches.length > 0 ? (
          <p className="ns-project-hint" role="status">
            {promptProject
              ? "Project selected from your prompt. Choose Where to override."
              : "Your prompt names several projects. Choose Where to pick the one to work in."}
          </p>
        ) : null}

        <PromptBox
          id="ns-prompt"
          value={prompt}
          onChange={setPrompt}
          skills={skills}
          history={history}
          textareaRef={promptRef}
          attachments={images}
          onSubmit={() => void submit()}
          footer={
            <div className="ns-bar">
              <AttachButton a={images} />
              <AccountPicker
                pill
                accounts={accounts}
                allAccounts={state.accounts}
                value={accountId}
                onChange={(id) => setChoice({ accountId: id })}
                placement={placement}
                placing={placing}
                placeErr={placeErr}
              />
              <ModelPicker
                models={models}
                value={model}
                onChange={(m) => setChoice({ model: m })}
                defaultId={state.settings.models[provider] || null}
                agent={PROVIDER_LABEL[provider]}
              />
              {efforts.length ? <EffortPicker levels={efforts} value={effort} onChange={(e) => setChoice({ effort: e })} /> : null}
            </div>
          }
        />

        {mode === "schedule" ? <WhenField value={when} onChange={setWhen} inputRef={whenRef} /> : null}

        {catalogErr ? (
          <p className="ns-foot-hint faint" role="status">
            Could not list {PROVIDER_LABEL[provider]}&apos;s models: {catalogErr}.{" "}
            <button type="button" className="linkish" onClick={() => setCatalogTry((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : null}

        {otherErr || error || (tried && whyNot) ? (
          <p className="error-line" role="alert">
            {otherErr ? `Could not add the repository: ${otherErr}` : error ?? `${whyNot}.`}
          </p>
        ) : null}

        {mode === "schedule" && !prompt.trim() ? <span className="ns-foot-hint faint">A scheduled session needs a prompt</span> : null}
      </form>
    </Modal>
  );
}

/** Which CLI: the installed ones, with their versions. */
function AgentPicker({ state, value, onChange }: { state: AppState; value: ProviderId; onChange: (p: ProviderId) => void }) {
  return (
    <Dropdown
      label="Agent"
      width={220}
      selected={value}
      onPick={(k) => onChange(k as ProviderId)}
      trigger={
        <>
          <span className={`ns-pdot prov-${value}`} aria-hidden="true" />
          <span className="ns-pill-text">{PROVIDER_LABEL[value]}</span>
        </>
      }
      items={PROVIDERS.map((p, i) => {
        const info = state.providers.find((x) => x.id === p);
        return {
          key: p,
          disabled: !info?.installed,
          children: (
            <>
              <span className={`ns-pdot prov-${p}`} aria-hidden="true" />
              <span className="ns-item-main">{PROVIDER_LABEL[p]}</span>
              <span className="ns-item-sub" title={info?.installed ? `Alt+${i + 1}` : undefined}>
                {info?.installed ? (info.version ?? "") : "not installed"}
              </span>
            </>
          ),
        };
      })}
    />
  );
}

/** Start, with a ▾ beside it for Schedule. */
function StartButton({
  mode,
  onMode,
  busy,
  disabled,
  why,
}: {
  mode: "now" | "schedule";
  onMode: (m: "now" | "schedule") => void;
  busy: boolean;
  disabled: boolean;
  why: string | null;
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
    <div className="ns-split" ref={wrap} data-busy={busy || undefined} title={why ?? undefined}>
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
