/** The accounts facade the server talks to: registration, identity, usage and
 * logins behind one object with one `change` event.
 *
 * `list()` returns each account with its auth and usage. Claims and the
 * balancer's placement view are the fleet's to add (AccountView = this +
 * `claims` + `placement`); this module knows nothing about sessions.
 */

import { EventEmitter } from "node:events";
import { deleteAccount, getAccount, insertAccount, listAccounts, updateAccount } from "../db";
import type { Account, AccountAuth, AccountUsage, LoginFlow, ProviderId, UsageWindow } from "../types";
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
  type CliInfo,
} from "./homes";
import { identify, IdentityCache, type Identity } from "./identity";
import { LoginManager, type LoginCommand } from "./login";
import { UsageService, type UsageDeps } from "./usage";

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

export class AccountsService extends EventEmitter {
  readonly usage: UsageService;
  readonly logins: LoginManager;
  private identities: IdentityCache;
  private sweep: ReturnType<typeof setInterval> | null = null;

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
    await this.refreshIdentities(false);
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
  async create(provider: ProviderId, label?: string): Promise<{ account: Account; login: LoginFlow }> {
    if (provider === "omp") throw new AccountError(400, "omp balances its own logins — add them with `omp auth-broker login` instead");
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

  async importHome(provider: ProviderId, home: string): Promise<Account> {
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
   */
  remove(id: string): void {
    const a = getAccount(id);
    if (!a) return;
    if (a.isDefault) {
      throw new AccountError(409, `"${a.label}" is the ${a.provider} default account and would be re-registered at the next start — disable it instead`);
    }
    this.logins.cancelForAccount(id);
    deleteAccount(id);
    this.usage.forget(id);
    this.identities.forget(id);
    this.emit("change");
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
    let auth = this.identities.peek(a.id)?.auth ?? UNKNOWN_AUTH;
    if (a.provider === "omp") {
      // omp has no credentials file we read; whether `omp usage` answers is
      // the best signal there is.
      auth =
        usage.source === "cli" && !usage.stale
          ? { state: "ok", expiresAt: null, detail: null }
          : { state: "unknown", expiresAt: null, detail: usage.stale };
    }
    // Keep claude/codex auth current with the clock without waiting for the
    // identity sweep: the cache expires after a minute and this re-reads.
    if (a.provider === "claude" || a.provider === "codex") void this.maybeReidentify(a).catch(() => undefined);
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
      (o) => o.id !== account.id && !o.isDefault && !account.isDefault && o.email?.toLowerCase() === id.email!.toLowerCase(),
    );
    return twin
      ? `logged in as ${id.email}, which is also account "${twin.label}" — both share one usage pool; forget one of them`
      : null;
  }
}

export { defaultHome, detectCli, ensureDefaultAccounts, createAccountHome, owners, resyncShared, twinOf } from "./homes";
export { identify } from "./identity";
export { UsageService } from "./usage";
export { LoginManager } from "./login";
