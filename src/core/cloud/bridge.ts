/** This machine's link to the agentbox cloud (docs/cloud.md).
 *
 *  It only ever calls out: nothing in the cloud can reach this machine's
 *  API or terminals, and the loopback server stays as it was. On each pass
 *  (every `pollSeconds`, 5 by default) it says hello now and then, keeps the
 *  provider metadata current, hands the cloud what local agents sent, then
 *  leases what was sent here, delivers each through the local send path
 *  (deliver.ts) and reports what happened. Offline, it keeps trying with the
 *  outbox intact; revoked, it stops until registered again.
 *
 *  Unconfigured, it does nothing at all: agentbox is local first. */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { CloudError, InstallationCloud, supabaseFor, type CloudConfig } from "../../cloud/client";
import {
  CLIENT_MSG_ID_RE,
  SESSION_ID_RE,
  type Directory,
  type Hello,
  type InstallationSettings,
  type MessageReceipt,
  type ProviderConnection,
} from "../../cloud/protocol";
import { installSkill, installedSkills, readManifest, readSkillDir, type InstallResult } from "../../cloud/skillbundle";
import { listAccounts } from "../db";
import type { Fleet } from "../fleet";
import { userHome } from "../paths";
import { parseFrontmatter, skillRoots } from "../skills";
import {
  cloudConfig,
  cloudDir,
  readCredential,
  readInstallationSettings,
  removeCredential,
  writeCredential,
  writeInstallationSettings,
  type Credential,
} from "./config";
import { deliverInbound, type DeliveryFleet } from "./deliver";
import { CloudStore, type OutboxRow } from "./store";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

export type BridgeState = "local" | "unregistered" | "connecting" | "connected" | "offline" | "revoked";

export interface CloudStatus {
  configured: boolean;
  configError: string | null;
  /** Public by design: the browser signs in with these. */
  url: string | null;
  publishableKey: string | null;
  installation: { id: string; workspaceId: string; workspaceSlug: string; name: string } | null;
  state: BridgeState;
  lastOkAt: number | null;
  lastError: string | null;
  hello: Hello | null;
  counts: { outbox: Record<string, number>; inbox: Record<string, number> };
  settings: InstallationSettings;
  /** What to call this machine when registering it, unless you say. */
  hostname: string;
}

export interface OutboundResult {
  clientId: string;
  state: OutboxRow["state"];
  to: string;
  message: MessageReceipt | null;
  error: string | null;
}

const HELLO_EVERY_MS = 5 * 60_000;
const PROVIDERS_EVERY_MS = 30 * 60_000;
const DIRECTORY_FOR_MS = 60_000;
/** How long `send` waits for the cloud before answering "queued here". */
const SEND_WAIT_MS = 8_000;
/** How long resolving an address waits for the cloud before the last directory. */
const RESOLVE_WAIT_MS = 3_000;

const skillRootDir = (s: InstallationSettings): string => join(userHome(), s.skillRoot === "agents" ? ".agents" : ".claude", "skills");

export class CloudBridge {
  #cfg: CloudConfig | null = null;
  #configError: string | null = null;
  #cred: Credential | null = null;
  #api: InstallationCloud | null = null;
  #store: CloudStore | null = null;
  #state: BridgeState = "local";
  #hello: Hello | null = null;
  #helloAt = 0;
  #lastOkAt: number | null = null;
  #lastError: string | null = null;
  #providers = { hash: "", at: 0 };
  #directory: { at: number; dir: Directory } | null = null;
  #known = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticking: Promise<void> | null = null;

  constructor(
    private readonly fleet: DeliveryFleet & Pick<Fleet, "sessions">,
    private readonly version: string,
  ) {}

