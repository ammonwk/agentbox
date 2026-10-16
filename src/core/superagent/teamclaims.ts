/**
 * The claims of shared superagents, kept in the cloud (docs/cloud.md,
 * "Shared superagents"). The same `ClaimsBackend` as box.db's, with the same
 * guarantees, across every instance of the workspace: one holder for each
 * (workspace, scope, key), a fence that grows on every change of holder, a
 * lease this host renews, an expired lease that stays exclusive, and a
 * takeover that only the holding instance's host completes, after it proved
 * the stop (`WorkClaims.takeover`). The cloud checks each of these again in
 * the same statement as the change (inst_superagent_claim_*).
 *
 * The holder of a claim of this machine's instance is its superagent's
 * name here; another machine's is `<name>@<host>`, which no local caller is.
 *
 * It asks the cloud while this machine shares a superagent, and after it
 * stopped too: the claims of an instance it no longer shares are still
 * listed, renewed and released from here. Each call gives up after
 * `RPC_TIMEOUT_MS` with a clear error, so an outage never hangs a caller.
 */
import { CloudError } from "../../cloud/client";
import type { CloudClaim, InstallationSuperagents } from "../../cloud/superagents";
import { ClaimError, type ClaimFilter, type ClaimHolder, type ClaimScope, type ClaimsBackend, type ClaimState, type WorkClaim } from "../workclaims";

export type CloudClaimsDeps = {
  /** The machine's client; null when the cloud is not set up or the machine not registered. */
  api: () => InstallationSuperagents | null;
  /** This machine's installation id. */
  installation: () => string | null;
  /** The cloud instance of a superagent this machine shares; null when it is not shared. */
  instanceOf: (superagent: string) => string | null;
  /** Whether this machine shares a superagent now or did before: never, and
   *  nothing here touches the network. */
  inUse: () => boolean;
  /** How long one call to the cloud can take; RPC_TIMEOUT_MS by default. */
  timeoutMs?: number;
};

export const RPC_TIMEOUT_MS = 10_000;

export class CloudClaims implements ClaimsBackend {
  constructor(private readonly deps: CloudClaimsDeps) {}

  private api(): InstallationSuperagents {
    const api = this.deps.api();
    if (!api) throw new ClaimError(409, "this superagent's claims are kept in the cloud, and this machine is not connected to it");
    return api;
  }

  holderOf(c: CloudClaim): ClaimHolder {
    const here = c.host_installation_id === this.deps.installation();
    return { superagent: here ? c.instance_name : `${c.instance_name}@${c.host_name ?? c.host_installation_id.slice(0, 8)}`, session: c.session };
  }

  private toClaim(c: CloudClaim): WorkClaim {
    return { key: c.key, source: c.source, scope: c.scope, fence: c.fence, leaseUntil: c.lease_until, state: c.state, holder: this.holderOf(c), note: c.note };
  }

  /** The cloud's refusal as the claims service's: a conflict keeps its
   *  holder, and no answer in time is a 503 that says the change is unknown. */
  private async run<T>(f: () => Promise<T>): Promise<T> {
    const ms = this.deps.timeoutMs ?? RPC_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ClaimError(503, `the cloud keeps this claim and did not answer in ${Math.round(ms / 1000)} s: a change asked for can still have happened, so read the claim again before you retry`)),
        ms,
      );
    });
    try {
      return await Promise.race([f(), late]);
    } catch (e) {
      if (!(e instanceof CloudError)) throw e;
      let detail: { key: string; holder: ClaimHolder; state: ClaimState } | null = null;
      if (e.detail) {
        try {
          const c = JSON.parse(e.detail) as CloudClaim;
          detail = { key: c.key, holder: this.holderOf(c), state: c.state };
        } catch {
          /* not a claim */
        }
      }
      const status = [400, 403, 404, 409].includes(e.status) ? e.status : 503;
      throw new ClaimError(status, status === 503 ? `the cloud keeps this claim and did not answer: ${e.message}` : e.message, detail);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The claim as the cloud has it, with the instance that holds it. */
  private async raw(scope: ClaimScope, key: string): Promise<CloudClaim | null> {
    const api = this.deps.api();
    if (!api || !this.deps.inUse()) return null;
    return (await this.run(() => api.claims({ key, scope, released: true })))[0] ?? null;
  }

  private async held(scope: ClaimScope, key: string): Promise<CloudClaim> {
    const c = await this.raw(scope, key);
    if (!c || c.state === "released") throw new ClaimError(404, `nobody holds ${key}`);
    return c;
  }

  async get(scope: ClaimScope, key: string): Promise<WorkClaim | null> {
    const c = await this.raw(scope, key);
    return c ? this.toClaim(c) : null;
  }

  async list(f: ClaimFilter): Promise<WorkClaim[]> {
    if (!this.deps.api() || !this.deps.inUse()) return [];
    // A superagent shared now names its instance. One shared before is
    // found by its name among this machine's instances: its claims stay here
    // until they are released.
    const instance = f.superagent !== undefined ? (this.deps.instanceOf(f.superagent) ?? undefined) : undefined;
    const rows = await this.run(() => this.api().claims({ instance, session: f.session, key: f.key, scope: f.scope, released: f.released }));
    const me = this.deps.installation();
    const mine = f.superagent === undefined || instance ? rows : rows.filter((c) => c.host_installation_id === me && c.instance_name === f.superagent);
    return mine.map((c) => this.toClaim(c));
  }

  async claim(items: readonly { key: string; source: string }[], scope: ClaimScope, holder: ClaimHolder, note: string | null): Promise<WorkClaim[]> {
    const instance = holder.superagent ? this.deps.instanceOf(holder.superagent) : null;
    if (!instance) throw new ClaimError(409, `${holder.superagent ?? "a person"} is not shared from this machine: its claims are kept here`);
    const rows = await this.run(() => this.api().claimAcquire(instance, scope, items, holder.session, note));
    return rows.map((c) => this.toClaim(c));
  }

  async attach(scope: ClaimScope, key: string, fence: number, session: string): Promise<WorkClaim> {
    const c = await this.held(scope, key);
    return this.toClaim(await this.run(() => this.api().claimAttach(c.instance_id, scope, key, fence, session)));
  }

  async release(scope: ClaimScope, key: string, fence: number): Promise<WorkClaim> {
    const c = await this.held(scope, key);
    return this.toClaim(await this.run(() => this.api().claimRelease(c.instance_id, scope, key, fence)));
  }

  async requestTakeover(scope: ClaimScope, key: string, fence: number): Promise<WorkClaim> {
    const c = await this.held(scope, key);
    return this.toClaim(await this.run(() => this.api().claimTakeoverRequest(c.instance_id, scope, key, fence)));
  }

  async completeTakeover(scope: ClaimScope, key: string, fence: number, holder: ClaimHolder): Promise<WorkClaim> {
    const c = await this.held(scope, key);
    return this.toClaim(await this.run(() => this.api().claimTakeoverComplete(c.instance_id, scope, key, fence, holder.session)));
  }

  async renew(live: ReadonlySet<string>): Promise<void> {
    if (!this.deps.api() || !this.deps.inUse()) return;
    await this.run(() => this.api().claimRenew([...live]));
  }

  async handOver(from: string, to: string): Promise<number> {
    if (!this.deps.api() || !this.deps.inUse()) return 0;
    return this.run(() => this.api().claimHandover(from, to));
  }
}
