import {
  client,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface AcpEvents {
  /** Incremental assistant text. */
  onText: (sessionId: string, text: string) => void;
  /** A turn finished. stopReason is one of end_turn/max_tokens/refusal/cancelled. */
  onTurnEnd: (sessionId: string, stopReason: string) => void;
  onUsage: (sessionId: string, tokens: number, costUsd: number) => void;
  /** The agent asked for permission and we are not auto-approving. */
  onPermission: (
    sessionId: string,
    info: { id: string; title: string; tool: string; options: { id: string; name: string }[] }
  ) => void;
  onError: (sessionId: string, message: string) => void;
  onExit: (sessionId: string, code: number) => void;
}

export interface PermissionInfo {
  id: string;
  title: string;
  tool: string;
  options: { id: string; name: string }[];
}

interface PendingPermission {
  resolve: (approved: boolean) => void;
  info: PermissionInfo;
}

function approveOption(options: { id: string; name: string }[]) {
  const match = options.find(
    (o) => /allow|approve|accept|yes/i.test(o.name) || /allow|approve/i.test(o.id)
  );
  return (match ?? options[0])?.id ?? "";
}

/**
 * One persistent, interactive omp ACP session.
 *
 * A single `omp acp` process serves the whole agentbox session: messages are
 * queued and delivered one turn at a time, the agent can ask for permission
 * (blocking until answered), and turns can be interrupted. The process stays
 * alive between turns, so "waiting" is real.
 */
export class AcpRunner {
  readonly id: string;
  private events: AcpEvents;
  private proc: Bun.Subprocess | null = null;
  private ctx: any = null;
  private ompSessionId: string | null = null;
  private busy = false;
  private queue: string[] = [];
  private pendingPerm: PendingPermission | null = null;
  private autoApprove: () => boolean;
  private closed = false;
  private turnBuffer = "";

  constructor(id: string, events: AcpEvents, autoApprove: () => boolean) {
    this.id = id;
    this.events = events;
    this.autoApprove = autoApprove;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get alive(): boolean {
    return !!this.proc && !this.closed;
  }

  get queued(): number {
    return this.queue.length;
  }

  get sessionId(): string | null {
    return this.ompSessionId;
  }

  /**
   * Launch `omp acp` and open an ACP session.
   * If `resumeSessionId` is given, resume that omp conversation instead of
   * starting a fresh one (used after the process died / server restarted).
   */
  async launch(
    worktree: string,
    model: string,
    resumeSessionId: string | null
  ): Promise<string> {
    if (this.closed) throw new Error("runner closed");

    const proc = Bun.spawn(
      // NOTE: no --session-dir here. omp's ACP session list/resume look up
      // sessions in the default cwd-derived store (~/.omp/agent/sessions/<cwd>/),
      // and each agentbox worktree has a unique cwd, so sessions never collide.
      ["omp", "acp", "--model", model],
      { cwd: worktree, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } }
    );
    this.proc = proc;

    const onErr = this.events.onError;
    const myId = this.id;
    proc.stderr
      ?.pipeTo(
        new WritableStream({
          write(c) {
            const s = Buffer.from(c).toString("utf8").trim();
            if (s) onErr(myId, s);
          },
        })
      )
      .catch(() => {});

    proc.exited.then((code) => {
      if (!this.closed) {
        this.closed = true;
        this.events.onExit(this.id, code);
      }
    });

    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        void proc.stdin?.write(chunk);
      },
      close() {
        void proc.stdin?.end();
      },
    });
    const stream = ndJsonStream(output, proc.stdout as ReadableStream<Uint8Array>);

    const app = client({ name: "agentbox" });

    const notify = (sessionId: string, update: any) => {
      if (this.ompSessionId === sessionId) this.handleUpdate(update);
    };
    app.onNotification("session/update", async (req: { params: SessionNotification }) => {
      const n = req.params;
      notify(n.sessionId, (n as any).update);
    });

    app.onRequest(
      "session/request_permission",
      async (req: { params: RequestPermissionRequest }): Promise<RequestPermissionResponse> => {
        const p = req.params;
        const options = (p.options ?? []).map((o) => ({ id: o.optionId, name: o.name }));
        if (this.autoApprove()) {
          return { outcome: { outcome: "selected", optionId: approveOption(options) } };
        }
        return await new Promise<RequestPermissionResponse>((resolve) => {
          this.pendingPerm = {
            resolve: (approved) =>
              approved
                ? resolve({ outcome: { outcome: "selected", optionId: approveOption(options) } })
                : resolve({ outcome: { outcome: "cancelled" } }),
            info: {
              id: p.toolCall?.toolCallId ?? "perm",
              title: p.toolCall?.title ?? "Permission requested",
              tool: p.toolCall?.title ?? "",
              options,
            },
          };
          this.events.onPermission(this.id, this.pendingPerm.info);
        });
      }
    );

    let resolveSid: (s: string) => void;
    let rejectSid: (e: Error) => void;
    const sidP = new Promise<string>((r, j) => {
      resolveSid = r;
      rejectSid = j;
    });

    const connectPromise = app.connectWith(stream, async (ctx: any) => {
      this.ctx = ctx;
      let sid: string;
      try {
        if (resumeSessionId) {
          // omp's session/resume response omits sessionId (it only echoes
          // configOptions/modes), so fall back to the id we resumed.
          try {
            await ctx.request("session/resume", {
              sessionId: resumeSessionId,
              cwd: worktree,
              mcpServers: [],
            });
            sid = resumeSessionId;
          } catch {
            const res = await ctx.request("session/load", {
              sessionId: resumeSessionId,
              cwd: worktree,
              mcpServers: [],
            });
            sid = res.sessionId ?? resumeSessionId;
          }
        } else {
          const res = await ctx.request("session/new", { cwd: worktree, mcpServers: [] });
          sid = res.sessionId;
        }
      } catch (err) {
        rejectSid(new Error(`failed to open omp session: ${(err as Error).message}`));
        throw err;
      }
      this.ompSessionId = sid;
      resolveSid(sid);
      return new Promise<void>(() => {}); // keep the connection open until the process exits
    });
    connectPromise.catch((err: unknown) => {
      if (!this.closed) {
        this.closed = true;
        rejectSid?.(new Error((err as Error).message ?? String(err)));
        this.events.onError(this.id, (err as Error).message ?? String(err));
        this.events.onExit(this.id, -1);
      }
    });

    return await sidP;
  }

  private handleUpdate(update: any) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          this.turnBuffer += update.content.text ?? "";
          this.events.onText(this.id, update.content.text ?? "");
        }
        break;
      case "usage_update":
        {
          const tokens = update.tokens?.totalTokens ?? update.tokens?.output ?? 0;
          const cost = update.cost?.total ?? 0;
          this.events.onUsage(this.id, tokens, cost);
        }
        break;
      case "tool_call":
        // falls through: nothing needed beyond text for now
        break;
    }
  }

  /** Send the first prompt of a new turn sequence. */
  send(text: string) {
    if (this.closed || !this.ctx || !this.ompSessionId) throw new Error("session is not connected");
    this.queue.push(text);
    this.pump();
  }

  private pump() {
    if (this.busy || this.closed || !this.ctx || !this.ompSessionId) return;
    const text = this.queue.shift();
    if (text === undefined) return;
    this.busy = true;
    this.ctx
      .request("session/prompt", {
        sessionId: this.ompSessionId,
        prompt: [{ type: "text", text }],
      })
      .then((res: any) => {
        // The turn is done. stopReason is authoritative even when updates raced ahead.
        this.busy = false;
        this.handleStop(res.stopReason);
      })
      .catch((err: unknown) => {
        this.busy = false;
        this.events.onError(this.id, (err as Error).message ?? String(err));
        this.pump();
      });
  }

  private handleStop(stopReason: string) {
    this.turnBuffer = "";
    this.events.onTurnEnd(this.id, stopReason);
  }

  /** Interrupt the current turn. Queue survives; the turn stops with `cancelled`. */
  interrupt() {
    if (!this.ctx || !this.ompSessionId) return;
    if (this.pendingPerm) {
      const p = this.pendingPerm;
      this.pendingPerm = null;
      p.resolve(false);
    }
    void this.ctx.notify("session/cancel", { sessionId: this.ompSessionId }).catch(() => {});
  }

  /** Reply to a surfaced permission request. */
  replyPermission(id: string, approved: boolean) {
    if (!this.pendingPerm || this.pendingPerm.info.id !== id) return;
    const p = this.pendingPerm;
    this.pendingPerm = null;
    p.resolve(approved);
  }

  get hasPendingPermission(): boolean {
    return !!this.pendingPerm;
  }

  get permission(): PermissionInfo | null {
    return this.pendingPerm?.info ?? null;
  }

  /** Hard-kill the omp process. */
  kill() {
    this.closed = true;
    try {
      this.proc?.kill();
    } catch {}
  }
}
