/** `agentbox devin-bridge check`: does a bridged model still run in devin?
 *
 * The bridge rests on a wire format nobody promised (`devin-wire.ts`), so a
 * devin update can break it without an error anywhere: devin quietly runs its
 * own default model when it cannot resolve the one asked for. This walks the
 * path a session takes, one step at a time, and says which step failed;
 * `docs/devin-bridge.md` says how to repair each.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../core/paths";
import { BRIDGED, bridgeUrl, type BridgedModel } from "./models";
import { bridgeUp, ensureBridge } from "./service";

interface Health {
  chats: number;
  failed: number;
}

async function health(): Promise<Health | null> {
  try {
    return (await (await fetch(`${bridgeUrl()}/healthz`, { signal: AbortSignal.timeout(2000) })).json()) as Health;
  } catch {
    return null;
  }
}

/** One small request straight to the model's endpoint, as the bridge makes them. */
async function providerAnswers(model: BridgedModel): Promise<string | null> {
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${model.apiKey()}`,
      "user-agent": "agentbox-devin-bridge/1.0",
      "x-opencode-session": `devin-check-${Date.now()}`,
    },
    body: JSON.stringify({ model: model.upstreamModel, messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 200 }),
  });
  if (res.ok) return null;
  return `${res.status} ${(await res.text()).slice(0, 300)}`;
}

/** Whether devin, pointed at the bridge, lists the model. */
async function listed(model: BridgedModel): Promise<boolean> {
  const p = Bun.spawn(["devin", "models", "list", "--format", "json"], {
    env: { ...process.env, WINDSURF_API_SERVER_URL: bridgeUrl() },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.includes(`"${model.uid}"`);
}

interface Turn {
  reply: string;
  /** The context window devin reports for the session's model. */
  window: number | null;
  warnings: string[];
  error: string | null;
}

/** One prompt to `devin acp` on the model, through the bridge. */
async function oneTurn(model: BridgedModel, cwd: string, timeoutMs: number): Promise<Turn> {
  const turn: Turn = { reply: "", window: null, warnings: [], error: null };
  const p = Bun.spawn(["devin", "acp", "--model", model.uid], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WINDSURF_API_SERVER_URL: bridgeUrl(), RUST_LOG: "warn" },
  });
  const timer = setTimeout(() => {
    turn.error = `no reply within ${timeoutMs / 1000}s`;
    p.kill();
  }, timeoutMs);
  void (async () => {
    for (const line of (await new Response(p.stderr).text()).split("\n")) {
      if (/compaction thresholds|did not resolve/.test(line)) turn.warnings.push(line.replace(/^\S+\s+WARN\s+/, "").slice(0, 300));
    }
  })();
  let id = 0;
  const pending = new Map<number, (m: { result?: unknown; error?: { message?: string } }) => void>();
  const send = (o: unknown) => {
    p.stdin.write(JSON.stringify(o) + "\n");
    p.stdin.flush();
  };
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: { message?: string } }>((resolve) => {
      pending.set(++id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: number; method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string }; size?: number } }; result?: unknown; error?: { message?: string } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && m.method === undefined) pending.get(m.id)?.(m);
        else if (m.method === "session/update") {
          const u = m.params?.update;
          if (u?.sessionUpdate === "agent_message_chunk") turn.reply += u.content?.text ?? "";
          if (u?.sessionUpdate === "usage_update" && typeof u.size === "number") turn.window = u.size;
        } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported" } });
      }
    }
    // devin exited: nothing still waiting will be answered.
    for (const resolve of pending.values()) resolve({ error: { message: turn.error ?? "devin exited" } });
  })();
  try {
    const steps: [string, (sid: string) => unknown][] = [
      ["initialize", () => ({ protocolVersion: 1, clientCapabilities: {} })],
      ["session/new", () => ({ cwd, mcpServers: [] })],
      // `ask` has no write or shell tools: the check changes nothing.
      ["session/set_mode", (sid) => ({ sessionId: sid, modeId: "ask" })],
      ["session/prompt", (sid) => ({ sessionId: sid, prompt: [{ type: "text", text: "Reply with the single word: pong" }] })],
    ];
    let sid = "";
    for (const [method, params] of steps) {
      const r = await request(method, params(sid));
      if (r.error) {
        turn.error ??= `${method}: ${r.error.message ?? "failed"}`;
        break;
      }
      if (method === "session/new") sid = (r.result as { sessionId: string }).sessionId;
    }
  } finally {
    clearTimeout(timer);
    p.kill();
    await reading.catch(() => {});
  }
  return turn;
}

export async function checkBridge(print: (line: string) => void = console.log): Promise<number> {
  let failures = 0;
  const pass = (what: string) => print(`  ok    ${what}`);
  const fail = (what: string, fix: string) => {
    failures++;
    print(`  FAIL  ${what}\n        ${fix}`);
  };

  ensureBridge();
  if (await bridgeUp()) pass(`the bridge answers on ${bridgeUrl()}`);
  else {
    fail(`nothing answers on ${bridgeUrl()}`, "run `agentbox devin-bridge run` in a terminal to see why it will not start");
    return 1;
  }
  const cwd = join(agentboxHome(), "cache", "devin-bridge-check");
  mkdirSync(cwd, { recursive: true });

  for (const model of BRIDGED) {
    print(`${model.label} (${model.uid})`);
    if (!model.apiKey()) {
      fail("no key", model.keyHint);
      continue;
    }
    const refused = await providerAnswers(model).catch((e: Error) => e.message);
    if (refused) {
      fail(`${model.baseUrl} did not answer for ${model.upstreamModel}: ${refused}`, "the provider's side: its model id, your key or its limits (docs/devin-bridge.md, \"The provider\")");
      continue;
    }
    pass(`${model.baseUrl} answers for ${model.upstreamModel}`);

    if (await listed(model)) pass("devin lists it (the catalog entry is accepted)");
    else {
      fail("devin does not list it", `the catalog changed: is "${model.template}" still a model, and are the field numbers still right? (docs/devin-bridge.md, "The catalog")`);
      continue;
    }

    const before = (await health())?.chats ?? 0;
    print("        asking it one question through devin (devin can take a minute or two to start)…");
    const turn = await oneTurn(model, cwd, 300_000);
    const served = ((await health())?.chats ?? 0) - before;
    for (const w of turn.warnings) print(`        devin warned: ${w}`);
    if (turn.error) fail(`devin did not finish a turn: ${turn.error}`, `see ${join(agentboxHome(), "logs", "devin-bridge.log")} and docs/devin-bridge.md, "The chat"`);
    else if (served === 0) {
      fail(
        `devin answered ("${turn.reply.trim().slice(0, 60)}") but not through the bridge: it fell back to its own model`,
        'devin did not resolve the model: the allowed-models list or the catalog entry (docs/devin-bridge.md, "When devin falls back")',
      );
    } else if (!turn.reply.trim()) fail("the bridge was asked but devin showed no reply", 'the reply frames changed (docs/devin-bridge.md, "The chat")');
    else {
      pass(`it answered through the bridge: "${turn.reply.trim().slice(0, 60)}"`);
      if (turn.window === model.contextTokens) {
        pass(`devin runs it with a ${model.contextTokens}-token window (summary from ${model.compaction.spawn}, swapped in at ${model.compaction.apply}, forced at ${model.compaction.hard})`);
      } else fail(`devin reports a ${turn.window}-token window, not ${model.contextTokens}`, 'the window or the thresholds were not accepted (docs/devin-bridge.md, "Compaction")');
      if (turn.warnings.some((w) => /compaction thresholds/.test(w))) fail("devin ignored the compaction thresholds", 'docs/devin-bridge.md, "Compaction"');
    }
  }
  print(failures ? `${failures} failed` : "all good");
  return failures ? 1 : 0;
}
