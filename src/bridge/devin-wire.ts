/** What the devin CLI (3000.11) says to its API server, as far as the bridge
 * needs it. devin speaks Connect over HTTP/1.1 with protobuf bodies; nothing
 * publishes the schemas, so the field numbers here were read off the wire and
 * named after the strings in the binary.
 *
 *   GetCliModelConfigs   unary; the response is the model catalog:
 *     1  ClientModelConfig, repeated
 *          1 label   18 max_tokens (the context window)   22 model_uid
 *          23 ModelInfo: 4 max_tokens, 13 max_output_tokens, 17 model_uid,
 *             20 harness uids, 23 family, 26 CompactionThresholds
 *             {1 spawn_tokens, 2 apply_tokens, 3 hard_tokens}, 27 aliases
 *          30 family metadata {1 label, 2 dimensions}   32 pricing rows
 *
 *   GetCliTeamSettings   unary; field 7 of the response, repeated, is
 *     allowed_model_uids: the uids `--model` may resolve to. With no team
 *     restriction it lists the whole catalog.
 *
 *   GetChatMessage       server-streaming; one request frame:
 *     2  system prompt
 *     3  messages, repeated: 1 id, 2 role (1 user, 2 assistant, 3 system,
 *        4 tool), 3 text, 6 tool calls {1 id, 2 name, 3 arguments JSON},
 *        7 the call a tool message answers, 10 images {1 base64, 2 MIME
 *        type}, 11 thinking, 12/18 its signature
 *     8  sampling: 2 max_tokens, 5 temperature, 7 top_k, 8 top_p
 *     10 tools, repeated: 1 name, 2 description, 3 JSON schema
 *     21 model_uid   28 session name   16 a request id
 *   and response frames of deltas:
 *     1 message_id   2 timestamp   3 delta_text   4 delta_tokens
 *     5 stop_reason (2 stop, 3 max tokens, 10 tool calls)
 *     6 delta_tool_calls {1 id, 2 name} to open a call, then {3 arguments}
 *     7 usage {2 input not read from cache, 3 output, 5 input read from
 *       cache, 9 model_uid}
 *     9 delta_thinking   12 latency   17 request_id
 *
 * A streaming body is a run of envelopes: a flag byte (1 gzip, 2 the last,
 * whose payload is JSON — `{}` or `{"error":{code,message}}`), a big-endian
 * length, the payload.
 */

import { gunzipSync } from "node:zlib";
import * as pb from "./pb";

// ---------------------------------------------------------------- envelopes

export function envelope(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

/** The payloads of a complete enveloped body, decompressed. */
export function envelopes(body: Uint8Array): { flags: number; payload: Uint8Array }[] {
  const out: { flags: number; payload: Uint8Array }[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let i = 0; i + 5 <= body.length; ) {
    const flags = body[i]!;
    const n = view.getUint32(i + 1);
    const raw = body.subarray(i + 5, i + 5 + n);
    out.push({ flags, payload: flags & 1 ? new Uint8Array(gunzipSync(raw)) : raw });
    i += 5 + n;
  }
  return out;
}

const json = new TextEncoder();

/** The envelope that ends a stream, with the error that ended it if any. */
export function endOfStream(error?: { code: string; message: string }): Uint8Array {
  return envelope(2, json.encode(JSON.stringify(error ? { error } : {})));
}

// ---------------------------------------------------------------- catalog

export interface CatalogModel {
  uid: string;
  label: string;
  family: string;
  /** What `--model` also accepts. */
  alias: string;
  /** The catalog entry to copy the rest from: its harness and features. */
  template: string;
  contextTokens: number;
  maxOutputTokens: number;
  /** devin starts writing a summary at `spawn`, swaps it in at `apply`, and
   *  refuses to send more than `hard`. */
  compaction: { spawn: number; apply: number; hard: number };
}

/** The catalog with `models` added, each a copy of its template's entry under
 *  its own name, window and compaction thresholds. A model whose template is
 *  missing is left out; one already present is replaced. */
export function withModels(catalog: Uint8Array, models: CatalogModel[]): Uint8Array {
  const top = pb.decode(catalog);
  const entries = top.filter((f) => f.no === 1 && f.wire === 2).map((f) => pb.decode(f.value as Uint8Array));
  const added: pb.Field[] = [];
  for (const m of models) {
    const tpl = entries.find((e) => pb.strOf(e, 22) === m.template);
    if (!tpl) continue;
    let info = pb.msgOf(tpl, 23) ?? [];
    info = pb.replace(info, 4, pb.int(4, m.contextTokens));
    info = pb.replace(info, 13, pb.int(13, m.maxOutputTokens));
    info = pb.replace(info, 17, pb.str(17, m.uid));
    info = pb.replace(info, 23, pb.str(23, m.alias));
    info = pb.replace(info, 26, pb.msg(26, [pb.int(1, m.compaction.spawn), pb.int(2, m.compaction.apply), pb.int(3, m.compaction.hard)]));
    info = pb.replace(info, 27, pb.str(27, m.alias));
    let e = tpl;
    e = pb.replace(e, 1, pb.str(1, m.label));
    e = pb.replace(e, 18, pb.int(18, m.contextTokens));
    e = pb.replace(e, 19); // the template's promotion is not ours
    e = pb.replace(e, 22, pb.str(22, m.uid));
    e = pb.replace(e, 23, pb.msg(23, info));
    e = pb.replace(e, 30, pb.msg(30, [pb.str(1, m.family)]));
    e = pb.replace(e, 32); // nor its prices
    added.push(pb.msg(1, e));
  }
  const uids = new Set(models.map((m) => m.uid));
  const kept = top.filter((f) => !(f.no === 1 && f.wire === 2 && uids.has(pb.strOf(pb.decode(f.value as Uint8Array), 22) ?? "")));
  const last = kept.map((f) => f.no).lastIndexOf(1);
  return pb.encode([...kept.slice(0, last + 1), ...added, ...kept.slice(last + 1)]);
}

/** Team settings whose allowed models include `uids`. The list is the
 *  catalog's models the team may pick, so a model the bridge adds to the
 *  catalog has to be added here as well or devin will not select it. A
 *  response with no list allows everything and is left alone. */
export function withAllowedModels(settings: Uint8Array, uids: string[]): Uint8Array {
  const top = pb.decode(settings);
  const allowed = new Set(top.filter((f) => f.no === 7 && f.wire === 2).map((f) => new TextDecoder().decode(f.value as Uint8Array)));
  if (!allowed.size) return settings;
  const last = top.map((f) => f.no).lastIndexOf(7);
  const add = uids.filter((u) => !allowed.has(u)).map((u) => pb.str(7, u));
  return pb.encode([...top.slice(0, last + 1), ...add, ...top.slice(last + 1)]);
}

// ---------------------------------------------------------------- chat request

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  toolCalls: ChatToolCall[];
  toolCallId: string | null;
  thinking: string | null;
  images: { base64: string; mimeType: string }[];
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: { name: string; description: string; schema: string }[];
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  model: string;
  session: string | null;
}

