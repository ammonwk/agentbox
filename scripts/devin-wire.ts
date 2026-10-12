#!/usr/bin/env bun
/** Tools for reading what the devin CLI says to its API server, for when a
 * devin update changes the wire format the bridge depends on
 * (`src/bridge/devin-wire.ts`; the walkthrough is `docs/devin-bridge.md`).
 *
 *   bun scripts/devin-wire.ts record [dir] [port]
 *       A pass-through proxy that saves every request and response body to
 *       `dir` (default /tmp/devin-wire, port 4591) and lists them in
 *       index.jsonl. Bodies hold your prompts and devin's login token: the
 *       directory is private, and is yours to delete.
 *
 *   bun scripts/devin-wire.ts ask <model> <prompt…>
 *       One prompt to `devin acp --model <model>`, with tools approved, and
 *       the reply printed. Run it with WINDSURF_API_SERVER_URL pointing at
 *       the recorder (or the bridge). Several prompts in one conversation are
 *       separated by `|||`. VERBOSE=1 prints every session update,
 *       RUST_LOG=debug devin's own log.
 *
 *   bun scripts/devin-wire.ts dump <file> [maxString]
 *       A saved body as numbered fields, nested messages indented. Bodies of
 *       streaming calls (GetChatMessage) are split into their frames.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envelopes } from "../src/bridge/devin-wire";
import * as pb from "../src/bridge/pb";

const [verb, ...args] = process.argv.slice(2);

// ---------------------------------------------------------------- record

function record(dir = "/tmp/devin-wire", port = 4591): void {
  const upstream = process.env.AGENTBOX_DEVIN_UPSTREAM || "https://server.codeium.com";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let n = 0;
  const shown = (h: Headers) => Object.fromEntries([...h.entries()].map(([k, v]) => [k, /auth|key|token|cookie/i.test(k) ? `<${v.length} chars>` : v]));
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const id = String(++n).padStart(3, "0");
      const url = new URL(req.url);
      const name = url.pathname.split("/").pop();
      const body = new Uint8Array(await req.arrayBuffer());
      writeFileSync(join(dir, `${id}-${name}-req.bin`), body);
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.set("accept-encoding", "identity");
      const res = await fetch(upstream + url.pathname + url.search, { method: req.method, headers, body: body.length ? body : undefined, timeout: false } as RequestInit);
      const out = new Uint8Array(await res.arrayBuffer());
      writeFileSync(join(dir, `${id}-${name}-res.bin`), out);
      appendFileSync(
        join(dir, "index.jsonl"),
        JSON.stringify({ id, path: url.pathname, reqHeaders: shown(req.headers), reqBytes: body.length, status: res.status, resHeaders: shown(res.headers), resBytes: out.length }) + "\n",
      );
      console.log(`${id} ${name} ${body.length}b -> ${res.status} ${out.length}b`);
      const back = new Headers(res.headers);
      back.delete("content-length");
      back.delete("transfer-encoding");
      return new Response(out, { status: res.status, headers: back });
    },
  });
  console.log(`recording to ${dir}; run devin with WINDSURF_API_SERVER_URL=http://127.0.0.1:${port}`);
}

// ---------------------------------------------------------------- ask

async function ask(model: string, prompt: string): Promise<void> {
  const cwd = process.cwd();
  const p = Bun.spawn(["devin", "acp", "--model", model], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "error" },
  });
  let id = 0;
  let text = "";
  const pending = new Map<number, (m: { result?: { sessionId?: string }; error?: unknown }) => void>();
  const send = (o: unknown) => {
    p.stdin.write(JSON.stringify(o) + "\n");
    p.stdin.flush();
  };
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: { sessionId?: string }; error?: unknown }>((resolve) => {
      pending.set(++id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: number; method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } }; options?: { optionId: string }[] }; result?: { sessionId?: string }; error?: unknown };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && m.method === undefined) pending.get(m.id)?.(m);
        else if (m.method === "session/update") {
          const u = m.params?.update;
          if (u?.sessionUpdate === "agent_message_chunk") text += u.content?.text ?? "";
          else if (process.env.VERBOSE) console.error("[update]", JSON.stringify(u).slice(0, 400));
        } else if (m.id !== undefined) {
          if (m.method === "session/request_permission") send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: m.params?.options?.[0]?.optionId } } });
          else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported" } });
        }
      }
    }
  })();
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const sid = (await request("session/new", { cwd, mcpServers: [] })).result?.sessionId;
  if (!sid) throw new Error("devin did not open a session");
  console.error(`session ${sid}`);
  await request("session/set_mode", { sessionId: sid, modeId: "bypass" });
  for (const one of prompt.split("|||")) {
    text = "";
    const r = await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: one.trim() }] });
    console.log("REPLY:", text);
    console.log("RESULT:", JSON.stringify(r.result ?? r.error));
  }
  p.kill();
}

// ---------------------------------------------------------------- dump

const secret = (s: string) => s.startsWith("eyJ") || s.startsWith("sk-") || (s.length > 60 && !/\s/.test(s) && s.split(".").length === 3);

function show(buf: Uint8Array, depth: number, maxString: number): void {
  const pad = "  ".repeat(depth);
  for (const f of pb.decode(buf)) {
    if (f.wire === 0) console.log(`${pad}${f.no}: ${f.value}`);
    else if (f.wire === 1) console.log(`${pad}${f.no}: f64 ${new DataView(f.value.buffer, f.value.byteOffset, 8).getFloat64(0, true)}`);
    else if (f.wire === 5) console.log(`${pad}${f.no}: f32 ${new DataView(f.value.buffer, f.value.byteOffset, 4).getFloat32(0, true)}`);
    else {
      const bytes = f.value;
      let text: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\x00-\x08\x0e-\x1f]/.test(text)) text = null;
      } catch {}
      let nested = false;
      try {
        nested = bytes.length > 0 && pb.decode(bytes).length > 0;
      } catch {}
      // Text that also parses as a message is text when it reads like text.
      const wordy = text !== null && text.length > 3 && [...text].filter((c) => /[\w \-./:{}",\n]/.test(c)).length / text.length > 0.85;
      if (text !== null && (!nested || wordy || bytes.length < 3)) {
        const s = secret(text) ? `<${text.length} chars withheld>` : text.length > maxString ? `${text.slice(0, maxString)}…(+${text.length - maxString})` : text;
        console.log(`${pad}${f.no}: ${JSON.stringify(s)}`);
      } else if (nested) {
        console.log(`${pad}${f.no}: {  # ${bytes.length}b`);
        show(bytes, depth + 1, maxString);
        console.log(`${pad}}`);
      } else console.log(`${pad}${f.no}: bytes[${bytes.length}]`);
    }
  }
}

function dump(file: string, maxString = 160): void {
  const body = new Uint8Array(readFileSync(file));
  // An enveloped body starts with a flag byte of 0..3 and a length that fits.
  const framed = body.length >= 5 && body[0]! <= 3 && new DataView(body.buffer, body.byteOffset).getUint32(1) <= body.length - 5;
  if (!framed) return show(body, 0, maxString);
  envelopes(body).forEach((e, i) => {
    console.log(`--- frame ${i} flags=${e.flags} ${e.payload.length}b`);
    if (e.flags & 2) console.log(new TextDecoder().decode(e.payload));
    else show(e.payload, 0, maxString);
  });
}

// ----------------------------------------------------------------

if (verb === "record") record(args[0], args[1] ? Number(args[1]) : undefined);
else if (verb === "ask" && args.length >= 2) await ask(args[0]!, args.slice(1).join(" ")).then(() => process.exit(0));
else if (verb === "dump" && args[0]) dump(args[0], args[1] ? Number(args[1]) : undefined);
else {
  console.error("usage: bun scripts/devin-wire.ts record [dir] [port] | ask <model> <prompt…> | dump <file> [maxString]");
  process.exit(2);
}
