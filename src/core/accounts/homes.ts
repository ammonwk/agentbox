/** Credential homes: where each account's CLI state lives, and the shared
 * configuration every account of a provider sees.
 *
 * The rule the whole module is built around (docs/v2.md, "Accounts"): a home
 * owns its credentials and nothing else is copied between homes. Configuration
 * is SYMLINKED from the provider's default home, so editing `settings.json`
 * once changes every account; so is claude's per-project auto-memory.
 * Credentials, transcripts and history are never shared. Two homes holding
 * the same refresh token log each other out the next time either refreshes,
 * which is why `importHome` refuses a second home for an identity that is
 * already registered.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getAccount, insertAccount, listAccounts } from "../db";
import { accountHomeFor, userHome } from "../paths";
import { adapterFor } from "../providers";
import { GO_LOGIN_FILE, readGoLogin } from "./gocred";
import type { Account, AccountProvider, ProviderId } from "../types";

/** The providers that hold accounts; opencode runs on omp's (see AccountProvider). */
export const PROVIDERS: AccountProvider[] = ["claude", "codex", "devin", "omp", "muse"];

/**
 * A request this module refuses, with the HTTP status that says why: 404 for
 * an account or login that does not exist, 400 for one that can never work,
 * 409 for one that conflicts with what is already there. Anything else thrown
 * from here is a real failure.
 */
export class AccountError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}


function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(userHome(), ".config");
}

/**
 * The provider's own default credential home — what the CLI uses when no
 * isolating env var is set. For devin this is the XDG data dir, not
 * `<data>/devin`: the account "home" is what `XDG_DATA_HOME` gets set to.
 * The adapter owns it, as it owns every way the CLI is pointed at a home.
 */
export function defaultHome(provider: ProviderId): string {
  return adapterFor(provider).defaultHome();
}

/** The environment that points a provider's auth commands (login, status) at
 *  an account's home, `unset` always present. */
export function authEnv(account: Pick<Account, "provider" | "home" | "isDefault">): { env: Record<string, string>; unset: string[] } {
  const e = adapterFor(account.provider).authEnv(account);
  return { env: e.env, unset: e.unset ?? [] };
}

/** The file whose existence means "this home has logged in". For omp, an
 *  OpenCode Go account, its Console sign-in (accounts/gocred.ts). */
export function credentialsPath(provider: AccountProvider, home: string): string | null {
  switch (provider) {
    case "claude": return join(home, ".credentials.json");
    case "codex": return join(home, "auth.json");
    case "devin": return join(home, "devin", "credentials.toml");
    case "omp": return join(home, GO_LOGIN_FILE);
    case "muse": return join(home, "muse", "auth.json");
  }
}

/**
 * Claude's global state file. With `CLAUDE_CONFIG_DIR` set it lives inside the
 * config dir; without it (the default account) it is `~/.claude.json`, NOT
 * `~/.claude/.claude.json` — easy to get wrong, and getting it wrong reads an
 * empty identity and a usage cache that never updates.
 */
export function claudeJsonPath(account: Pick<Account, "home" | "isDefault">): string {
  return account.isDefault ? join(userHome(), ".claude.json") : join(account.home, ".claude.json");
}

// ------------------------------------------------------------ detection

export interface CliInfo {
  installed: boolean;
  version: string | null;
}

const detected = new Map<ProviderId, Promise<CliInfo>>();

/**
 * Is the provider's CLI installed — its adapter's `detect()`, cached for the
 * life of the process: installing a CLI is rare and a restart picks it up,
 * while re-probing on every boot-time registration pass would fork four
 * processes each time.
 */
export function detectCli(provider: ProviderId): Promise<CliInfo> {
  let p = detected.get(provider);
  if (!p) {
    p = adapterFor(provider).detect();
    detected.set(provider, p);
  }
  return p;
}

// ------------------------------------------------------------- accounts

export function newAccountId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

/** The label an account gets before we know its email. `isAutoLabel` is how the
 *  service knows it may replace it with the email once identified. */
export function placeholderLabel(provider: ProviderId, isDefault: boolean): string {
  return isDefault ? `${provider} (default)` : `${provider} (new account)`;
}