  get store(): CloudStore {
    return (this.#store ??= new CloudStore());
  }

  /** Read the configuration and credential again (after registering, forgetting, or editing cloud.env). */
  reload(): void {
    const { config, error } = cloudConfig();
    this.#cfg = config;
    this.#configError = error;
    this.#cred = config ? readCredential(config) : null;
    this.#api = config && this.#cred ? new InstallationCloud(supabaseFor(config), this.#cred.secret) : null;
    this.#hello = null;
    this.#helloAt = 0;
    this.#directory = null;
    this.#state = !config ? "local" : !this.#cred ? "unregistered" : "connecting";
    this.#lastError = error;
  }

  start(): void {
    this.reload();
    const loop = (): void => {
      this.#timer = setTimeout(async () => {
        await this.tick().catch((e: unknown) => console.error("agentbox cloud:", e));
        loop();
      }, readInstallationSettings().pollSeconds * 1000);
      this.#timer.unref?.();
    };
    loop();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  status(): CloudStatus {
    if (!this.#cfg && this.#state === "local" && !this.#configError) this.reload();
    return {
      configured: Boolean(this.#cfg),
      configError: this.#configError,
      url: this.#cfg?.url ?? null,
      publishableKey: this.#cfg?.publishableKey ?? null,
      installation: this.#cred
        ? { id: this.#cred.installationId, workspaceId: this.#cred.workspaceId, workspaceSlug: this.#cred.workspaceSlug, name: this.#cred.name }
        : null,
      state: this.#state,
      lastOkAt: this.#lastOkAt,
      lastError: this.#lastError,
      hello: this.#hello,
      counts: this.#cfg ? this.store.counts() : { outbox: {}, inbox: {} },
      settings: readInstallationSettings(),
      hostname: hostname().split(".")[0]!.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48),
    };
  }

  /** The installation client, or why there is none. */
  api(): InstallationCloud {
    if (!this.#cfg) throw new CloudError(this.#configError ?? "agentbox cloud is not set up on this machine (docs/cloud.md)", 409);
    if (!this.#api) throw new CloudError("this machine is not registered with the cloud: sign in on the Team page, or run `agentbox cloud login`", 409);
    return this.#api;
  }

  settings(patch: Partial<InstallationSettings>): InstallationSettings {
    const s = writeInstallationSettings(patch);
    this.#providers.hash = ""; // shareAccountEmails may have changed what is sent
    return s;
  }

  // ---------------------------------------------------------- registration

  /** Keep `secret` as this machine's credential, once the cloud has said
   *  hello to it. Minted by the owner's browser or `agentbox cloud login`. */
  async register(secret: string): Promise<CloudStatus> {
    if (!this.#cfg) this.reload();
    const cfg = this.#cfg;
    if (!cfg) throw new CloudError(this.#configError ?? "agentbox cloud is not set up on this machine (docs/cloud.md)", 409);
    const api = new InstallationCloud(supabaseFor(cfg), secret);
    const hello = await api.hello(this.version, process.platform);
    writeCredential({
      v: 1,
      url: cfg.url,
      installationId: hello.installation.id,
      workspaceId: hello.workspace.id,
      workspaceSlug: hello.workspace.slug,
      name: hello.installation.name,
      secret,
      savedAt: new Date().toISOString(),
    });
    this.reload();
    await this.tick();
    return this.status();
  }

  /** Drop this machine's credential; `revoke` also ends it in the cloud. */
  async forget(revoke: boolean): Promise<CloudStatus> {
    if (revoke && this.#api) {
      try {
        await this.#api.revokeSelf();
      } catch (e) {
        if (!(e instanceof CloudError && e.status === 401)) throw e;
      }
    }
    removeCredential();
    this.reload();
    return this.status();
  }

  // ------------------------------------------------------------------ pass

  /** One pass; overlapping calls share it. */
  tick(): Promise<void> {
    return (this.#ticking ??= this.#pass().finally(() => {
      this.#ticking = null;
    }));
  }

  async #pass(): Promise<void> {
    if (!this.#cfg) this.reload();
    const api = this.#api;
    if (!api || this.#state === "revoked") return;
    const now = Date.now();
    try {
      if (!this.#hello || now - this.#helloAt > HELLO_EVERY_MS) {
        this.#hello = await api.hello(this.version, process.platform);
        this.#helloAt = now;
      }
      await this.#syncProviders(api, now);
      if (!this.#directory || now - this.#directory.at > HELLO_EVERY_MS * 2) await this.directory(true);
      const unsent = await this.#flush(api);
      await this.#receive(api);
      if (unsent) throw unsent;
      this.#state = "connected";
      this.#lastOkAt = Date.now();
      this.#lastError = null;
    } catch (e) {
      const err = e instanceof CloudError ? e : new CloudError((e as Error).message, 500);
      this.#lastError = err.message;
      if (err.status === 401) {
        this.#state = "revoked";
        this.#lastError = `${err.message}. Register this machine again to reconnect.`;
      } else {
        this.#state = "offline";
      }
    }
  }

  async #syncProviders(api: InstallationCloud, now: number): Promise<void> {
    const shareEmails = readInstallationSettings().shareAccountEmails;
    // A label defaults to the account's email, so without consent to share
    // emails a label that looks like one is replaced too.
    const list: ProviderConnection[] = listAccounts().map((a) => ({
      provider: a.provider,
      account_label: (shareEmails || !a.label.includes("@") ? a.label.slice(0, 120) : "") || `${a.provider} account ${a.id.slice(0, 6)}`,
      account_email: shareEmails ? a.email : null,
      plan: a.plan,
    }));
    const hash = createHash("sha256").update(JSON.stringify(list)).digest("hex");
    if (hash === this.#providers.hash && now - this.#providers.at < PROVIDERS_EVERY_MS) return;
    await api.syncProviders(list);
    this.#providers = { hash, at: now };
  }

  /** Each due message on its own: one that cannot go yet does not hold up
   *  the others, nor what is waiting to be received. */
  async #flush(api: InstallationCloud): Promise<CloudError | null> {
    let first: CloudError | null = null;
    for (const row of this.store.due(Date.now())) {
      try {
        await this.#push(api, row);
      } catch (e) {
        const err = e instanceof CloudError ? e : new CloudError((e as Error).message, 500);
        if (err.status === 401) throw err;
        first ??= err;
      }
    }
    return first;
  }

  async #push(api: InstallationCloud, row: OutboxRow): Promise<void> {
    if (row.body === null) return;
    try {
      const r = await api.send({
        clientId: row.client_id,
        target: row.target,
        targetAgent: row.target_agent,
        body: row.body,
        senderAgent: row.sender_agent,
        wake: row.wake === 1,
      });
      this.store.accepted(row.client_id, r.message.id);
    } catch (e) {
      // A rate refusal is the workspace's answer, not the network's: final.
      if (e instanceof CloudError && (!e.transient || e.status === 429) && e.status !== 401) this.store.refused(row.client_id, e.message);
      else {
        this.store.retryLater(row.client_id, (e as Error).message, Date.now());
        throw e;
      }
    }
  }

  async #receive(api: InstallationCloud): Promise<void> {
    // Answers that did not reach the cloud last time go first.
    // 409: the cloud already has an answer; 404: the message is gone (purged).
    const settled = (e: unknown) => {
      if (!(e instanceof CloudError && (e.status === 409 || e.status === 404))) throw e;
    };
    for (const row of this.store.unacked(this.#cred!.installationId)) {
      await api.ack(row.message_id, row.outcome!, row.reason).catch(settled);
      this.store.acked(row.message_id);
    }
    const allowRemoteWake = readInstallationSettings().allowRemoteWake;
    for (const m of await api.fetch(20)) {
      const d = await deliverInbound(this.fleet, this.store, m, { allowRemoteWake }, Date.now());
      await api.ack(m.id, d.outcome, d.reason).catch(settled);
      this.store.acked(m.id);
    }
  }

  // -------------------------------------------------------------- messages

  /** The workspace as this machine can address it. Offline, the last one
   *  seen, so a message to a known machine still queues. */
  async directory(fresh = false): Promise<Directory> {
    const api = this.api();
    if (!fresh && this.#directory && Date.now() - this.#directory.at < DIRECTORY_FOR_MS) return this.#directory.dir;
    try {
      const dir = await api.directory();
      this.#directory = { at: Date.now(), dir };
      this.store.put(`directory:${this.#cred!.installationId}`, dir);
      return dir;
    } catch (e) {
      const last = e instanceof CloudError && e.transient ? this.store.get<Directory>(`directory:${this.#cred!.installationId}`) : null;
      if (!last) throw e;
      return last;
    }
  }

  /** `installation/session`, the installation by name or id. */
  async resolve(address: string): Promise<{ id: string; name: string; session: string }> {
    const at = address.indexOf("/");
    const inst = at < 0 ? address : address.slice(0, at);
    const session = at < 0 ? "" : address.slice(at + 1);
    if (!inst || !SESSION_ID_RE.test(session)) {
      throw new CloudError(`"${address}" is not an address: write <installation>/<session id>, as \`agentbox cloud dir\` lists them`, 400);
    }
    const find = (d: Directory | null | undefined) => d?.installations.find((i) => i.id === inst || i.name.toLowerCase() === inst.toLowerCase());
    // The cloud's answer when it comes soon: a name can move to a new
    // installation. The last directory only when it does not, so a send
    // while offline still queues.
    let fresh: Directory | null = null;
    try {
      fresh = await Promise.race([this.#api!.directory(), Bun.sleep(RESOLVE_WAIT_MS).then(() => null)]);
    } catch (e) {
      if (!(e instanceof CloudError && e.transient)) throw e;
    }
    if (fresh) {
      this.#directory = { at: Date.now(), dir: fresh };
      this.store.put(`directory:${this.#cred!.installationId}`, fresh);
    }
    const hit = fresh ? find(fresh) : find(this.#directory?.dir ?? this.store.get<Directory>(`directory:${this.#cred?.installationId}`));
    if (!hit) throw new CloudError(`no installation "${inst}" in this workspace`, 404);
    return { id: hit.id, name: hit.name, session };
  }

  /** Queue a message from this machine and try to hand it over now. A
   *  refusal comes back at once; an unreachable cloud leaves it queued. */
  async send(m: { to: string; text: string; senderAgent: string | null; wake: boolean; clientId?: string }): Promise<OutboundResult> {
    const api = this.api();
    const clientId = m.clientId ?? `ab_${randomBytes(12).toString("base64url")}`;
    if (!CLIENT_MSG_ID_RE.test(clientId)) throw new CloudError("a message id is 8 to 64 of A-Z a-z 0-9 _ -", 400);
    // The same id is the same message (a retry): with another one, refused.
    const fingerprint = createHash("sha256").update(JSON.stringify([m.to, m.text, m.wake, m.senderAgent])).digest("hex");
    let row = this.store.outbox(clientId);
    if (row && row.fingerprint !== fingerprint) throw new CloudError(`message id ${clientId} was already used for a different message`, 409);
    if (!row) {
      const target = await this.resolve(m.to);
      if (m.senderAgent && !this.#known.has(m.senderAgent)) {
        const s = this.fleet.sessions().find((x) => x.id === m.senderAgent);
        await api.upsertAgent(m.senderAgent, { provider: s?.provider ?? null }).catch(() => undefined);
        this.#known.add(m.senderAgent);
      }
      row = this.store.queue(
        { client_id: clientId, fingerprint, target: target.id, target_name: target.name, target_agent: target.session, sender_agent: m.senderAgent, body: m.text, wake: m.wake },
        Date.now(),
      );
    }
    // Hand it over now if the cloud answers soon; otherwise it stays queued
    // and the next pass sends it (the id makes a second try the same message).
    if (row.state === "pending") {
      const pushing = this.#push(api, row).catch(() => undefined);
      await Promise.race([pushing, Bun.sleep(SEND_WAIT_MS)]);
    }
    row = this.store.outbox(clientId)!;
    const message = row.message_id ? ((await api.messages("out", { ids: [row.message_id] }).catch(() => []))[0] ?? null) : null;
    return { clientId, state: row.state, to: `${row.target_name}/${row.target_agent ?? ""}`, message, error: row.error };
  }

  /** Receipts for what this machine sent or got, with what is still queued here. */
  async messages(box: "in" | "out", limit = 50): Promise<{ cloud: MessageReceipt[]; queued: OutboxRow[] }> {
    const cloud = await this.api().messages(box, { limit });
    const queued = box === "out" ? this.store.recentOutbox(limit).filter((r) => r.state !== "accepted").map((r) => ({ ...r, body: null })) : [];
    return { cloud, queued };
  }

  /** List (or unlist) a local session in the workspace directory. */
  async share(sessionId: string, listed: boolean) {
    const s = this.fleet.sessions().find((x) => x.id === sessionId);
    if (!s) throw new CloudError(`no session ${sessionId}`, 404);
    this.#directory = null;
    return this.api().upsertAgent(s.id, { provider: s.provider, label: (s.label ?? s.title).slice(0, 120), listed });
  }

  // ---------------------------------------------------------------- skills

  /** Install revision `rev` of a workspace skill, keeping local edits. */
  async installSkill(name: string, rev: number, force: boolean): Promise<InstallResult> {
    const api = this.api();
    const { skill, revision } = await api.skill(name, rev);
    const cred = this.#cred!;
    const base = join(cloudDir(), "skills");
    return installSkill({
      root: skillRootDir(readInstallationSettings()),
      name: skill.name,
      revision,
      source: { url: cred.url, workspaceId: cred.workspaceId, workspaceSlug: cred.workspaceSlug, skillId: skill.id },
      incomingDir: join(base, "incoming"),
      backupDir: join(base, "backup"),
      force,
    });
  }

  installed() {
    return installedSkills([join(userHome(), ".claude", "skills"), join(userHome(), ".agents", "skills")]).filter(
      (s) => !this.#cred || s.manifest.source.url === this.#cred.url,
    );
  }

  /** Publish a local skill directory (by name from the skill roots, or a
   *  path). One installed from the cloud publishes on top of the revision it
   *  came from, so someone else's newer revision is not silently replaced. */
  async publishSkill(opts: { name?: string; path?: string; summary?: string; baseRev?: number | null }) {
    const api = this.api();
    const dir = opts.path ?? skillRoots().find((r) => r.source !== "project" && existsSync(join(r.dir, opts.name ?? "", "SKILL.md")))?.dir;
    if (!dir) throw new CloudError(`no local skill "${opts.name}"`, 404);
    const skillDir = opts.path ?? join(dir, opts.name!);
    const files = readSkillDir(skillDir);
    const front = parseFrontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
    const name = opts.name ?? front.name ?? skillDir.split("/").pop()!;
    const manifest = readManifest(skillDir);
    const baseRev = opts.baseRev !== undefined ? opts.baseRev : manifest?.rev ?? null;
    const published = await api.publishSkill({ name, files, description: front.description ?? "", baseRev, summary: opts.summary });
    if (manifest && !published.unchanged) {
      // Its files are that revision now: record it, so the next install
      // does not take them for edits.
      await this.installSkill(name, published.revision.rev, false).catch(() => undefined);
    }
    return published;
  }
}
