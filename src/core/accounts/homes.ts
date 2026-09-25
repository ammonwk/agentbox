/** Credential homes: where each account's CLI state lives, and the shared
 * configuration every account of a provider sees.
 *
 * The rule the whole module is built around (docs/v2.md, "Accounts"): a home
 * owns its credentials and nothing else is copied between homes. Configuration
 * is SYMLINKED from the provider's default home, so editing `settings.json`
 * once changes every account; credentials, transcripts and history are never
 * shared. Two homes holding the same refresh token log each other out the next
 * time either refreshes, which is why `importHome` refuses a second home for an
 * identity that is already registered.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAccount, insertAccount, listAccounts } from "../db";
import { accountHomeFor, userHome } from "../paths";
import { adapterFor } from "../providers";
import type { Account, ProviderId } from "../types";

export const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp"];

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

/** The file whose existence means "this home has logged in". Null for omp,
 *  which keeps its own credential pool we do not look inside. */
export function credentialsPath(provider: ProviderId, home: string): string | null {
  switch (provider) {
    case "claude": return join(home, ".credentials.json");
    case "codex": return join(home, "auth.json");
    case "devin": return join(home, "devin", "credentials.toml");
    case "omp": return null;
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
 * The account this one is a second copy of: same provider, logged in as the
 * same email. Two homes on one login share one usage pool, and counting it
 * twice is how a balancer ends up placing onto a full account it thinks is
 * someone else. This happens without anyone registering anything: `/login` in
 * the default home replaces whoever was there.
 *
 * Of a pair, the one that stays is a dedicated home (it cannot drift by
 * accident), then the older; the other is the twin. So the provider's default
 * home — your plain CLI login — is a twin of whichever account you last logged
 * the CLI into, and re-logging the CLI changes only that.
 */
export function twinOf<A extends Pick<Account, "id" | "provider" | "email" | "isDefault" | "createdAt">>(
  a: A,
  all: readonly A[],
): A | null {
  if (!a.email) return null;
  const email = a.email.toLowerCase();
  const rank = (x: A) => [x.isDefault ? 1 : 0, x.createdAt, x.id] as const;
  const before = (x: A, y: A) => {
    const [p, q] = [rank(x), rank(y)];
    return p[0] - q[0] || p[1] - q[1] || p[2].localeCompare(q[2]);
  };
  const primary = all
    .filter((o) => o.provider === a.provider && o.email?.toLowerCase() === email)
    .sort(before)[0];
  return primary && primary.id !== a.id ? primary : null;
}

/**
 * Register the default account of every installed provider CLI. Idempotent: a
 * provider that already has a default account, or whose default home was
 * imported by hand, is left alone.
 *
 * Registered whether or not the default home has credentials — an installed
 * CLI you have not logged into is still an account, one whose auth shows
 * "missing" and whose Log in button fixes it. Returns what was added.
 */
export async function ensureDefaultAccounts(
  detect: (p: ProviderId) => Promise<CliInfo> = detectCli,
): Promise<Account[]> {
  const infos = await Promise.all(PROVIDERS.map(async (p) => [p, await detect(p)] as const));
  const added: Account[] = [];
  for (const [provider, info] of infos) {
    if (!info.installed) continue;
    const existing = listAccounts(provider);
    const home = defaultHome(provider);
    if (existing.some((a) => a.isDefault || samePath(a.home, home))) continue;
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
const SHARED: Record<Exclude<ProviderId, "omp" | "devin">, { names: string[]; prefixes: string[] }> = {
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
export function createAccountHome(provider: ProviderId, id: string): string {
  if (provider === "omp") {
    throw new AccountError(400, "omp manages its own credential pool — it has one implicit account and no extra homes");
  }
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
    if (provider === "claude" && syncClaudeJson(home)) made.push(".claude.json");
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
  provider: ProviderId,
  path: string,
  deps: ImportDeps,
): Promise<{ account: Account; email: string | null }> {
  if (provider === "omp") throw new AccountError(400, "omp has one implicit account; there is no home to import");
  const home = canonical(expandHome(path.trim()));
  if (!existsSync(home) || !statSync(home).isDirectory()) throw new AccountError(400, `${home} is not a directory`);
  const cred = credentialsPath(provider, home)!;
  if (!existsSync(cred)) {
    throw new AccountError(400, `${home} has no ${provider} login (expected ${basename(cred)}${provider === "devin" ? " under devin/" : ""})`);
  }

  const isDefault = samePath(home, defaultHome(provider));
  const existing = listAccounts(provider);
  const clash = existing.find((a) => samePath(a.home, home));
  if (clash) throw new AccountError(409, `${home} is already registered as "${clash.label}"`);
  if (isDefault && existing.some((a) => a.isDefault)) {
    throw new AccountError(409, `${home} is the default ${provider} home and is already registered`);
  }

  const email = await deps.identifyEmail({ provider, home, isDefault });
  if (email) {
    for (const a of existing) {
      const theirs = a.email ?? (await deps.identifyEmail(a).catch(() => null));
      if (theirs && theirs.toLowerCase() === email.toLowerCase()) {
        throw new AccountError(
          409,
          `${home} is logged in as ${email}, which is already account "${a.label}" (${a.home}). ` +
            "Two homes on one login share a refresh token and log each other out — log this home into a different account, or use the existing one.",
        );
      }
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
