/** The new-session dialog's memory, model ranking and `/skill` completion.
 *  Pure, apart from the two localStorage calls. */

import type { ModelOption, PrInfo, ProviderId, Repo, Session, SkillInfo, SkillSource } from "../../../src/core/types";

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
  worktree?: boolean;
  path?: string;
  big?: boolean;
  perProvider?: Partial<Record<ProviderId, { accountId?: string; model?: string }>>;
  /** The unsent prompt; cleared when a session starts. */
  draft?: string;
}

const PREFS_KEY = "agentbox.newSession";

export function loadPrefs(): NewSessionPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as NewSessionPrefs) : {};
  } catch {
    return {};
  }
}

export function savePrefs(p: NewSessionPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
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
 */
export function rankModels(
  catalog: readonly ModelOption[],
  sessions: readonly Pick<Session, "provider" | "model" | "lastActivityAt">[],
  provider: ProviderId,
): ModelChoice[] {
  const used = new Map<string, number>();
  for (const s of sessions) {
    if (s.provider !== provider || !s.model) continue;
    used.set(s.model, Math.max(used.get(s.model) ?? 0, s.lastActivityAt));
  }
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const recent: ModelChoice[] = [...used]
    .sort((a, b) => b[1] - a[1])
    .map(([id, at]) => ({ id, label: byId.get(id)?.label ?? modelName(id), releasedAt: byId.get(id)?.releasedAt ?? null, lastUsedAt: at }));
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

/** Case-insensitive, on id or label; every word must hit. */
export function filterModels(models: readonly ModelChoice[], query: string): ModelChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((m) => {
    const hay = `${m.id} ${m.label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ----------------------------------------------------------------- skills

/** Where each CLI looks for skills; null means we do not know, so offer all. */
const SKILL_SOURCES: Record<ProviderId, readonly SkillSource[] | null> = {
  claude: ["project", "global"],
  codex: ["codex", "agents"],
  omp: ["project", "omp", "global", "agents"],
  devin: null,
};

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

/** The open PRs of one repo. */
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

// ------------------------------------------------------------------ where

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

/** Folders past sessions ran in, most recent first — the Folder field's suggestions. */
export function recentFolders(sessions: readonly Pick<Session, "cwd" | "lastActivityAt" | "worktree">[], limit = 12): string[] {
  const last = new Map<string, number>();
  for (const s of sessions) {
    // A worktree agentbox cut is not somewhere you would start a new session.
    if (!s.cwd || s.worktree) continue;
    last.set(s.cwd, Math.max(last.get(s.cwd) ?? 0, s.lastActivityAt));
  }
  return [...last].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => p);
}