export function isAutoLabel(a: Pick<Account, "label" | "provider">): boolean {
  return !a.label || a.label === placeholderLabel(a.provider, true) || a.label === placeholderLabel(a.provider, false);
}

/**
 * Whether two homes hold the same login. For claude and codex that is the
 * email; for omp it is one OpenCode account in one workspace, because one
 * email can hold several workspaces and each is its own refresh token.
 */
export function sameLogin(a: Pick<Account, "provider" | "email" | "home">, b: Pick<Account, "provider" | "email" | "home">): boolean {
  if (a.provider !== b.provider) return false;
  if (a.provider === "omp") {
    const x = readGoLogin(a.home);
    const y = readGoLogin(b.home);
    return !!x && !!y && !!x.accountID && x.accountID === y.accountID && x.orgID === y.orgID;
  }
  return !!a.email && a.email.toLowerCase() === b.email?.toLowerCase();
}

/**
 * The account this one is a second copy of: same provider, logged in as the
 * same login. Two homes on one login share one usage pool, and counting it
 * twice is how a balancer ends up placing onto a full account it thinks is
 * someone else. This happens without anyone registering anything: `/login` in
 * the default home replaces whoever was there.
 *
 * Of a pair, the one that stays is a dedicated home (it cannot drift by
 * accident), then the older; the other is the twin. So the provider's default
 * home — your plain CLI login — is a twin of whichever account you last logged
 * the CLI into, and re-logging the CLI changes only that.
 */
export function twinOf<A extends Pick<Account, "id" | "provider" | "email" | "isDefault" | "createdAt" | "home">>(
  a: A,
  all: readonly A[],
): A | null {
  const rank = (x: A) => [x.isDefault ? 1 : 0, x.createdAt, x.id] as const;
  const before = (x: A, y: A) => {
    const [p, q] = [rank(x), rank(y)];
    return p[0] - q[0] || p[1] - q[1] || p[2].localeCompare(q[2]);
  };
  const primary = all.filter((o) => sameLogin(a, o)).sort(before)[0];
  return primary && primary.id !== a.id ? primary : null;
}

/**
 * The account each home belongs to: itself, or — for a twin — the account it
 * duplicates. The one place "same login" is resolved. The rows are credential
 * homes; an account is a login, and everything that counts, places or shows
 * accounts keys on this, so a twin is never an account of its own anywhere.
 * A session stays pinned to its home (that is where its transcript is and
 * what resumes it); it belongs to the home's owner.
 */
export function owners<A extends Pick<Account, "id" | "provider" | "email" | "isDefault" | "createdAt" | "home">>(
  all: readonly A[],
): Map<string, string> {
  return new Map(all.map((a) => [a.id, twinOf(a, all)?.id ?? a.id]));
}

/**
 * Register the default account of every installed provider CLI. Idempotent: a
 * provider that already has a default account, or whose default home was
 * imported by hand, is left alone.
 *
 * Registered whether or not the default home has credentials — an installed
 * CLI you have not logged into is still an account, one whose auth shows
 * "missing" and whose Log in button fixes it. Returns what was added.
 *
 * Not omp: its accounts are OpenCode Go sign-ins, each one added (and
 * forgotten) by you, and the CLI holds none that agentbox would borrow.
 */
export async function ensureDefaultAccounts(
  detect: (p: ProviderId) => Promise<CliInfo> = detectCli,
): Promise<Account[]> {
  const hasDefault = (p: AccountProvider) => listAccounts(p).some((a) => a.isDefault || samePath(a.home, defaultHome(p)));
  // Only a provider without one is asked whether its CLI is installed: that
  // runs it (`omp --version` is a second), on every server start.
  const missing = PROVIDERS.filter((p) => p !== "omp" && !hasDefault(p));
  const infos = await Promise.all(missing.map(async (p) => [p, await detect(p)] as const));
  const added: Account[] = [];
  for (const [provider, info] of infos) {
    if (!info.installed || hasDefault(provider)) continue;
    const home = defaultHome(provider);
    const account: Account = {
      id: newAccountId(),
      provider,
      label: placeholderLabel(provider, true),
      email: null,
      plan: null,
      home,
      isDefault: true,
      enabled: true,
      createdAt: Date.now(),
    };
    insertAccount(account);
    added.push(account);
  }
  return added;
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function expandHome(p: string): string {
  if (p === "~") return userHome();
  if (p.startsWith("~/")) return join(userHome(), p.slice(2));
  return p;
}

// --------------------------------------------------------- shared config

/** What each provider shares from its default home. `statusline*` is a prefix
 *  match: people keep status-line scripts next to settings.json and reference
 *  them by path. */
const SHARED: Record<Exclude<AccountProvider, "omp" | "devin" | "muse">, { names: string[]; prefixes: string[] }> = {
  claude: {
    names: ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "plugins", "hooks", "output-styles", "keybindings.json"],
    prefixes: ["statusline"],
  },
  // hooks.json is codex's equivalent of claude's hooks: without it an account
  // silently runs without the user's hooks.
  codex: { names: ["config.toml", "AGENTS.md", "skills", "rules", "prompts", "hooks.json"], prefixes: [] },
};

