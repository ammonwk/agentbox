/** The devin bridge: models devin does not sell, run in devin's harness.
 *
 * devin takes its model catalog and every model reply from one API server,
 * and `WINDSURF_API_SERVER_URL` says which. A devin started with that
 * pointing here gets the real server for everything — the bridge passes each
 * request through untouched, the login's token with it — except:
 *
 *   - the catalog gains an entry per bridged model (`BRIDGED`), a copy of a
 *     real entry so it runs in that model's harness, with its own context
 *     window and compaction thresholds;
 *   - the team's allowed models gain it too, or devin would not select it;
 *   - a chat request for a bridged model is answered from that model's own
 *     OpenAI-compatible endpoint instead (`src/bridge/devin-wire.ts` has both
 *     wire formats).
 *
 * Everything else about the session is devin's: its tools, its prompts, its
 * transcripts, its compaction — which is the point. A model with a long
 * window and no harness that rolls it gets one here.
 *
 * The bridge holds no state and no credentials: the model's key is read from
 * its owner's file at each request. A devin whose bridge is down fails its
 * next request with a connection error and retries, as with any outage.
 *
 * None of this is devin's to support: `docs/devin-bridge.md` is how to put it
 * back when a devin update moves the wire format.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../core/paths";
import { GO_ACCOUNT_BEARER, GO_CONSOLE_UPSTREAM, GO_KEY_UPSTREAM, defaultGoKey, goHomeForSelector } from "../core/accounts/gocred";
import { freshGoLogin } from "../core/accounts/godevice";
import { BRIDGED, bridgePort, bridgedModel, type BridgedModel } from "./models";
import {
  ChatReply,
  STOP,
  chatModelOf,
  chatRequestOf,
  endOfStream,
  withAllowedModels,
  withModels,
  type ChatRequest,
  type ChatUsage,
} from "./devin-wire";

// ---------------------------------------------------------------- upstream

/** devin's own API server: the login's, as `devin auth status` reports it. */
function devinServer(): string {
  if (process.env.AGENTBOX_DEVIN_UPSTREAM) return process.env.AGENTBOX_DEVIN_UPSTREAM;
  try {
    const toml = readFileSync(join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "devin", "credentials.toml"), "utf8");
    const url = /^\s*api_server_url\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1];
    if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) return url.replace(/\/+$/, "");
  } catch {}
  return "https://server.codeium.com";
}

type OpenAiMessage = Record<string, unknown>;

/** devin's conversation as chat-completions messages. devin sends context
 *  (system info, skills) as user messages of their own beside the prompt;
 *  consecutive ones become one message of several parts, for a template that
 *  wants turns to alternate. */
