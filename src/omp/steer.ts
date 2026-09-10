/**
 * agentbox's omp extension: a message for a running agent, delivered while it
 * runs.
 *
 * agentbox drives omp over ACP, and ACP has one way to hand the agent a
 * message: `session/prompt`. Sent mid-turn, omp makes room for it by
 * cancelling the running turn (acp-agent.ts, `prompt`), so agentbox held
 * mid-turn messages until the turn ended. An orchestrator waiting on its
 * subagents is one turn for hours; its human's questions sat unread for an
 * hour and a half while the transcript showed them as sent.
 *
 * omp can steer natively. `sendUserMessage(text, { deliverAs: "steer" })` puts
 * a message on the agent loop's steering queue, which the loop reads after
 * every tool batch, and which cuts an `interruptible` tool — `hub wait` — short
 * without cancelling anything: the jobs it was watching keep running. ACP does
 * not expose that; an extension can. agentbox launches omp with `--extension`
 * pointing here and hands it messages over the unix socket named in
 * AGENTBOX_STEER_SOCKET. src/core/steer-link.ts is the other end.
 *
 * This file runs inside omp's process, so it imports nothing but node
 * builtins.
 */
import { connect, type Socket } from "node:net";

/** host → extension: put `text` to the agent. */
export interface SteerRequest {
  t: "steer";
  id: number;
  text: string;
}

/**
 * extension → host. `hello` names the omp session this copy of the extension
 * serves. Per request: `queued` once it is on omp's steering queue, then
 * `delivered` once it is in the conversation — or `idle`, which hands it
 * back: no run will read it, so it has to go as a prompt.
 */
export type SteerReply =
  | { t: "hello"; session: string }
  | { t: "queued" | "delivered" | "idle"; id: number };

interface Pending {
  id: number;
  text: string;
}

/**
 * When a message may go onto omp's steering queue, and when it has to come
 * back.
 *
 * The loop reads that queue at fixed points, and one of them is the last: a
 * steer queued after it strands on the queue, outside any run agentbox knows
 * about. So a message is queued only while a tool call is in flight — after
 * any tool batch the model is called again, and every model reply is followed
 * by another read. Events reach an extension a beat behind the loop, but a
 * tool call outlasts that beat, and the model call after it outlasts it again.
 *
 * A message that arrives while the model is writing is held for the next tool
 * call. If the run ends first, it goes back to the host as `idle`, to be sent
 * as a prompt once the turn is over.
 */
export class SteerRelay {
  private running = false;
  private tools = new Set<string>();
  /** Waiting for a tool call to carry them. */
  private held: Pending[] = [];
  /** On omp's steering queue, not yet seen in the conversation. */
  private queued: Pending[] = [];

  constructor(
    private readonly enqueue: (text: string) => void,
    private readonly reply: (r: SteerReply) => void,
  ) {}

  request(id: number, text: string): void {
    if (this.tools.size > 0) this.enqueueNow({ id, text });
    else if (this.running) this.held.push({ id, text });
    else this.reply({ t: "idle", id });
  }

  agentStart(): void {
    this.running = true;
  }

  agentEnd(): void {
    this.running = false;
    // An aborted run ends without its tool calls' ends.
    this.tools.clear();
    for (const p of this.held.splice(0)) this.reply({ t: "idle", id: p.id });
  }

  toolStart(callId: string): void {
    this.tools.add(callId);
    for (const p of this.held.splice(0)) this.enqueueNow(p);
  }

  toolEnd(callId: string): void {
    this.tools.delete(callId);
  }

  /** A steering message reached the conversation. Matched on text, oldest first. */
  injected(text: string): void {
    const i = this.queued.findIndex((p) => p.text === text);
    if (i < 0) return;
    const [p] = this.queued.splice(i, 1);
    this.reply({ t: "delivered", id: p!.id });
  }

  private enqueueNow(p: Pending): void {
    try {
      this.enqueue(p.text);
    } catch {
      // Refused on the spot. The prompt path is still there.
      this.reply({ t: "idle", id: p.id });
      return;
    }
    this.queued.push(p);
    this.reply({ t: "queued", id: p.id });
  }
}

// ------------------------------------------------------------ omp wiring

/** The slice of omp's `ExtensionAPI` used here (@oh-my-pi/pi-coding-agent),
 *  typed locally: agentbox does not depend on omp's package. */
interface OmpContext {
  sessionManager: { getSessionId(): string };
}

interface OmpExtensionApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx: OmpContext) => void): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

/** A message's text, from either of the content shapes omp uses. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

export default function agentboxSteer(pi: OmpExtensionApi): void {
  const path = process.env.AGENTBOX_STEER_SOCKET;
  if (!path) return;

  let sock: Socket | null = null;
  let gone = false;
  let named: string | null = null;
  const write = (r: SteerReply) => {
    sock?.write(`${JSON.stringify(r)}\n`);
  };
  const relay = new SteerRelay((text) => pi.sendUserMessage(text, { deliverAs: "steer" }), write);

  // Connected on the first event rather than at load: only an event carries
  // the session, and a subagent omp runs in-process loads a copy of this too.
  // The host writes only to the copy whose hello names its own session.
  const hello = (ctx: OmpContext) => {
    if (!sock && !gone) {
      sock = open(path, relay, () => {
        sock = null;
        gone = true;
      });
    }
    const session = ctx.sessionManager.getSessionId();
    if (session === named) return;
    named = session;
    write({ t: "hello", session });
  };

  pi.on("session_start", (_e, ctx) => hello(ctx));
  pi.on("agent_start", (_e, ctx) => {
    hello(ctx);
    relay.agentStart();
  });
  pi.on("agent_end", () => relay.agentEnd());
  pi.on("tool_execution_start", (e) => relay.toolStart(String(e.toolCallId)));
  pi.on("tool_execution_end", (e) => relay.toolEnd(String(e.toolCallId)));
  pi.on("message_end", (e) => {
    const m = e.message as { role?: unknown; steering?: unknown; content?: unknown } | undefined;
    if (m?.role === "user" && m.steering === true) relay.injected(textOf(m.content));
  });
  pi.on("session_shutdown", () => {
    gone = true;
    sock?.end();
    sock = null;
  });
}

/** Connect to the host and feed its requests to the relay. */
function open(path: string, relay: SteerRelay, onGone: () => void): Socket {
  const sock = connect(path);
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let req: Partial<SteerRequest>;
      try {
        req = JSON.parse(line) as Partial<SteerRequest>;
      } catch {
        continue;
      }
      if (req.t === "steer" && typeof req.id === "number" && typeof req.text === "string") {
        relay.request(req.id, req.text);
      }
    }
  });
  // Without a listener a refused connection is an uncaught error, and this is
  // omp's process. A host that is gone takes nothing with it but steering.
  sock.on("error", onGone);
  sock.on("close", onGone);
  return sock;
}
