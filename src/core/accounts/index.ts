/** The accounts facade the server talks to: registration, identity, usage and
 * logins behind one object with one `change` event.
 *
 * `list()` returns each account with its auth and usage. Claims and the
 * balancer's placement view are the fleet's to add (AccountView = this +
 * `claims` + `placement`); this module knows nothing about sessions.
 */

import { EventEmitter } from "node:events";
import { deleteAccount, dismissDefault, getAccount, insertAccount, listAccounts, restoreAccount, updateAccount } from "../db";
import type { Account, AccountAuth, AccountProvider, AccountUsage, LoginFlow, ProviderId, UsageWindow } from "../types";
import type { ExecFn } from "./exec";
import {
  AccountError,
  createAccountHome,
  detectCli,
  ensureDefaultAccounts,
  importHome as importHomeImpl,
  isAutoLabel,
  newAccountId,
  placeholderLabel,
  resyncShared,
  sameLogin,
  type CliInfo,
} from "./homes";
import { identify, IdentityCache, type Identity } from "./identity";
import { LoginManager, type LoginCommand } from "./login";
import { UsageService, type UsageDeps, type ResetConsumeResult } from "./usage";
import { recordYourAct } from "../yourtime";

export { AccountError } from "./homes";

/** One credential home with its login state and usage. Homes, not accounts:
 *  two homes on one login are folded into one account by `owners`. */
export type AccountWithStatus = Account & {
  auth: AccountAuth;
  usage: AccountUsage;
};

export interface AccountsServiceOptions {
  fetch?: typeof fetch;
  exec?: ExecFn;
  detect?: (p: ProviderId) => Promise<CliInfo>;
  loginCommand?: (account: Account) => LoginCommand;
  usageDeps?: Partial<UsageDeps>;
}

const UNKNOWN_AUTH: AccountAuth = { state: "unknown", expiresAt: null, detail: null };
const IDENTITY_SWEEP_MS = 30 * 60_000;
/** How long a removed account can be brought back; the trash toast's window. */
const UNDO_MS = 5_000;

export class AccountsService extends EventEmitter {
  readonly usage: UsageService;
  readonly logins: LoginManager;
  private identities: IdentityCache;
  private sweep: ReturnType<typeof setInterval> | null = null;
  /** Accounts removed a moment ago, with their pins, while undo is open. */
  private undoable = new Map<string, { account: Account; sessions: string[]; at: number }>();