function openAiMessages(req: ChatRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.text });
    else if (m.role === "assistant") {
      // A turn that said and did nothing (an interrupted one) is no turn.
      if (!m.text && !m.toolCalls.length) continue;
      out.push({
        role: "assistant",
        content: m.text,
        // The model's own reasoning goes back with the turn it led to.
        ...(m.thinking ? { reasoning_content: m.thinking } : {}),
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })) }
          : {}),
      });
    } else if (m.role === "system") out.push({ role: "system", content: m.text });
    else {
      const prev = out[out.length - 1];
      const parts: unknown[] = [
        { type: "text", text: m.text },
        ...m.images.filter((i) => i.base64).map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.base64}` } })),
      ];
      if (prev?.role === "user") {
        prev.content = typeof prev.content === "string" ? [{ type: "text", text: prev.content }, ...parts] : [...(prev.content as unknown[]), ...parts];
      } else out.push({ role: "user", content: parts.length === 1 ? m.text : parts });
    }
  }
  return out;
}

function parameters(schema: string): unknown {
  try {
    return JSON.parse(schema);
  } catch {
    return { type: "object", properties: {} };
  }
}

function openAiBody(req: ChatRequest, model: BridgedModel): unknown {
  return {
    model: model.upstreamModel,
    messages: openAiMessages(req),
    ...(req.tools.length
      ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: parameters(t.schema) } })) }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.min(req.maxTokens ?? model.maxOutputTokens, model.maxOutputTokens),
    ...(req.temperature !== null ? { temperature: req.temperature } : {}),
    ...(req.topP !== null ? { top_p: req.topP } : {}),
  };
}

/** Connect's name for an HTTP failure, which devin reads to decide a retry. */
function connectCode(status: number): string {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 429) return "resource_exhausted";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "invalid_argument";
  return "unavailable";
}

interface Delta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index?: number; id?: string | null; function?: { name?: string | null; arguments?: string | null } }[];
}
interface Chunk {
  choices?: { delta?: Delta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string };
}

/**
 * A free model's queue can hold a request for minutes before the first byte
 * (seven, measured on OpenCode Go's LongCat, then a normal answer), and devin
 * gives up on a server that is silent for four. So the reply is opened at
 * once and kept warm with the empty frames devin's own server sends while a
 * model has nothing to say (`HEARTBEAT_MS`): to devin a queue is a model
 * thinking. Waiting beats failing, since a retry joins the back of the same
 * queue; only a provider silent past `FIRST_BYTE_MS`, or `IDLE_MS` mid-reply,
 * ends the reply as unavailable, which devin retries.
 */
const HEARTBEAT_MS = 10_000;
const FIRST_BYTE_MS = 15 * 60_000;
const IDLE_MS = 180_000;

class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const CONNECT_STREAM = { "content-type": "application/connect+proto" };

/** Bytes as a body: the DOM's `BodyInit` does not admit a `Uint8Array` over
 *  an `ArrayBufferLike`, which is what every decoder here returns. */
const bytes = (b: Uint8Array): BodyInit => b as unknown as BodyInit;

function failedStream(code: string, message: string): Response {
  return new Response(bytes(endOfStream({ code, message })), { headers: CONNECT_STREAM });
}

/** With `AGENTBOX_DEVIN_BRIDGE_DUMP` naming a directory, where to write what
 *  this request sends the provider and what comes back — conversations in
 *  full, so only while looking into something. */
let dumped = 0;
function dumpFile(req: ChatRequest): string | null {
  const dir = process.env.AGENTBOX_DEVIN_BRIDGE_DUMP;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(++dumped).padStart(3, "0")}-${req.session ?? "nosession"}`);
}

/** `promise`, or null each time `ms` passes first. */
async function* awaited<T>(promise: Promise<T>, ms: number): AsyncGenerator<null, T> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  for (;;) {
    let timer: Timer | undefined;
    const tick = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
    const first = await Promise.race([settled, tick]);
    clearTimeout(timer);
    if (first === null) {
      yield null;
      continue;
    }
    if ("error" in first) throw first.error;
    return first.value;
  }
}

/** One reply: the request to the model's provider, and its chat-completions
 *  stream as devin's frames. `firstByte` is told when the provider answers. */