/**
 * Keys of `~/.claude.json` a new account inherits. An allowlist, not a
 * denylist: the file mixes preferences with the account's identity
 * (`oauthAccount`, `userID`), its usage (`cachedUsageUtilization`), per-project
 * history and trust (`projects`), and dozens of caches keyed to one org. Any
 * key added upstream is therefore NOT copied until someone decides it is a
 * preference.
 *
 * What is copied, and why:
 * - onboarding and release-notes markers, so the account does not open on the
 *   first-run theme picker and "what's new" screens;
 * - `mcpServers`, so every account has the user-scope MCP servers;
 * - completed-migration markers: a migration re-run on a fresh account would
 *   rewrite `settings.json`, which is a symlink to the one shared file.
 * Pattern keys are copied only when the value is a primitive, which keeps out
 * per-org dictionaries that happen to share a prefix.
 */
const CLAUDE_JSON_KEYS = new Set([
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "lastReleaseNotesSeen",
  "theme",
  "mcpServers",
  "installMethod",
  "autoUpdates",
  "autoUpdatesProtectedForNative",
  "preferredNotifChannel",
  "shiftEnterKeyBindingInstalled",
  "officialMarketplaceAutoInstallAttempted",
  "officialMarketplaceAutoInstalled",
  "migrationVersion",
  "bypassPermissionsModeAccepted",
  "editorMode",
  "teammateMode",
  "showSpinnerTree",
  "diffSidebarOpen",
  "claudeInChromeDefaultEnabled",
  "remoteDialogSeen",
]);
const CLAUDE_JSON_PATTERNS = [/MigrationComplete$/, /^hasCompleted/, /^hasSeen/, /Dismissed$/];

export function seedClaudeJson(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (CLAUDE_JSON_KEYS.has(k)) out[k] = v;
    else if (CLAUDE_JSON_PATTERNS.some((re) => re.test(k)) && (v === null || typeof v !== "object")) out[k] = v;
  }
  return out;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Write via rename so a CLI reading the file concurrently sees old or new,
 *  never half. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.agentbox-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** lstat-based: a dangling symlink counts as present (its target may come
 *  back), and we never replace something the user put there. */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function linkShared(from: string, to: string, spec: { names: string[]; prefixes: string[] }): string[] {
  const made: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(from);
  } catch {
    return made;
  }
  const wanted = entries.filter((n) => spec.names.includes(n) || spec.prefixes.some((p) => n.startsWith(p)));
  for (const name of wanted) {
    const dst = join(to, name);
    if (present(dst)) continue;
    symlinkSync(join(from, name), dst);
    made.push(name);
  }
  return made;
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * Point every per-project auto-memory directory in a claude account at the
 * default home's, so a memory saved on one account is read on all of them.
 * Claude keys memory by the main checkout, so worktrees already share it
 * within a home; homes did not. An account's own memory is merged in, never
 * dropped. Returns the links it made.
 */