const ROLES: Record<number, ChatMessage["role"]> = { 1: "user", 2: "assistant", 3: "system", 4: "tool" };

/** The model a GetChatMessage body asks for, without decoding the rest. */
export function chatModelOf(body: Uint8Array): string | null {
  try {
    const first = envelopes(body)[0];
    return first ? pb.strOf(pb.decode(first.payload), 21) : null;
  } catch {
    return null;
  }
}

export function chatRequestOf(body: Uint8Array): ChatRequest {
  const first = envelopes(body)[0];
  if (!first) throw new Error("empty GetChatMessage request");
  const req = pb.decode(first.payload);
  const sampling = pb.msgOf(req, 8) ?? [];
  return {
    system: pb.strOf(req, 2) ?? "",
    messages: pb.msgsOf(req, 3).map((m) => ({
      role: ROLES[pb.intOf(m, 2) ?? 1] ?? "user",
      text: pb.strOf(m, 3) ?? "",
      toolCalls: pb.msgsOf(m, 6).map((c) => ({ id: pb.strOf(c, 1) ?? "", name: pb.strOf(c, 2) ?? "", arguments: pb.strOf(c, 3) ?? "" })),
      toolCallId: pb.strOf(m, 7),
      thinking: pb.strOf(m, 11),
      images: pb.msgsOf(m, 10).map((i) => ({ base64: pb.strOf(i, 1) ?? "", mimeType: pb.strOf(i, 2) ?? "image/png" })),
    })),
    tools: pb.msgsOf(req, 10).map((t) => ({ name: pb.strOf(t, 1) ?? "", description: pb.strOf(t, 2) ?? "", schema: pb.strOf(t, 3) ?? "{}" })),
    maxTokens: pb.intOf(sampling, 2),
    temperature: pb.f64Of(sampling, 5),
    topP: pb.f64Of(sampling, 8),
    model: pb.strOf(req, 21) ?? "",
    session: pb.strOf(req, 28) ?? pb.strOf(req, 16),
  };
}

// ---------------------------------------------------------------- chat response

export const STOP = { stop: 2, maxTokens: 3, toolCalls: 10 } as const;

export interface ChatUsage {
  /** Input tokens that were not read from the cache. */
  input: number;
  output: number;
  cachedInput: number;
}

/** Builds one reply's frames. Every frame repeats the ids and says how long
 *  the reply has been running, as the real server's do. */
export class ChatReply {
  private readonly id = crypto.randomUUID();
  private readonly started = performance.now();

  constructor(private readonly model: string) {}

  private frame(fields: pb.Field[]): Uint8Array {
    const now = Date.now();
    return envelope(
      0,
      pb.encode([
        pb.str(1, `bot-${this.id}`),
        pb.msg(2, [pb.int(1, Math.floor(now / 1000)), pb.int(2, (now % 1000) * 1_000_000)]),
        ...fields,
        pb.f64(12, (performance.now() - this.started) / 1000),
        pb.str(17, this.id),
      ]),
    );
  }

  private usageField(u: ChatUsage | null): pb.Field {
    return pb.msg(7, [
      ...(u ? [pb.int(2, u.input), pb.int(3, u.output), ...(u.cachedInput ? [pb.int(5, u.cachedInput)] : [])] : []),
      pb.str(9, this.model),
    ]);
  }

  opening(): Uint8Array {
    return this.frame([this.usageField(null)]);
  }
  text(delta: string): Uint8Array {
    return this.frame([pb.str(3, delta), pb.int(4, 1), this.usageField(null)]);
  }
  thinking(delta: string): Uint8Array {
    return this.frame([pb.str(9, delta)]);
  }
  toolCallStart(id: string, name: string): Uint8Array {
    return this.frame([pb.msg(6, [pb.str(1, id), pb.str(2, name)]), this.usageField(null)]);
  }
  toolCallArguments(delta: string): Uint8Array {
    return this.frame([pb.msg(6, [pb.str(3, delta)]), this.usageField(null)]);
  }
  stop(reason: number, usage: ChatUsage | null): Uint8Array {
    return this.frame([pb.int(5, reason), this.usageField(usage)]);
  }
}