async function* replyFrames(model: BridgedModel, req: ChatRequest, key: string, signal: AbortSignal, firstByte: () => void): AsyncGenerator<Uint8Array> {
  const reply = new ChatReply(model.uid);
  yield reply.opening();
  const started = Date.now();
  const dump = dumpFile(req);
  if (dump) writeFileSync(`${dump}.request.json`, JSON.stringify(openAiBody(req, model), null, 1));
  const asking = fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "user-agent": "agentbox-devin-bridge/1.0",
      // One id per conversation, which OpenCode Go routes (and caches) by.
      "x-opencode-session": `devin-${req.session ?? crypto.randomUUID()}`,
    },
    body: JSON.stringify(openAiBody(req, model)),
    // Bun gives up on a silent server after five minutes by itself; how long
    // to wait is decided below.
    timeout: false,
  } as RequestInit);
  asking.catch(() => {}); // reported where it is awaited
  let upstream: Response;
  const waiting = awaited(asking, HEARTBEAT_MS);
  for (;;) {
    const next = await waiting.next().catch((e: Error) => {
      throw new BridgeError("unavailable", `${model.label} is unreachable: ${e.message}`);
    });
    if (next.done) {
      upstream = next.value;
      break;
    }
    if (Date.now() - started > FIRST_BYTE_MS) throw new BridgeError("unavailable", `${model.label} did not start answering within ${FIRST_BYTE_MS / 1000}s`);
    yield reply.opening();
  }
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 500);
    throw new BridgeError(connectCode(upstream.status), `${model.label} answered ${upstream.status}: ${detail || upstream.statusText}`);
  }
  firstByte();

  let finish: string | null = null;
  let usage: ChatUsage | null = null;
  // devin reads argument deltas as belonging to the call opened last, so a
  // call's deltas are sent only while it is the newest; a provider that
  // interleaves calls has the stragglers held.
  let open = -1;
  const calls = new Map<number, { id: string; name: string; started: boolean; held: string }>();
  let sawCall = false;
  let said = false;

  const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      let piece: { done: boolean; value?: Uint8Array } | undefined;
      const reading = awaited(reader.read() as Promise<{ done: boolean; value?: Uint8Array }>, HEARTBEAT_MS);
      const quietSince = Date.now();
      for (;;) {
        const next = await reading.next();
        if (next.done) {
          piece = next.value;
          break;
        }
        if (Date.now() - quietSince > IDLE_MS) throw new BridgeError("unavailable", `${model.label} went quiet for ${IDLE_MS / 1000}s mid-reply`);
        yield reply.opening();
      }
      if (piece.done) break;
      if (dump) appendFileSync(`${dump}.reply.sse`, piece.value!);
      buf += dec.decode(piece.value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new BridgeError("unavailable", chunk.error.message ?? `${model.label}'s provider ended the reply with an error`);
        if (chunk.usage) {
          // devin adds the cached tokens to the input; chat completions counts
          // them inside it.
          const cachedInput = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage = { input: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cachedInput), output: chunk.usage.completion_tokens ?? 0, cachedInput };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        const thought = d.reasoning_content ?? d.reasoning;
        if (thought) yield reply.thinking(thought);
        if (d.content) {
          said = true;
          yield reply.text(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const index = tc.index ?? 0;
          let call = calls.get(index);
          if (!call) {
            call = { id: tc.id || `call_${crypto.randomUUID().replace(/-/g, "")}`, name: "", started: false, held: "" };
            calls.set(index, call);
          }
          if (tc.function?.name) call.name += tc.function.name;
          const args = tc.function?.arguments ?? "";
          if (!call.started) {
            if (!call.name) {
              call.held += args;
              continue;
            }
            call.started = true;
            sawCall = true;
            open = index;
            yield reply.toolCallStart(call.id, call.name);
            if (call.held) yield reply.toolCallArguments(call.held);
            call.held = "";
          }
          if (!args) continue;
          if (open === index) yield reply.toolCallArguments(args);
          else call.held += args;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (finish === null && !sawCall && usage === null) throw new BridgeError("unavailable", `${model.label}'s provider closed the reply before finishing it`);
  // A reply of nothing at all is the provider failing, not the model
  // choosing silence; passed on, it would end devin's turn without a word.
  if (!said && !sawCall) throw new BridgeError("unavailable", `${model.label} sent an empty reply`);
  yield reply.stop(sawCall ? STOP.toolCalls : finish === "length" ? STOP.maxTokens : STOP.stop, usage);
}

function chat(model: BridgedModel, body: Uint8Array, signal: AbortSignal, log: (line: string) => void): Response {
  let req: ChatRequest;
  try {
    req = chatRequestOf(body);
  } catch (e) {
    return failedStream("invalid_argument", `agentbox devin bridge could not read the request: ${(e as Error).message}`);
  }
  const key = model.apiKey();
  if (!key) return failedStream("unauthenticated", `No key for ${model.label}: ${model.keyHint}.`);
  const started = Date.now();
  const what = `chat ${model.uid} session=${req.session} messages=${req.messages.length}`;
  if (process.env.AGENTBOX_DEVIN_BRIDGE_TRACE) log(`${what} asked`);
  // devin hanging up ends the request to the provider with it.
  const abort = new AbortController();
  const hangUp = () => abort.abort(new Error("devin hung up"));
  signal.addEventListener("abort", hangUp);
  let firstByteMs: number | null = null;
  const frames = replyFrames(model, req, key, abort.signal, () => (firstByteMs = Date.now() - started));
  let over = false;
  const done = (how: string) => {
    if (over) return;
    over = true;
    signal.removeEventListener("abort", hangUp);
    log(`${what} ${how} first=${firstByteMs ?? "-"}ms total=${Date.now() - started}ms`);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await frames.next();
        if (!next.done) return controller.enqueue(next.value);
        controller.enqueue(endOfStream());
        controller.close();
        done("ok");
      } catch (e) {
        if (over) return;
        const err = e instanceof BridgeError ? e : new BridgeError("unavailable", `${model.label}'s reply broke off: ${(e as Error).message}`);
        controller.enqueue(endOfStream({ code: err.code, message: err.message }));
        controller.close();
        done(`failed: ${err.message}`);
      }
    },
    cancel() {
      // devin closes the stream once it has the stop frame.
      done("hung up on");
      abort.abort(new Error("devin hung up"));
      void frames.return(undefined).catch(() => {});
    },
  });
  return new Response(stream, { headers: CONNECT_STREAM });
}

