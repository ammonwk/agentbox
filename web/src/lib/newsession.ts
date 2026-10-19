/** The new-session dialog's memory, model ranking and `/skill` completion.
 *  Pure, apart from the two localStorage calls. */

import type { ModelOption, PrInfo, ProviderId, Repo, Session, SkillInfo, SkillSource } from "../../../src/core/types";
import type { SavedAttachment } from "../attachments";
import { prRefs } from "./prlinks";

// ------------------------------------------------------------------ prefs

/**
 * Every choice the dialog remembers. Written on each change, not on submit,
 * so a cancelled dialog reopens the way it was left. The account and model
 * are per provider: a codex model means nothing to claude.
 */
export interface NewSessionPrefs {
  provider?: ProviderId;
  where?: "repo" | "path";
  repoId?: string;
  /** A manual Where choice holds while the saved draft is edited. */
  wherePicked?: boolean;
  worktree?: boolean;
  path?: string;
  perProvider?: Partial<Record<ProviderId, { accountId?: string; model?: string; effort?: string }>>;
  /** The unsent prompt; cleared when a session starts. */
  draft?: string;
  /** Images already uploaded for the draft. */
  draftImages?: SavedAttachment[];
}

const PREFS_KEY = "agentbox.newSession";
/** Your personal defaults from the agentbox cloud, kept here by the Team
 *  page while you are signed in (lib/cloud.ts): what a browser that has not
 *  picked anything yet starts with. */
export const CLOUD_DEFAULTS_KEY = "agentbox.cloud.defaults";

/** Each project's dialog remembers on its own, under its own key, so a draft
 *  for one is not what another opens on; All projects is the key as it was,
 *  so what was there stays there. */
const prefsKey = (project: string | null) => (project ? `${PREFS_KEY}.project.${project}` : PREFS_KEY);

/** A project's dialog starts in that project's repo, with the provider and
 *  per-provider choices All projects has, until a Where is picked by hand or
 *  a draft is left. */
export function loadPrefs(project: string | null = null): NewSessionPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(project));
    if (project && !raw) {
      const global = loadPrefs();
      return withCloudDefaults({ provider: global.provider, perProvider: global.perProvider, where: "repo", repoId: project });
    }
    const v = JSON.parse(raw ?? "{}") as unknown;
    const prefs = v && typeof v === "object" ? (v as NewSessionPrefs) : {};
    if (project && !prefs.wherePicked && !prefs.draft?.trim() && !prefs.draftImages?.length) {
      return withCloudDefaults({ ...prefs, where: "repo", repoId: project });
    }
    return withCloudDefaults(prefs);
  } catch {
    return {};
  }
}

function readCloudDefaults(): { provider?: string; models?: Record<string, string> } | null {
  try {
    const v = JSON.parse(localStorage.getItem(CLOUD_DEFAULTS_KEY) ?? "null") as unknown;
    return v && typeof v === "object" ? (v as { provider?: string; models?: Record<string, string> }) : null;
  } catch {
    return null;
  }
}

/** What was picked in this browser wins; the defaults fill what was not. A
 *  model the account's catalog does not list still runs as Default. */
function withCloudDefaults(local: NewSessionPrefs): NewSessionPrefs {
  const d = readCloudDefaults();
  if (!d) return local;
  const perProvider = { ...local.perProvider };
  for (const [p, model] of Object.entries(d.models ?? {})) {
    const id = p as ProviderId;
    if (typeof model === "string" && model && !perProvider[id]?.model) perProvider[id] = { ...perProvider[id], model };
  }
  return { ...local, provider: local.provider ?? (d.provider as ProviderId | undefined), perProvider };
}

export function savePrefs(p: NewSessionPrefs, project: string | null = null): void {
  try {
    localStorage.setItem(prefsKey(project), JSON.stringify(p));
  } catch {
    // private mode or full: forgetting is fine
  }
}

// ----------------------------------------------------------------- models

export interface ModelChoice extends ModelOption {
  /** Last activity of a session on this model and account; null if never. */
  lastUsedAt: number | null;
}

/**
 * What the model picker offers: models this provider has run, most recent
 * first, then the rest of the account's catalog newest release first (the
 * server sends it in that order). Recency is per provider, not per account:
 * every subscription of one CLI runs the same models, and the account Auto
 * picks is often not the one you last used. A model a past session used that
 * the catalog does not know is still offered — it worked once.
 *
 * Only sessions agentbox started count. The board also shows sessions some
 * script ran through the SDK on its own pinned model (a bot's scheduled
 * report on an old Opus), and those say nothing about what you pick.
 */
