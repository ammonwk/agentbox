/** Shared recommendations are operational artifacts; transcript pages only cross
 * an ephemeral authenticated ECDH/AES-GCM relay and are never written to cloud. */
import { z } from "zod";
import { cloudCall, type HumanCloud } from "./client";
import type { TimelineEvent } from "../core/types";
export const ProposalInput = z
  .object({
    title: z.string().min(1).max(200),
    finding: z.string().min(1).max(4000),
    reason: z.string().max(2000).default(""),
    next: z.string().min(1).max(2000),
    evidence: z
      .array(
        z
          .object({
            url: z
              .string()
              .url()
              .refine((s) => /^https?:\/\//.test(s)),
            label: z.string().max(200),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    action: z.string().uuid().nullable().default(null),
  })
  .strict();
export type ProposalInput = z.infer<typeof ProposalInput>;
export const Proposal = z.object({
  id: z.string(),
  agent_id: z.string(),
  run_id: z.string(),
  config_revision: z.number(),
  title: z.string(),
  finding: z.string(),
  reason: z.string(),
  next_step: z.string(),
  evidence: ProposalInput.shape.evidence,
  action_id: z.string().nullable(),
  state: z.enum(["open", "approved", "dismissed"]),
  decided_by: z.string().nullable(),
  delivery: z
    .object({
      request: z.string(),
      state: z.enum(["queued", "attempting", "sent", "refused", "uncertain"]),
      result: z.string(),
    })
    .optional(),
  created_at: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;
export const CommandReceipt = z.object({
  id: z.string(),
  state: z.enum(["queued", "attempting", "sent", "refused", "uncertain"]),
  result: z.string(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;
export const ReadCursor = z
  .object({
    session: z.number().int().min(0).max(10000).default(0),
    before: z.string().max(500).nullable().default(null),
    target: z.string().min(1).max(200).optional(),
    list: z.boolean().optional(),
    offset: z.number().int().min(0).max(100000).optional(),
    /** Reading `target`'s main chat back into this earlier conversation,
     *  one whose summary `target` started from. */
    history: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ReadCursor = z.infer<typeof ReadCursor>;
/** A message of an earlier conversation shown in the main chat: its source
 *  session (ids are prefixed with it), and `carried`: the handoff that carried it into
 *  the current conversation in its place. `oldest` marks the start of what
 *  was carried. */
export type ChatEvent = TimelineEvent & {
  source?: string;
  carried?: { handoff: string; at: number; oldest: boolean };
};
export type AgentThread = {
  id: string; run: string; title: string; status: string; at: number;
  /** Main-chat provider conversations stay out of the work-session rail. */
  kind?: "conversation" | "work";
  cacheWarmUntil?: number;
  canRestore?: boolean;
  active: boolean; writable: boolean; successor: string | null;
};
export type ConversationPage = {
  threads?: AgentThread[];
  counts?: { active: number; inactive: number };
  more?: number | null;
  thread?: AgentThread;
  events: ChatEvent[];
  next: ReadCursor | null;
  session: string | null;
  status: string;
  error?: string;
};
const encode = (b: ArrayBuffer | Uint8Array) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(
        b instanceof Uint8Array
          ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
          : b,
      ),
    ),
  );
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function relayIdentity() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  return {
    pair,
    key: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}
async function relayKey(pair: CryptoKeyPair, peer: string) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decode(peer),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    pair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealPage(
  pair: CryptoKeyPair,
  peer: string,
  id: string,
  page: ConversationPage,
) {
  const data = new TextEncoder().encode(JSON.stringify(page));
  if (data.byteLength > 750000) throw new Error("Conversation page too large");
  const key = await relayKey(pair, peer),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
      key,
      data,
    ),
  );
  // Chunk before base64 to stay below Realtime's per-event bound.
  const chunks = [];
  for (let at = 0; at < encrypted.length; at += 30000)
    chunks.push(encode(encrypted.slice(at, at + 30000)));
  return { iv: encode(iv), chunks };
}
export async function openPage(
  pair: CryptoKeyPair,
  peer: string,
  id: string,
  iv: string,
  chunks: string[],
): Promise<ConversationPage> {
  if (chunks.length > 26) throw new Error("Relay response too large");
  const all = chunks.map(decode),
    out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(iv),
      additionalData: new TextEncoder().encode(id),
    },
    await relayKey(pair, peer),
    out,
  );
  return JSON.parse(new TextDecoder().decode(data));
}
export class AgentConversation {
  constructor(readonly human: HumanCloud) {}
  async proposals(agent: string) {
    return cloudCall(
      this.human.sb,
      "agent_proposals_list",
      { p_agent: agent },
      z.array(Proposal),
    );
  }

  guide(
    agent: string,
    run: string,
    id: string,
    body: string,
    proposal: string | null = null,
    session?: string | null,
  ) {
    return cloudCall(
      this.human.sb,
      session === undefined ? "agent_guide" : "agent_session_guide",
      {
        p_agent: agent,
        p_run: run,
        p_id: id,
        p_body: body,
        p_proposal: proposal,
        ...(session === undefined ? {} : { p_session: session }),
      },
      CommandReceipt,
    );
  }
  receipt(id: string) {
    return cloudCall(
      this.human.sb,
      "agent_command_receipt",
      { p_id: id },
      CommandReceipt,
    );
  }
  decide(id: string, decision: "approved" | "dismissed", request: string) {
    return cloudCall(
      this.human.sb,
      "agent_proposal_decide",
      { p_id: id, p_decision: decision, p_request: request },
      Proposal,
    );
  }
  async read(
    agent: string,
    cursor: ReadCursor = { session: 0, before: null },
    signal?: AbortSignal,
  ): Promise<ConversationPage> {
    const id = crypto.randomUUID(),
      identity = await relayIdentity(),
      sb = this.human.sb;
    const channel = sb.channel(`agent-read:${id}`, {
      config: { broadcast: { ack: true } },
    });
    let timer: ReturnType<typeof setTimeout> | undefined, ended = false, queued: Promise<unknown> | undefined, abort: (() => void) | undefined;
    try {
      return await new Promise<ConversationPage>((resolve, reject) => {
        const chunks = new Map<number, string>();
        let expected = 0,
          iv = "",
          reading = false,
          bytes = 0;
        const fail = () =>
          reject(
            new Error(
              "Execution host unavailable. Feed and shared status are still available.",
            ),
          );
        abort = fail;
        if (signal?.aborted) { fail(); return; }
        signal?.addEventListener("abort", fail, { once: true });
        timer = setTimeout(fail, 45000);
        channel
          .on("broadcast", { event: "page" }, async ({ payload }) => {
            if (
              reading ||
              !payload ||
              !Number.isInteger(payload.index) ||
              !Number.isInteger(payload.total) ||
              payload.total < 1 ||
              payload.total > 26 ||
              payload.index < 0 ||
              payload.index >= payload.total ||
              typeof payload.data !== "string" ||
              payload.data.length > 41000 ||
              typeof payload.iv !== "string" ||
              payload.iv.length > 30
            )
              return;
            if (expected && (expected !== payload.total || iv !== payload.iv))
              return;
            expected = payload.total;
            iv = payload.iv;
            if (!chunks.has(payload.index)) {
              bytes += payload.data.length;
              if (bytes > 1100000) {
                fail();
                return;
              }
              chunks.set(payload.index, payload.data);
            }
            if (chunks.size !== expected) return;
            reading = true;
            try {
              // Cloud returns the host's authenticated ephemeral key only to the
              // original requester while membership and host grants remain current.
              const key = await cloudCall(
                sb,
                "agent_read_key",
                { p_id: id },
                z.string().nullable(),
              );
              if (!key) throw new Error("Host key unavailable");
              const page = await openPage(
                identity.pair,
                key,
                id,
                iv,
                Array.from({ length: expected }, (_, i) => chunks.get(i)!),
              );
              resolve(page);
            } catch (e) {
              reject(e);
            }
          })
          .subscribe(async (status) => {
            if (ended) return;
            if (status === "SUBSCRIBED" && !queued)
              try {
                queued = cloudCall(
                  sb,
                  "agent_read_request",
                  {
                    p_id: id,
                    p_agent: agent,
                    p_key: identity.key,
                    p_cursor: ReadCursor.parse(cursor),
                  },
                  z.unknown(),
                );
                await queued;
              } catch (e) {
                reject(e);
              }
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
              fail();
          });
      });
    } finally {
      ended = true;
      if (abort) signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      await sb.removeChannel(channel);
      await queued?.catch(() => undefined);
      await cloudCall(sb, "agent_read_done", { p_id: id }, z.unknown()).catch(
        () => undefined,
      );
    }
  }
}