// ---------------------------------------------------------------- server

/** Headers that describe one hop's connection, not the message. */
const HOP = ["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding"];

async function passThrough(req: Request, url: URL, body: Uint8Array | null): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of HOP) headers.delete(h);
  // Bodies go back as they came; asking for none compressed keeps the
  // response's headers true of them.
  headers.set("accept-encoding", "identity");
  const res = await fetch(devinServer() + url.pathname + url.search, {
    method: req.method,
    headers,
    body: body && body.length ? bytes(body) : undefined,
    signal: req.signal,
    // devin's own models think for minutes too; devin does the giving up.
    timeout: false,
  } as RequestInit);
  const out = new Headers(res.headers);
  for (const h of HOP) out.delete(h);
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * OpenCode Go on a given account's credential (src/core/accounts/gocred.ts):
 * `/go/<account>/v1/<rest>` and `/go/<account>/anthropic/v1/<rest>` are
 * forwarded to Go with that account's credential in place of whatever the
 * caller sent. `<account>` is "default" (opencode's own API key), an account
 * id (its Console sign-in, refreshed here when due or refused), or "caller":
 * omp, whose endpoint is fixed in its models.yml, names the account in its
 * key (`agentbox-account:<id>`), and any other key it sends is a real one
 * that goes through untouched. The session's own headers
 * (`x-opencode-session`) ride along; the reply streams back.
 */
async function goProxy(req: Request, url: URL, log: (line: string) => void): Promise<Response> {
  const refuse = (message: string) => Response.json({ type: "error", error: { type: "AuthError", message: `agentbox bridge: ${message}` } }, { status: 401 });
  const m = /^\/go\/([^/]+)(\/anthropic)?\/v1(\/.*)$/.exec(url.pathname);
  if (!m) return refuse(`no such OpenCode Go route: ${url.pathname}`);
  const shape = m[2] ? "anthropic" : "openai";
  const rest = m[3]! + url.search;
  const headers = new Headers(req.headers);
  for (const h of HOP) headers.delete(h);
  headers.set("accept-encoding", "identity");
  const body = req.body ? await req.arrayBuffer() : undefined;

  let selector = m[1]!;
  if (selector === "caller") {
    const sent = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || (headers.get("x-api-key") ?? "");
    if (!sent.startsWith(GO_ACCOUNT_BEARER)) return goSend(`${GO_KEY_UPSTREAM}${rest}`, req, headers, body, log, "caller");
    selector = sent.slice(GO_ACCOUNT_BEARER.length);
  }
  const credential = (token: string) => {
    headers.set("authorization", `Bearer ${token}`);
    if (headers.has("x-api-key")) headers.set("x-api-key", token);
  };

  if (selector === "default") {
    const key = defaultGoKey();
    if (!key) return refuse("opencode has no OpenCode Go key — run `opencode auth login`");
    credential(key);
    // opencode signed into a workspace names it; a key is its own workspace.
    headers.delete("x-opencode-org-id");
    return goSend(`${GO_KEY_UPSTREAM}${rest}`, req, headers, body, log, selector);
  }

  const home = goHomeForSelector(selector);
  for (const force of [false, true]) {
    const login = home ? await freshGoLogin(home, { force }).catch((e: Error) => (log(`go ${selector}: ${e.message}`), null)) : null;
    if (!login) return refuse(`OpenCode Go account ${selector} is not signed in — log it in again in agentbox`);
    credential(login.access);
    if (login.orgID) headers.set("x-opencode-org-id", login.orgID);
    else headers.delete("x-opencode-org-id");
    const res = await goSend(`${GO_CONSOLE_UPSTREAM[shape]}${rest}`, req, headers, body, log, selector);
    // A token refused before its time: refresh once and ask again.
    if (res.status !== 401 || force) return res;
    await res.arrayBuffer().catch(() => undefined);
  }
  return refuse("unreachable");
}

async function goSend(target: string, req: Request, headers: Headers, body: ArrayBuffer | undefined, log: (line: string) => void, who: string): Promise<Response> {
  const res = await fetch(target, {
    method: req.method,
    headers,
    body,
    signal: req.signal,
    // A reasoning model can be quiet for minutes; the CLI does the giving up.
    timeout: false,
  } as RequestInit);
  if (!res.ok) log(`go ${who} ${req.method} ${new URL(target).pathname} -> ${res.status}`);
  const out = new Headers(res.headers);
  for (const h of HOP) out.delete(h);
  out.delete("content-encoding");
  return new Response(res.body, { status: res.status, headers: out });
}

/** The unary responses the bridge adds its models to, by method. */
const REWRITES: Record<string, (body: Uint8Array) => Uint8Array> = {
  GetCliModelConfigs: (body) => withModels(body, [...BRIDGED]),
  GetCliTeamSettings: (body) => withAllowedModels(body, BRIDGED.map((m) => m.uid)),
};

export interface BridgeOptions {
  port?: number;
  log?: (line: string) => void;
}

export function startBridge(options: BridgeOptions = {}): { port: number; stop(): void } {
  const print = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  // What `devin-bridge status` and `check` read: proof that a reply was the
  // bridge's and not a model devin fell back to.
  const served = { chats: 0, failed: 0, lastChatAt: null as string | null };
  const log = (line: string) => {
    if (/^chat .* (ok|hung up on) first=\d/.test(line)) {
      served.chats++;
      served.lastChatAt = new Date().toISOString();
    } else if (/^chat .* failed: /.test(line)) served.failed++;
    print(line);
  };
  const server = Bun.serve({
    port: options.port ?? bridgePort(),
    hostname: "127.0.0.1",
    // A reply can think for minutes between frames.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          pid: process.pid,
          upstream: devinServer(),
          models: BRIDGED.map((m) => ({ uid: m.uid, contextTokens: m.contextTokens, compaction: m.compaction, key: m.apiKey() !== null })),
          ...served,
        });
      }
      if (url.pathname.startsWith("/go/")) {
        try {
          return await goProxy(req, url, log);
        } catch (e) {
          if (!req.signal.aborted) log(`go ${url.pathname} failed: ${(e as Error).message}`);
          return Response.json({ type: "error", error: { type: "BridgeError", message: `agentbox bridge: ${(e as Error).message}` } }, { status: 502 });
        }
      }
      try {
        const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null;
        if (body && url.pathname.endsWith("/GetChatMessage")) {
          const asked = chatModelOf(body);
          const model = bridgedModel(asked);
          if (model) return chat(model, body, req.signal, log);
          if (process.env.AGENTBOX_DEVIN_BRIDGE_TRACE) log(`pass chat for ${asked}`);
        }
        if (process.env.AGENTBOX_DEVIN_BRIDGE_TRACE) log(`pass ${url.pathname} ${body?.length ?? 0}b`);
        const res = await passThrough(req, url, body);
        const rewrite = REWRITES[url.pathname.slice(url.pathname.lastIndexOf("/") + 1)];
        if (!res.ok || !rewrite) return res;
        const original = new Uint8Array(await res.arrayBuffer());
        try {
          return new Response(bytes(rewrite(original)), { status: res.status, headers: res.headers });
        } catch (e) {
          log(`${url.pathname} left as it was: ${(e as Error).message}`);
          return new Response(bytes(original), { status: res.status, headers: res.headers });
        }
      } catch (e) {
        if (!req.signal.aborted) log(`${url.pathname} failed: ${(e as Error).message}`);
        return new Response(JSON.stringify({ code: "unavailable", message: `agentbox devin bridge: ${(e as Error).message}` }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
    },
  });
  log(`devin bridge on http://127.0.0.1:${server.port} -> ${devinServer()} (${BRIDGED.map((m) => m.uid).join(", ")})`);
  return { port: server.port ?? bridgePort(), stop: () => server.stop(true) };
}