export function rankModels(
  catalog: readonly ModelOption[],
  sessions: readonly Pick<Session, "provider" | "model" | "lastActivityAt" | "origin">[],
  provider: ProviderId,
): ModelChoice[] {
  const used = new Map<string, number>();
  for (const s of sessions) {
    if (s.provider !== provider || !s.model || s.origin !== "agentbox") continue;
    used.set(s.model, Math.max(used.get(s.model) ?? 0, s.lastActivityAt));
  }
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const recent: ModelChoice[] = [...used].sort((a, b) => b[1] - a[1]).map(([id, at]) => {
    const cat = byId.get(id);
    return { ...cat, id, label: cat?.label ?? modelName(id), releasedAt: cat?.releasedAt ?? null, lastUsedAt: at };
  });
  const rest = catalog.filter((m) => !used.has(m.id)).map((m) => ({ ...m, lastUsedAt: null }));
  return [...recent, ...rest];
}

/** A name for a model the catalog has not heard of yet: `claude-opus-5-5`
 *  reads "Claude Opus 5.5". Anything else stays its id. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `Claude ${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Case-insensitive, on id or label; every word must hit. Some catalogs are
 *  hundreds of rows (devin bakes effort into the model id, so every level is
 *  its own entry), so the answer is capped — `hidden` counts what the cap
 *  dropped, for the "keep typing" hint. */