  constructor(private opts: AccountsServiceOptions = {}) {
    super();
    this.identities = new IdentityCache({ exec: opts.exec });
    this.usage = new UsageService({
      accounts: () => listAccounts(),
      deps: {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.exec ? { exec: opts.exec } : {}),
        ...opts.usageDeps,
      },
    });
    this.logins = new LoginManager({
      command: opts.loginCommand,
      onSuccess: (account) => this.afterLogin(account),
    });
    this.usage.on("change", () => this.emit("change"));
    this.logins.on("change", () => this.emit("change"));
  }

  /** Register default accounts, bring identities up to date, start polling. */
  async start(): Promise<void> {
    await ensureDefaultAccounts(this.opts.detect ?? detectCli);
    for (const a of listAccounts()) {
      try {
        resyncShared(a);
      } catch (err) {
        console.error(`agentbox: could not re-link shared config for ${a.label}: ${(err as Error).message}`);
      }
    }
    // Not waited for: every account's email and plan are in the database from
    // the last run, which is what the first fleet pass needs, and asking each
    // CLI again (a process each, some a network round trip) held up every
    // start by seconds. A login that changed while the server was down shows
    // when this lands, as a "change".
    void this.refreshIdentities(false);
    this.usage.start();
    this.sweep = setInterval(() => void this.refreshIdentities(true), IDENTITY_SWEEP_MS);
    this.sweep.unref?.();
  }

  stop(): void {
    this.usage.stop();
    this.logins.stop();
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  list(): AccountWithStatus[] {
    return listAccounts().map((a) => this.withStatus(a));
  }

  get(id: string): AccountWithStatus | null {
    const a = getAccount(id);
    return a ? this.withStatus(a) : null;
  }

  /** Windows for the balancer, by account. */
  windows(accountId: string): UsageWindow[] {
    return this.usage.get(accountId).windows;
  }

  /**
   * A new account: a fresh home with the shared config linked in, and a login
   * started in it. The account exists from this moment (auth "missing") so a
   * login you abandon can be resumed with `login(id)`.
   */
  async create(provider: AccountProvider, label?: string): Promise<{ account: Account; login: LoginFlow }> {
    const id = newAccountId();
    const home = createAccountHome(provider, id);
    const account: Account = {
      id,
      provider,
      label: label?.trim() || placeholderLabel(provider, false),
      email: null,
      plan: null,
      home,
      isDefault: false,
      enabled: true,
      createdAt: Date.now(),
    };
    insertAccount(account);
    let login: LoginFlow;
    try {
      login = this.logins.start(account);
    } catch (err) {
      // Most likely another login of this provider is running. The account
      // stays; the error says what to do.
      this.emit("change");
      throw err;
    }
    this.emit("change");
    return { account, login };
  }

  async importHome(provider: AccountProvider, home: string): Promise<Account> {
    const { account } = await importHomeImpl(provider, home, {
      identifyEmail: async (a) => (await identify(a, { exec: this.opts.exec })).email,
    });
    await this.reidentify(account.id);
    void this.usage.refresh(account.id).catch(() => undefined);
    this.emit("change");
    return getAccount(account.id) ?? account;
  }

  update(id: string, patch: { label?: string; enabled?: boolean }): Account {
    const a = getAccount(id);
    if (!a) throw new AccountError(404, `no account ${id}`);
    const label = patch.label?.trim();
    updateAccount(id, { label: label || undefined, enabled: patch.enabled });
    this.emit("change");
    return getAccount(id)!;
  }

  /**
   * Forget an account. The home directory is never deleted: it holds a login
   * you may want back, and transcripts the sessions list may still point at.
   * The row is held for a moment so a mistaken click can be taken back — and a
   * default (CLI) home is marked as dismissed so a restart does not register it
   * again.
   */
  remove(id: string): void {
    const a = getAccount(id);
    if (!a) return;
    if (a.isDefault) dismissDefault(a.provider, true);
    this.logins.cancelForAccount(id);
    const sessions = deleteAccount(id);
    const at = Date.now();
    this.undoable.set(id, { account: a, sessions, at });
    for (const [old, rec] of this.undoable) if (rec.at < at - UNDO_MS) this.undoable.delete(old);
    this.usage.forget(id);
    this.identities.forget(id);
    this.emit("change");
  }

  /** Put back an account removed a moment ago, with the sessions pinned to
   *  it. Null once the undo window has passed, or if it was never removed. */
  undoRemove(id: string): Account | null {
    const rec = this.undoable.get(id);
    if (!rec) return null;
    this.undoable.delete(id);
    if (Date.now() - rec.at > UNDO_MS) return null;
    try {
      restoreAccount(rec.account, rec.sessions);
    } catch {
      throw new AccountError(409, `an account already uses ${rec.account.home}`);
    }
    if (rec.account.isDefault) dismissDefault(rec.account.provider, false);
    void this.reidentify(id).catch(() => undefined);
    void this.usage.refresh(id).catch(() => undefined);
    this.emit("change");
    return getAccount(id);
  }

  login(accountId: string): LoginFlow {
    const a = getAccount(accountId);
    if (!a) throw new AccountError(404, `no account ${accountId}`);
    if (a.provider !== "omp") resyncShared(a);
    return this.logins.start(a);
  }

  /** The last-known login state, without re-reading anything. */
  authState(accountId: string): AccountAuth["state"] | null {
    return this.identities.peek(accountId)?.auth.state ?? null;
  }

  refreshUsage(accountId: string): Promise<AccountUsage> {
    return this.usage.refresh(accountId);
  }

  /** Spend one of a codex account's usage-limit resets (the UI's button, or
   *  nothing else yet), then re-read its usage so the reset takes effect on
   *  the board. */
  consumeReset(accountId: string, creditId?: string | null): Promise<ResetConsumeResult> {
    return this.usage.consumeReset(accountId, creditId);
  }

  paste(loginId: string, text: string): LoginFlow {
    return this.logins.paste(loginId, text);
  }

  cancel(loginId: string): void {
    this.logins.cancel(loginId);
  }

  loginFlows(): LoginFlow[] {
    return this.logins.list();
  }

  /** Feed a codex rollout reading (see UsageService.ingestRollout). */
  ingestRollout(accountId: string, reading: { at: number; windows: UsageWindow[] }): boolean {
    return this.usage.ingestRollout(accountId, reading);
  }

  // -------------------------------------------------------------- internals

  private withStatus(a: Account): AccountWithStatus {
    const usage = this.usage.get(a.id);
    const auth = this.identities.peek(a.id)?.auth ?? UNKNOWN_AUTH;
    // Keep auth read from a file (claude, codex, an OpenCode Go account)
    // current without waiting for the identity sweep: the cache expires after
    // a minute and this re-reads.
    if (a.provider !== "devin") void this.maybeReidentify(a).catch(() => undefined);
    return { ...a, auth, usage };
  }

  private async maybeReidentify(a: Account): Promise<void> {
    const before = this.identities.peek(a.id);
    const after = await this.identities.get(a);
    if (before && JSON.stringify(before) !== JSON.stringify(after)) {
      this.apply(a, after);
      this.emit("change");
    }
  }

  private async refreshIdentities(force: boolean): Promise<void> {
    await Promise.allSettled(listAccounts().map((a) => this.reidentify(a.id, force)));
    this.emit("change");
  }

  private async reidentify(accountId: string, force = true): Promise<Identity | null> {
    const a = getAccount(accountId);
    if (!a) return null;
    const id = await this.identities.get(a, force);
    this.apply(a, id);
    return id;
  }

  /** Write what identify learned back to the row: email and plan always, the
   *  label only if it was never chosen by you — a placeholder, or the email it
   *  was logged in as before (a label that says the old login is a lie). */
  private apply(a: Account, id: Identity): void {
    const patch: Parameters<typeof updateAccount>[1] = {};
    if (id.email && id.email !== a.email) patch.email = id.email;
    if (id.plan && id.plan !== a.plan) patch.plan = id.plan;
    const auto = isAutoLabel(a) || (!!a.email && a.label.toLowerCase() === a.email.toLowerCase());
    if (id.email && auto && a.label !== id.email) patch.label = id.email;
    // Logged out is nobody: a stale email would keep it a twin of whoever it
    // used to be.
    if (id.auth.state === "missing" && a.email) {
      patch.email = null;
      if (auto) patch.label = placeholderLabel(a.provider, a.isDefault);
    }
    if (Object.keys(patch).length) updateAccount(a.id, patch);
  }

  /**
   * After a CLI reports a successful login: re-identify, refresh usage, and
   * warn when the new login is an identity another account already has — two
   * homes on one subscription share one usage pool, which the balancer would
   * count twice.
   */
  private async afterLogin(account: Account): Promise<string | null> {
    recordYourAct("login", null);
    const id = await this.reidentify(account.id, true);
    void this.usage.refresh(account.id).catch(() => undefined);
    if (!id?.email) return null;
    // Named after an email and logged into another: the login page used
    // whoever the browser was signed into.
    if (/^[^\s@]+@[^\s@]+$/.test(account.label) && account.label.toLowerCase() !== id.email.toLowerCase()) {
      return `logged in as ${id.email}, not ${account.label} — your browser was probably signed into ${id.email}; switch accounts there and log in again`;
    }
    // A CLI login that matches an account is the expected shape (see
    // `twinOf`); only two agentbox homes on one login are a mistake.
    const twin = listAccounts(account.provider).find(
      (o) => o.id !== account.id && !o.isDefault && !account.isDefault && sameLogin(account, o),
    );
    return twin
      ? `logged in as ${id.email}, which is also account "${twin.label}" — both share one usage pool; forget one of them`
      : null;
  }
}

export { defaultHome, detectCli, ensureDefaultAccounts, createAccountHome, owners, resyncShared, twinOf } from "./homes";
export { identify } from "./identity";
export { UsageService } from "./usage";
export type { ResetConsumeResult, ResetOutcome } from "./usage";
export { LoginManager } from "./login";
