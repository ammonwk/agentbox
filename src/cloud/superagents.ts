/** Typed clients of the shared superagents (docs/cloud.md, "Shared
 *  superagents"; supabase/migrations/20261015120000_shared_superagents.sql).
 *
 *  - `HumanSuperagents`: a signed-in person. The directory, the live relay
 *    (a page of an instance's chat or view, sealed end to end), guidance and
 *    actions, contact preferences, and, for the host owner, share, update
 *    and unshare.
 *  - `InstallationSuperagents`: the host machine, with its own secret
 *    (`InstallationCloud`). What teammates asked of it, the relay's host
 *    side, and the claims of its shared instances.
 *
 *  A page crosses Realtime Broadcast sealed with an ephemeral ECDH key pair
 *  per read and AES-GCM (relay.ts). The browser gets the host's public key
 *  only from the cloud, which gives it only to the person who asked while
 *  they can still see the instance: an observer of the channel, or a host
 *  that is not the instance's, cannot read or forge a page. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CloudError, cloudCall, type InstallationCloud } from "./client";
import { Person } from "./protocol";
import { openPage, relayIdentity, sealPage } from "./relay";

// ---------------------------------------------------------------- schemas

export const SuperagentSource = z.object({ repo: z.string(), path: z.string(), commit: z.string() });
export type SuperagentSource = z.infer<typeof SuperagentSource>;

export const SuperagentInstance = z.looseObject({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  source: SuperagentSource.nullable(),
  maintainers: z.array(z.string()),
  visibility: z.enum(["private", "workspace"]),
  revision: z.number(),
  shared_by: Person,
  host: z.looseObject({ installation_id: z.string(), name: z.string().nullable(), live: z.boolean(), last_seen_at: z.string().nullable() }),
  /** You own its host: you can change or unshare it. */
  can_edit: z.boolean(),
  maintainer: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  unshared_at: z.string().nullable(),
});
export type SuperagentInstance = z.infer<typeof SuperagentInstance>;