export function filterModels(models: readonly ModelChoice[], query: string, limit = 150): { rows: ModelChoice[]; hidden: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all =
    words.length === 0
      ? [...models]
      : models.filter((m) => {
          const hay = `${m.id} ${m.label}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
  return { rows: all.slice(0, limit), hidden: Math.max(0, all.length - limit) };
}

// ----------------------------------------------------------------- skills

/** Where each CLI looks for skills; null means we do not know, so offer all. */
const SKILL_SOURCES: Record<ProviderId, readonly SkillSource[] | null> = {
  claude: ["project", "global"],
  codex: ["codex", "agents"],
  omp: ["project", "omp", "global", "agents"],
  devin: null,
  opencode: null,
  muse: null,
};

/** The registered repo a session runs in (a worktree's `repoRoot` is its main
 *  checkout, resolved by the server; `ref` may be a GitHub slug). The longest
 *  path wins, so a registered repo inside another is the one a session in it
 *  belongs to. A prefix only counts when the session has no `repoRoot`: a
 *  worktree's root must equal its repo's checkout, not sit under it. */
export function repoOfSession(repos: readonly Repo[], s: Pick<Session, "repoRoot" | "cwd">): Repo | null {
  const root = s.repoRoot ?? s.cwd;
  // A nested registered repository wins over its parent. Worktrees use the
  // server-resolved common checkout, never a display name or branch guess.
  return [...repos].sort((a, b) => (b.checkoutRoot ?? b.ref).length - (a.checkoutRoot ?? a.ref).length).find((r) => {
    const path = r.checkoutRoot ?? r.ref;
    return root === path || (!s.repoRoot && path.startsWith("/") && root.startsWith(`${path}/`));
  }) ?? null;
}

/** The skills a session of `provider` in `repo` could run, first root wins. */
export function skillsFor(skills: readonly SkillInfo[], provider: ProviderId, repo: Repo | null): SkillInfo[] {
  const sources = SKILL_SOURCES[provider];
  const seen = new Set<string>();
  return skills.filter((s) => {
    if (sources && !sources.includes(s.source)) return false;
    if (s.source === "project" && s.repo && (!repo || (s.repo !== repo.ref && s.repo !== repo.displayName))) return false;
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

/** The `/partial` being typed at the caret, if any: a slash at the start of
 *  the text or after whitespace, then name characters up to the caret. */
export function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/([\w:.-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Name prefix first, then name contains, then description contains. */
export function matchSkills(skills: readonly SkillInfo[], query: string, limit = 8): SkillInfo[] {
  const q = query.toLowerCase();
  const rank = (s: SkillInfo) => {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (s.description.toLowerCase().includes(q)) return 2;
    return 3;
  };
  return skills
    .map((s) => ({ s, r: rank(s) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

/** Replace the token with `/name ` and put the caret after the space. */
export function completeSlash(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const insert = `/${name} `;
  const after = text.slice(caret).replace(/^[\w:.-]*\s?/, "");
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

// --------------------------------------------------------------- worktree

/**
 * What the worktree box means once "New worktree" is off:
 *   - blank: the repo's main checkout;
 *   - `new`: back to a fresh worktree;
 *   - `6729`, `#6729` or a PR URL: that PR's branch — the one we know from the
 *     open-PR list, or `pr-6729` fetched from `pull/6729/head` when it is not
 *     in the list;
 *   - anything else: a branch by name.
 */
export type WorktreeChoice =
  | { kind: "main" }
  | { kind: "new" }
  | { kind: "pr"; number: number; branch: string; pr: PrInfo | null }
  | { kind: "branch"; branch: string };

export function parseWorktreeRef(text: string, prs: readonly PrInfo[]): WorktreeChoice {
  const t = text.trim();
  if (!t) return { kind: "main" };
  if (t.toLowerCase() === "new") return { kind: "new" };
  const n = /^(?:#|pr\s*#?)?(\d+)$/i.exec(t)?.[1] ?? /\/pull\/(\d+)/.exec(t)?.[1];
  if (n) {
    const number = Number(n);
    const pr = prs.find((p) => p.number === number) ?? null;
    return { kind: "pr", number, branch: pr?.headRef ?? `pr-${number}`, pr };
  }
  return { kind: "branch", branch: t };
}

/** `[Image #1]`, or `[Image #1: /path]` once sent (attachments.tsx): its `#1`, bracket to bracket. */
const IMAGE_TOKEN = /^\[Image #\d+[\]:]/;

/**
 * The PRs a prompt names, once each, in order: `PR 6759`, a pull URL of this
 * repo, or `#6759` or a bare number that is one of the repo's open PRs — and
 * that last only when the number has four digits or more, or the prompt says
 * "PR" somewhere.
 *
 * Stricter than the links in agent output (prlinks.ts), because this one acts:
 * it picks the branch the session starts on. Issues share PRs' numbering, so
 * "read issue #6724" is not a PR, and a `#` alone is not enough to guess one —
 * a wrong guess fails the start on a branch that does not exist. A short
 * number is a count, a step or a list item far more often than a PR: a repo
 * whose PR 1 is still open would otherwise start every prompt with a `#1` in
 * it there. And a pasted image's `[Image #1]` is the dialog's own token,
 * never a reference.
 */
export function promptPrs(text: string, prs: readonly PrInfo[], repoSlug: string | null): number[] {
  const out: number[] = [];
  const add = (n: number) => {
    if (!out.includes(n)) out.push(n);
  };
  const found: { at: number; n: number }[] = [];
  for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
    if (!repoSlug || m[1]!.toLowerCase() === repoSlug.toLowerCase()) found.push({ at: m.index, n: Number(m[2]) });
  }
  const known = new Set(prs.map((p) => p.number));
  const saysPr = /(?<![\p{L}\p{N}_])(?:PRs?|pull requests?)(?![\p{L}\p{N}_])/iu.test(text);
  for (const r of prRefs(text)) {
    if (IMAGE_TOKEN.test(text.slice(Math.max(0, r.start - 7), r.end + 1))) continue;
    if (r.repo && r.repo.toLowerCase() !== repoSlug?.toLowerCase()) continue;
    const explicit = /^pr/i.test(text.slice(r.start, r.end));
    const before = text.slice(Math.max(0, r.start - 16), r.start);
    if (/\b(issues?|tickets?|bugs?|tasks?|stor(y|ies))\s*$/i.test(before)) continue;
    if (!explicit && (!known.has(r.number) || (r.number < 1000 && !saysPr))) continue;
    found.push({ at: r.start, n: r.number });
  }
  for (const f of found.sort((a, b) => a.at - b.at)) add(f.n);
  return out;
}

/** The open PRs of one repo. */
/**
 * Where a session in this repo starts, applied when the repo is picked: the
 * repo's default from Settings (repos.worktree_default). Null leaves the box
 * as it is.
 */
export function worktreeDefault(repo: Pick<Repo, "worktreeDefault">): boolean | null {
  return repo.worktreeDefault;
}

export function prsOf(prs: readonly PrInfo[], repo: Repo | null): PrInfo[] {
  if (!repo?.fullName) return [];
  return prs.filter((p) => p.repo === repo.fullName);
}

/** Digits match the number's start; words match title, branch or author. */
export function matchPrs(prs: readonly PrInfo[], query: string, limit = 8): PrInfo[] {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  if (!q) return prs.slice(0, limit);
  const out = /^\d+$/.test(q)
    ? prs.filter((p) => String(p.number).startsWith(q))
    : prs.filter((p) => `${p.title} ${p.headRef} ${p.author}`.toLowerCase().includes(q));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- choices

const CHOICES_KEY = "agentbox.repoChoices";

/** Repo id → when the dialog last picked it. Its own key, not a prefs field:
 *  it is written on every pick, while the prefs are rewritten on every
 *  keystroke, and one clobbering the other would lose choices. */
export function loadRepoChoices(): Record<string, number> {
  return loadChoices(CHOICES_KEY);
}

export function noteRepoChoice(id: string, at = Date.now()): void {
  const choices = loadChoices(CHOICES_KEY);
  choices[id] = at;
  saveChoices(CHOICES_KEY, choices);
}

function loadChoices(key: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(v)) if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
    return out;
  } catch {
    return {};
  }
}

function saveChoices(key: string, choices: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(choices));
  } catch {
    // private mode or full: forgetting is fine
  }
}

/** Repos picked before, most recently chosen first; never-chosen ones keep
 *  the order they came in (the caller's session-activity recency). */
export function reposByChoice(repos: readonly Repo[], choices: Record<string, number>): Repo[] {
  return repos
    .map((r, i) => ({ r, at: choices[r.id] ?? 0, i }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .map((x) => x.r);
}

// ------------------------------------------------------------------ where

export type PromptProject =
  | { key: string; kind: "repo"; repo: Repo }
  | { key: string; kind: "path"; path: string };

/** Whole project names only: mentioning agentbox-cloud must not choose agentbox. */
export function promptProjects(text: string, repos: readonly Repo[], folders: readonly string[]): PromptProject[] {
  const targets: { project: PromptProject; names: string[] }[] = repos.map((repo) => ({
    project: { key: `repo:${repo.id}`, kind: "repo", repo },
    names: [repo.displayName, repo.ref, repo.fullName ?? "", repo.fullName?.split("/").pop() ?? "", ...projectFolderNames(repo.ref)],
  }));
  for (const path of new Set(folders)) {
    if (repos.some((r) => r.ref === path)) continue;
    targets.push({ project: { key: `path:${path}`, kind: "path", path }, names: [path, path.replace(/\/+$/, "").split("/").pop() ?? ""] });
  }
  const matches: { project: PromptProject; start: number; end: number; priority: number }[] = [];
  for (const { project, names } of targets) {
    for (const name of new Set(names.filter(Boolean))) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "giu");
      const priority = project.kind === "repo"
        ? [project.repo.displayName, project.repo.ref, project.repo.ref.split("/").pop()].includes(name) ? 2 : 1
        : 0;
      for (const m of text.matchAll(pattern)) matches.push({ project, start: m.index, end: m.index + m[0].length, priority });
    }
  }
  // A full path or owner/repo is more specific than a name inside it.
  const specific = matches.filter((m) => !matches.some((other) =>
    other.start <= m.start && other.end >= m.end &&
    (other.end - other.start > m.end - m.start || other.priority > m.priority),
  ));
  return [...new Map(specific.map((m) => [m.project.key, m.project])).values()];
}

function projectFolderNames(path: string): string[] {
  const parts = path.replace(/\/+$/, "").split("/");
  const name = parts.pop() ?? "";
  const parent = parts.pop();
  return parent && name.toLowerCase() === `${parent.toLowerCase()}-dev` ? [name, parent] : [name];
}

/** Repos with the most recently active session first; never-used ones keep
 *  their registration order at the end. */
export function reposByRecency(repos: readonly Repo[], sessions: readonly Pick<Session, "repoRoot" | "cwd" | "lastActivityAt">[]): Repo[] {
  const last = new Map<string, number>();
  for (const r of repos) {
    for (const s of sessions) {
      const root = s.repoRoot ?? s.cwd;
      if (root === r.ref || root.startsWith(`${r.ref}/`)) last.set(r.id, Math.max(last.get(r.id) ?? 0, s.lastActivityAt));
    }
  }
  return repos
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (last.get(b.r.id) ?? 0) - (last.get(a.r.id) ?? 0) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * The Where menu's folders, most recent first: only the ones picked in the
 * dialog (`chosen`, path → when). Sessions do not feed it — a folder an agent
 * happened to run in is not somewhere you chose. A registered repo's checkout
 * is left out: the repo stands for it.
 */
export function recentFolders(
  chosen: Record<string, number>,
  repoRefs: readonly string[] = [],
  limit = 12,
): string[] {
  return Object.entries(chosen)
    .filter(([p]) => !repoRefs.includes(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
}

const FOLDERS_KEY = "agentbox.folderChoices";

/** Folder → when the dialog last picked it; like the repo choices. */
export function loadFolderChoices(): Record<string, number> {
  return loadChoices(FOLDERS_KEY);
}

export function noteFolderChoice(path: string, at = Date.now()): void {
  const choices = loadChoices(FOLDERS_KEY);
  choices[path] = at;
  saveChoices(FOLDERS_KEY, choices);
}

/**
 * The choices once the server has said where each one is (`resolved`: path →
 * absolute, or null when it is not a folder): `~/x` and `/home/me/x` become
 * one entry, and a path that is not a folder goes.
 */
export function tidyFolderChoices(
  choices: Record<string, number>,
  resolved: Record<string, string | null>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, at] of Object.entries(choices)) {
    const abs = p in resolved ? resolved[p] : p;
    if (abs) out[abs] = Math.max(out[abs] ?? 0, at);
  }
  return out;
}

export function saveFolderChoices(choices: Record<string, number>): void {
  saveChoices(FOLDERS_KEY, choices);
}

/** Out of the menu until the dialog starts a session there again. */
export function forgetFolder(path: string): void {
  const choices = loadChoices(FOLDERS_KEY);
  delete choices[path];
  saveChoices(FOLDERS_KEY, choices);
}