function linkMemory(shared: string, home: string): string[] {
  const made: string[] = [];
  const slugs = new Set<string>();
  for (const slug of listDir(join(shared, "projects"))) if (listDir(join(shared, "projects", slug, "memory")).length) slugs.add(slug);
  for (const slug of listDir(join(home, "projects"))) if (present(join(home, "projects", slug, "memory"))) slugs.add(slug);
  for (const slug of slugs) {
    const from = join(shared, "projects", slug, "memory");
    const to = join(home, "projects", slug, "memory");
    if (present(to) && lstatSync(to).isSymbolicLink()) continue;
    mkdirSync(from, { recursive: true });
    mkdirSync(dirname(to), { recursive: true });
    let parked: string | null = null;
    if (present(to)) {
      // Moved aside before linking, so a session saving a memory meanwhile
      // writes into one directory or the other, both of which get merged.
      parked = `${to}.merging-${process.pid}`;
      renameSync(to, parked);
    }
    try {
      symlinkSync(from, to);
      made.push(`projects/${slug}/memory`);
    } catch (err) {
      // A session recreated it in the gap: the next resync merges that one.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (parked) mergeMemory(parked, from, basename(home));
  }
  return made;
}

/** Move one memory directory's files into another. A file that differs from
 *  one already there keeps both, the newcomer renamed with `suffix`; index
 *  lines the target lacks are appended, pointing at any renamed file. */
function mergeMemory(src: string, dst: string, suffix: string): void {
  const renamed = new Map<string, string>();
  for (const name of listDir(src)) {
    if (name === "MEMORY.md") continue;
    const from = join(src, name);
    const to = join(dst, name);
    if (!present(to)) {
      renameSync(from, to);
    } else if (statSync(from).isFile() && statSync(to).isFile()) {
      if (readFileSync(from).equals(readFileSync(to))) {
        rmSync(from);
        continue;
      }
      const ext = extname(name);
      const alt = `${name.slice(0, name.length - ext.length)}-${suffix}${ext}`;
      if (present(join(dst, alt))) continue;
      renameSync(from, join(dst, alt));
      renamed.set(name, alt);
    }
  }
  const index = join(src, "MEMORY.md");
  if (present(index)) {
    const target = join(dst, "MEMORY.md");
    const have = new Set(existsSync(target) ? readFileSync(target, "utf8").split("\n").map((l) => l.trim()) : []);
    const add: string[] = [];
    for (const raw of readFileSync(index, "utf8").split("\n")) {
      let line = raw.trimEnd();
      if (!line.trim() || line.trim().startsWith("#")) continue;
      for (const [name, alt] of renamed) line = line.replaceAll(`(${name})`, `(${alt})`);
      if (!have.has(line.trim())) {
        add.push(line);
        have.add(line.trim());
      }
    }
    // Appended rather than rewritten, so a line a session adds meanwhile survives.
    if (add.length) {
      const sep = existsSync(target) && !readFileSync(target, "utf8").endsWith("\n") ? "\n" : "";
      appendFileSync(target, sep + add.join("\n") + "\n");
    }
    rmSync(index);
  }
  try {
    rmdirSync(src);
  } catch {
    console.error(`agentbox: memory_merge_incomplete dir=${src}`);
  }
}

/**
 * Bring `<home>/.claude.json` up to date with the default's shareable keys,
 * adding only what is missing. Never overwrites: the account may have changed a
 * preference itself, and it may be running right now.
 */
function syncClaudeJson(home: string): boolean {
  const source = readJsonObject(join(userHome(), ".claude.json"));
  if (!source) return false;
  const seed = seedClaudeJson(source);
  const path = join(home, ".claude.json");
  const current = existsSync(path) ? readJsonObject(path) : {};
  if (current === null) return false; // unreadable: leave it for claude to deal with
  let changed = false;
  for (const [k, v] of Object.entries(seed)) {
    if (k === "mcpServers" && v && typeof v === "object" && current.mcpServers && typeof current.mcpServers === "object") {
      // Merge by server name so a server added to the default later still
      // reaches older accounts, without clobbering one the account added.
      const mine = current.mcpServers as Record<string, unknown>;
      for (const [name, cfg] of Object.entries(v as Record<string, unknown>)) {
        if (!(name in mine)) {
          mine[name] = cfg;
          changed = true;
        }
      }
    } else if (!(k in current)) {
      current[k] = v;
      changed = true;
    }
  }
  if (changed || !existsSync(path)) writeJsonAtomic(path, current);
  return changed;
}

/**
 * Make a new credential home and link the shared configuration into it.
 * Returns the home path. The directory is 0700: it is about to hold a refresh
 * token.
 */
export function createAccountHome(provider: AccountProvider, id: string): string {
  const home = accountHomeFor(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  resyncShared({ provider, home, isDefault: false });
  return home;
}

/**
 * Re-create any missing shared links (and, for claude, missing seeded
 * `.claude.json` keys). Idempotent; for accounts created before a shared file
 * existed in the default home. Returns the names it added.
 */
export function resyncShared(account: Pick<Account, "provider" | "home" | "isDefault">): string[] {
  if (account.isDefault || account.provider === "omp") return [];
  const { provider, home } = account;
  const made: string[] = [];
  if (provider === "claude" || provider === "codex") {
    made.push(...linkShared(defaultHome(provider), home, SHARED[provider]));
    if (provider === "claude") {
      made.push(...linkMemory(defaultHome(provider), home));
      if (syncClaudeJson(home)) made.push(".claude.json");
    }
  } else if (provider === "muse") {
    const cfgDir = join(home, "muse");
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    made.push(...linkShared(join(defaultHome(provider), "muse"), cfgDir, { names: ["settings.json", "skills", "AGENTS.md"], prefixes: [] }));
  } else if (provider === "devin") {
    // devin logs in under XDG_DATA_HOME=<home> and XDG_CONFIG_HOME=<home>/config.
    // Its data dir must exist for the credentials to land; its config dir gets
    // the user's config.json so login sees the same settings.
    mkdirSync(join(home, "devin"), { recursive: true, mode: 0o700 });
    const cfgDir = join(home, "config", "devin");
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    made.push(...linkShared(join(xdgConfigHome(), "devin"), cfgDir, { names: ["config.json"], prefixes: [] }));
  }
  return made;
}

// ---------------------------------------------------------------- import

export interface ImportDeps {
  /** Who is logged in at a home. Injected so this module does not import
   *  identity.ts's subprocess-spawning devin path in tests. */
  identifyEmail: (a: Pick<Account, "provider" | "home" | "isDefault">) => Promise<string | null>;
}

/**
 * Register an existing credential home (e.g. a second `CODEX_HOME` made by
 * hand). Refuses a home without credentials, a home already registered, and a
 * home logged in as an identity already registered under another home — that
 * last one because both homes would then refresh from one token family.
 */
export async function importHome(
  provider: AccountProvider,
  path: string,
  deps: ImportDeps,
): Promise<{ account: Account; email: string | null }> {
  const home = canonical(expandHome(path.trim()));
  if (!existsSync(home) || !statSync(home).isDirectory()) throw new AccountError(400, `${home} is not a directory`);
  const cred = credentialsPath(provider, home)!;
  if (!existsSync(cred)) {
    throw new AccountError(400, `${home} has no ${provider} login (expected ${basename(cred)}${provider === "devin" ? " under devin/" : ""})`);
  }

  // omp has no CLI home of its own to adopt: what is imported is another
  // agentbox account home (a copy, a backup), whose Console sign-in is the login.
  const isDefault = provider !== "omp" && samePath(home, defaultHome(provider));
  const existing = listAccounts(provider);
  const clash = existing.find((a) => samePath(a.home, home));
  if (clash) throw new AccountError(409, `${home} is already registered as "${clash.label}"`);
  if (isDefault && existing.some((a) => a.isDefault)) {
    throw new AccountError(409, `${home} is the default ${provider} home and is already registered`);
  }

  const email = await deps.identifyEmail({ provider, home, isDefault });
  for (const a of existing) {
    // The DB's email is kept fresh; only a missing one costs a probe.
    const theirs = provider === "omp" || a.email ? a : { ...a, email: await deps.identifyEmail(a).catch(() => null) };
    if (sameLogin({ provider, email, home }, theirs)) {
      throw new AccountError(
        409,
        `${home} is logged in as ${email ?? "the same login"}, which is already account "${a.label}" (${a.home}). ` +
          "Two homes on one login share a refresh token and log each other out — log this home into a different account, or use the existing one.",
      );
    }
  }

  const account: Account = {
    id: newAccountId(),
    provider,
    label: email ?? basename(home),
    email,
    plan: null,
    home,
    isDefault,
    enabled: true,
    createdAt: Date.now(),
  };
  insertAccount(account);
  return { account: getAccount(account.id) ?? account, email };
}