export const COMMAND_STATES = ["queued", "attempting", "sent", "refused", "failed", "uncertain"] as const;
export const CommandReceipt = z.looseObject({
  id: z.string(),
  instance_id: z.string(),
  kind: z.enum(["guide", "action"]),
  state: z.enum(COMMAND_STATES),
  result: z.string(),
  expected_session: z.string().nullable(),
  host_key: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;

export const ContactPreference = z.looseObject({
  id: z.string(),
  workspace_id: z.string(),
  user_id: z.string(),
  repo: z.string(),
  instance_id: z.string().nullable(),
  allowed: z.boolean(),
  github_user_id: z.number().nullable(),
  updated_at: z.string(),
});
export type ContactPreference = z.infer<typeof ContactPreference>;

export const PendingRead = z.looseObject({
  id: z.string(),
  instance_id: z.string(),
  name: z.string(),
  kind: z.enum(["chat", "view"]),
  request: z.record(z.string(), z.unknown()),
  client_key: z.string(),
});
export type PendingRead = z.infer<typeof PendingRead>;
export const PendingCommand = z.looseObject({
  id: z.string(),
  instance_id: z.string(),
  name: z.string(),
  kind: z.enum(["guide", "action"]),
  state: z.enum(["queued", "attempting"]),
  expected_session: z.string().nullable(),
});
export type PendingCommand = z.infer<typeof PendingCommand>;
export const Pending = z.object({ reads: z.array(PendingRead), commands: z.array(PendingCommand) });
export type Pending = z.infer<typeof Pending>;

export const ClaimedCommand = z.looseObject({
  id: z.string(),
  instance_id: z.string(),
  kind: z.enum(["guide", "action"]),
  body: z.record(z.string(), z.unknown()).nullable(),
  expected_session: z.string().nullable(),
  client_key: z.string().nullable(),
  sender: Person,
});
export type ClaimedCommand = z.infer<typeof ClaimedCommand>;

export const CloudClaim = z.looseObject({
  key: z.string(),
  source: z.string(),
  scope: z.enum(["work", "env"]),
  fence: z.number(),
  lease_until: z.number(),
  state: z.enum(["active", "uncertain", "takeover_requested", "released"]),
  instance_id: z.string(),
  instance_name: z.string(),
  host_installation_id: z.string(),
  host_name: z.string().nullable(),
  session: z.string().nullable(),
  note: z.string().nullable(),
});
export type CloudClaim = z.infer<typeof CloudClaim>;

// ------------------------------------------------------------ relay pages

/** Where a chat page starts: `before` from the last page, and the
 *  conversation it was read from (its main, or one before it). */
export const ChatCursor = z
  .object({
    before: z.string().max(500).nullable().default(null),
    session: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  })
  .strict();
export type ChatCursor = z.infer<typeof ChatCursor>;
export const ViewRequest = z.object({ tab: z.string().max(100).nullable().default(null) }).strict();

/** What a teammate sees of the chat: what was said, and the questions it
 *  asked. No tool call, no tool output, credentials redacted. */
export type TeamChatEvent =
  | { id: string; at: number; kind: "user" | "assistant"; text: string }
  | { id: string; at: number; kind: "question"; questions: { question: string; options: string[] }[]; answers: Record<string, string> | null };
export interface TeamChatPage {
  /** The conversation read, which guidance must name (`expectedSession`). */
  session: string | null;
  /** Its main conversation now; differs from `session` when reading an earlier one. */
  main: string | null;
  /** The conversations before the main, newest first. */
  previous: string[];
  status: string | null;
  title: string;
  events: TeamChatEvent[];
  /** Pass back as the cursor's `before` for the page before this one; null at the start. */
  before: string | null;
  error?: string;
}
export interface TeamViewPage {
  view: unknown;
  error?: string;
}
/** A page action's outcome, sealed for the person who took it. */
export type TeamActionAnswer = { ok: true; answer: unknown } | { ok: false; error: string };

export const RELAY_EVENT = "page";
export const relayChannel = (id: string): string => `superagent-relay:${id}`;
/** The relay's limits: chunks of 30 KB of ciphertext, at most 26 of them. */
const MAX_CHUNKS = 26;

/** The browser's crypto, or why there is none: WebCrypto's ECDH runs only in
 *  a secure context (https, localhost, 127.0.0.1). */
export function relayUnavailable(): string | null {
  const g = globalThis as { isSecureContext?: boolean; crypto?: Crypto };
  if (g.isSecureContext === false || !g.crypto?.subtle)
    return "Reading a shared superagent needs a secure context: open agentbox at https://, localhost or 127.0.0.1. Its pages are end-to-end encrypted with WebCrypto, which browsers turn off elsewhere.";
  return null;
}

// ---------------------------------------------------------------- human

export interface ShareInput {
  installation: string;
  name: string;
  title: string;
  description?: string;
  source?: SuperagentSource | null;
  visibility: "private" | "workspace";
  maintainers?: string[];
}

export class HumanSuperagents {
  constructor(readonly sb: SupabaseClient) {}

  /** The instances of a workspace that you can see. */
  directory(workspace: string): Promise<SuperagentInstance[]> {
    return cloudCall(this.sb, "superagent_directory", { p_workspace: workspace }, z.array(SuperagentInstance));
  }

  /** Share a superagent of `installation`, or change how it is shared: its owner only. */
  share(s: ShareInput): Promise<SuperagentInstance> {
    return cloudCall(
      this.sb,
      "superagent_share",
      {
        p_installation: s.installation,
        p_name: s.name,
        p_title: s.title,
        p_description: s.description ?? "",
        p_source: s.source ?? null,
        p_visibility: s.visibility,
        p_maintainers: s.maintainers ?? null,
      },
      SuperagentInstance,
    );
  }

  update(
    instance: string,
    patch: { revision?: number; title?: string; description?: string; source?: SuperagentSource; visibility?: "private" | "workspace"; maintainers?: string[] },
  ): Promise<SuperagentInstance> {
    return cloudCall(
      this.sb,
      "superagent_update",
      {
        p_instance: instance,
        p_revision: patch.revision ?? null,
        p_title: patch.title ?? null,
        p_description: patch.description ?? null,
        p_source: patch.source ?? null,
        p_visibility: patch.visibility ?? null,
        p_maintainers: patch.maintainers ?? null,
      },
      SuperagentInstance,
    );
  }

  unshare(instance: string): Promise<SuperagentInstance> {
    return cloudCall(this.sb, "superagent_unshare", { p_instance: instance }, SuperagentInstance);
  }

  /** A page of its chat, read through the relay. */
  readChat(instance: string, cursor: Partial<ChatCursor> = {}, signal?: AbortSignal): Promise<TeamChatPage> {
    return this.read<TeamChatPage>(instance, "chat", ChatCursor.parse(cursor), signal);
  }

  /** Its page (the program's view blocks), read through the relay. */
  async readView(instance: string, tab: string | null = null, signal?: AbortSignal): Promise<TeamViewPage> {
    return this.read<TeamViewPage>(instance, "view", ViewRequest.parse({ tab }), signal);
  }

  /** Guidance to its main conversation, delivered only into `expectedSession`
   *  (the `session` of the chat page you read). A retry with the same
   *  `sendId` (a UUID) is the same message. */
  guide(instance: string, text: string, sendId: string, expectedSession: string): Promise<CommandReceipt> {
    return cloudCall(this.sb, "superagent_guide", { p_id: sendId, p_instance: instance, p_text: text, p_expected_session: expectedSession }, CommandReceipt);
  }

  receipt(id: string): Promise<CommandReceipt> {
    return cloudCall(this.sb, "superagent_command_receipt", { p_id: id }, CommandReceipt);
  }

  /** Take an action on its page and wait for the program's answer, sealed
   *  for you. Without an answer (refused before it ran, or the relay lost
   *  it) `answer` is null and the receipt says what happened. */
  async act(
    instance: string,
    action: string,
    values: Record<string, unknown> = {},
    opts: { tab?: string | null; id?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ receipt: CommandReceipt; answer: TeamActionAnswer | null }> {
    const why = relayUnavailable();
    if (why) throw new CloudError(why, 400);
    const id = opts.id ?? crypto.randomUUID();
    const identity = await relayIdentity();
    const last: { receipt: CommandReceipt | null; sentPolls: number } = { receipt: null, sentPolls: 0 };
    const final = (r: CommandReceipt | null) => !!r && r.state !== "queued" && r.state !== "attempting";
    const answer = await this.receive<TeamActionAnswer>(
      id,
      async () => {
        last.receipt = await cloudCall(
          this.sb,
          "superagent_act",
          { p_id: id, p_instance: instance, p_action: action, p_values: values, p_tab: opts.tab ?? null, p_key: identity.key },
          CommandReceipt,
        );
      },
      async () => (await this.receipt(id)).host_key,
      identity,
      {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 90_000,
        // A final receipt with no answer on its way ends the wait: refused
        // before it ran, or sent and its answer lost for two polls.
        poll: async () => {
          const r = (last.receipt = await this.receipt(id));
          if (r.state === "sent") last.sentPolls++;
          return final(r) && (r.state !== "sent" || last.sentPolls > 2);
        },
      },
    ).catch((e: unknown) => {
      if (final(last.receipt)) return null;
      throw e;
    });
    const receipt = await this.receipt(id).catch(() => last.receipt);
    if (!receipt) throw new CloudError("the cloud did not record the action", 502);
    return { receipt, answer };
  }

  /** Your own contact preferences. */
  async contactPreferences(workspace: string): Promise<ContactPreference[]> {
    const r = await this.sb.from("contact_preferences").select("*").eq("workspace_id", workspace).order("updated_at", { ascending: false });
    if (r.error) throw new CloudError(r.error.message, 500, r.error.code ?? null);
    return z.array(ContactPreference).parse(r.data);
  }

  /** Say whether a superagent's GitHub App may contact you: for a repo
   *  (`*`: all) and an instance (null: all). A no always wins over a yes. */
  setContactPreference(workspace: string, p: { repo?: string; instance?: string | null; allowed: boolean }): Promise<ContactPreference> {
    return cloudCall(this.sb, "contact_preference", { p_workspace: workspace, p_repo: p.repo ?? "*", p_instance: p.instance ?? null, p_allowed: p.allowed }, ContactPreference);
  }

  private async read<T>(instance: string, kind: "chat" | "view", request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const why = relayUnavailable();
    if (why) throw new CloudError(why, 400);
    const id = crypto.randomUUID();
    const identity = await relayIdentity();
    try {
      return await this.receive<T>(
        id,
        () => cloudCall(this.sb, "superagent_read_request", { p_id: id, p_instance: instance, p_kind: kind, p_request: request, p_key: identity.key }, z.unknown()).then(() => undefined),
        () => cloudCall(this.sb, "superagent_read_key", { p_id: id }, z.string().nullable()),
        identity,
        { signal, timeoutMs: 45_000 },
      );
    } finally {
      await cloudCall(this.sb, "superagent_read_done", { p_id: id }, z.unknown()).catch(() => undefined);
    }
  }

  /** Subscribe to `id`'s channel, then `ask`; collect the chunks, then ask
   *  the cloud for the host's key (`key`) and open the page. */
  private async receive<T>(
    id: string,
    ask: () => Promise<void>,
    key: () => Promise<string | null>,
    identity: Awaited<ReturnType<typeof relayIdentity>>,
    opts: { signal?: AbortSignal; timeoutMs: number; poll?: () => Promise<boolean> },
  ): Promise<T> {
    const channel = this.sb.channel(relayChannel(id), { config: { broadcast: { ack: true } } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    let asked: Promise<void> | undefined;
    let fail: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const chunks = new Map<number, string>();
        let total = 0;
        let iv = "";
        let bytes = 0;
        let opening = false;
        fail = () => reject(new CloudError("Its host did not answer. It runs on its owner's machine, which can be off or offline.", 504));
        if (opts.signal?.aborted) return fail();
        opts.signal?.addEventListener("abort", fail, { once: true });
        timer = setTimeout(fail, opts.timeoutMs);
        if (opts.poll)
          poller = setInterval(() => {
            if (opening) return;
            opts.poll!().then((done) => done && reject(new CloudError("ended without an answer", 409)), () => undefined);
          }, 2_000);
        channel
          .on("broadcast", { event: RELAY_EVENT }, async ({ payload }) => {
            const p = payload as { index?: unknown; total?: unknown; iv?: unknown; data?: unknown } | null;
            if (
              opening ||
              !p ||
              !Number.isInteger(p.index) ||
              !Number.isInteger(p.total) ||
              (p.total as number) < 1 ||
              (p.total as number) > MAX_CHUNKS ||
              (p.index as number) < 0 ||
              (p.index as number) >= (p.total as number) ||
              typeof p.data !== "string" ||
              p.data.length > 41_000 ||
              typeof p.iv !== "string" ||
              p.iv.length > 30
            )
              return;
            if (total && (total !== p.total || iv !== p.iv)) return;
            total = p.total as number;
            iv = p.iv;
            if (!chunks.has(p.index as number)) {
              bytes += p.data.length;
              if (bytes > 1_100_000) return fail!();
              chunks.set(p.index as number, p.data);
            }
            if (chunks.size !== total) return;
            opening = true;
            try {
              const host = await key();
              if (!host) throw new CloudError("its host's key is not there", 502);
              resolve(await openPage<T>(identity.pair, host, id, iv, Array.from({ length: total }, (_, i) => chunks.get(i)!)));
            } catch (e) {
              reject(e);
            }
          })
          .subscribe((status) => {
            if (status === "SUBSCRIBED" && !asked) {
              asked = ask();
              asked.catch(reject);
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new CloudError(`the live relay is unavailable (${status})`, 503));
          });
      });
    } finally {
      if (fail) opts.signal?.removeEventListener("abort", fail);
      clearTimeout(timer);
      clearInterval(poller);
      await this.sb.removeChannel(channel);
      await asked?.catch(() => undefined);
    }
  }
}

// --------------------------------------------------------------- machine

export class InstallationSuperagents {
  constructor(readonly inst: InstallationCloud) {}

  private call<T>(fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    return this.inst.superagentCall(fn, args, schema);
  }

  /** The superagents this machine shares now. */
  instances(): Promise<SuperagentInstance[]> {
    return this.call("inst_superagent_instances", {}, z.array(SuperagentInstance));
  }

  pending(): Promise<Pending> {
    return this.call("inst_superagent_pending", {}, Pending);
  }

  /** Give the read this machine's key; checks the reader again. Call it before each chunk. */
  readOffer(id: string, key: string): Promise<void> {
    return this.call("inst_superagent_read_offer", { p_id: id, p_key: key }, z.unknown()).then(() => undefined);
  }

  commandClaim(id: string, key: string | null): Promise<ClaimedCommand> {
    return this.call("inst_superagent_command_claim", { p_id: id, p_key: key }, ClaimedCommand);
  }

  /** Every permission again, right before typing or acting. */
  commandCheck(id: string): Promise<void> {
    return this.call("inst_superagent_command_check", { p_id: id }, z.unknown()).then(() => undefined);
  }

  commandResult(id: string, state: "sent" | "refused" | "failed" | "uncertain", result: string): Promise<void> {
    return this.call("inst_superagent_command_result", { p_id: id, p_state: state, p_result: result.slice(0, 1000) }, z.unknown()).then(() => undefined);
  }

  /** Seal `page` for `peerKey` and broadcast it in chunks on `id`'s channel.
   *  `before` runs before each chunk: the permission check, again. */
  async relay(id: string, pair: CryptoKeyPair, peerKey: string, page: unknown, before: () => Promise<void>): Promise<void> {
    const sealed = await sealPage(pair, peerKey, id, page);
    // Over the socket, acknowledged: every Realtime server takes that
    // (the REST broadcast endpoint is newer than some local stacks).
    const channel = this.inst.sb.channel(relayChannel(id), { config: { broadcast: { ack: true } } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CloudError("the live relay did not let this machine join in time", 503)), 8_000);
        channel.subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            clearTimeout(timer);
            reject(new CloudError(`the live relay is unavailable (${err?.message ?? status})`, 503));
          }
        });
      });
      for (let index = 0; index < sealed.chunks.length; index++) {
        await before();
        const r = await channel.send({ type: "broadcast", event: RELAY_EVENT, payload: { index, total: sealed.chunks.length, iv: sealed.iv, data: sealed.chunks[index] } });
        if (r !== "ok") throw new CloudError(`the live relay did not take a chunk (${r})`, 503);
      }
    } finally {
      await this.inst.sb.removeChannel(channel);
    }
  }

  // ---- claims

  claimAcquire(instance: string, scope: string, items: readonly { key: string; source: string }[], session: string | null, note: string | null): Promise<CloudClaim[]> {
    return this.call("inst_superagent_claim_acquire", { p_instance: instance, p_scope: scope, p_items: items, p_session: session, p_note: note }, z.array(CloudClaim));
  }

  claimAttach(instance: string, scope: string, key: string, fence: number, session: string): Promise<CloudClaim> {
    return this.call("inst_superagent_claim_attach", { p_instance: instance, p_scope: scope, p_key: key, p_fence: fence, p_session: session }, CloudClaim);
  }

  claimRelease(instance: string, scope: string, key: string, fence: number): Promise<CloudClaim> {
    return this.call("inst_superagent_claim_release", { p_instance: instance, p_scope: scope, p_key: key, p_fence: fence }, CloudClaim);
  }

  claimTakeoverRequest(instance: string, scope: string, key: string, fence: number): Promise<CloudClaim> {
    return this.call("inst_superagent_claim_takeover_request", { p_instance: instance, p_scope: scope, p_key: key, p_fence: fence }, CloudClaim);
  }

  claimTakeoverComplete(instance: string, scope: string, key: string, fence: number, session: string | null): Promise<CloudClaim> {
    return this.call("inst_superagent_claim_takeover_complete", { p_instance: instance, p_scope: scope, p_key: key, p_fence: fence, p_session: session }, CloudClaim);
  }

  claimRenew(live: readonly string[]): Promise<number> {
    return this.call("inst_superagent_claim_renew", { p_live: live }, z.number());
  }

  claimHandover(from: string, to: string): Promise<number> {
    return this.call("inst_superagent_claim_handover", { p_from: from, p_to: to }, z.number());
  }

  claims(f: { instance?: string; session?: string; key?: string; scope?: string; released?: boolean } = {}): Promise<CloudClaim[]> {
    return this.call(
      "inst_superagent_claims",
      { p_instance: f.instance ?? null, p_session: f.session ?? null, p_key: f.key ?? null, p_scope: f.scope ?? null, p_released: f.released ?? false },
      z.array(CloudClaim),
    );
  }

  /** For each numeric GitHub id, whether that person opted in for `repo` and `instance`. */
  contactCheck(instance: string | null, repo: string, githubIds: readonly number[]): Promise<{ id: number; allowed: boolean }[]> {
    return this.call(
      "inst_superagent_contact_check",
      { p_instance: instance, p_repo: repo, p_github_ids: githubIds },
      z.array(z.object({ id: z.number(), allowed: z.boolean() })),
    );
  }
}
