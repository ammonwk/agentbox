/** A hub's view of its nodes (docs/hub.md, Aggregated state and Passing
 *  through): one `/api/node/ws` socket to each approved node, the sessions
 *  its frames carry, and the requests, watches and terminals the hub passes
 *  through to it.
 *
 *  A node that stops answering is away: its sessions stay, marked with when
 *  it was last heard from, and the socket is tried again from 2 seconds,
 *  doubling to a minute. Nothing here ever marks a remote session stopped. */

import { readNodes, type NodeRecord } from "../core/hub";
import type { HotState, HubNodeView, NodeState, Person, ServerMessage } from "../core/types";
import { personHeader, tailnetSelfNow } from "./person";
import { SEAM_FROM, seamOn } from "./tailnet";

type Row = HotState["sessions"][number];

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** The node sends a `node` frame every 5s; three missed and it is away. */
const SILENT_MS = 15_000;
const PROXY_TIMEOUT_MS = 30_000;

type Remote = {
  rec: NodeRecord;
  ws: WebSocket | null;
  sessions: Map<string, Row>;
  state: NodeState | null;
  connected: boolean;
  lastSeen: number | null;
  error: string | null;
  retryMs: number;
  retry: ReturnType<typeof setTimeout> | null;
};

export type Target = { rec: NodeRecord; remoteId: string };

/** The hub itself, as the person behind its own reads of a node. */
const HUB_PERSON: Person = { login: "", name: "hub", role: null, via: "local" };

export class HubNodes {
  private remotes = new Map<string, Remote>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onChange: () => void,
    private localIds: () => Set<string>,
  ) {}

  start(): void {
    this.sync();
    this.timer ??= setInterval(() => {
      this.sync();
      this.checkSilence();
    }, 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.remotes.values()) this.drop(r);
    this.remotes.clear();
  }

  /** Connect to the approved nodes in nodes.json and let go of the rest. */
  sync(): void {
    const recs = readNodes().filter((n) => n.approvedAt !== null);
    const want = new Map(recs.map((n) => [n.id, n]));
    let changed = false;
    for (const [id, r] of this.remotes) {
      const rec = want.get(id);
      if (rec && rec.token === r.rec.token && rec.ip === r.rec.ip && rec.port === r.rec.port) {
        r.rec = rec;
        continue;
      }
      this.drop(r);
      this.remotes.delete(id);
      changed = true;
    }
    for (const rec of recs) {
      if (this.remotes.has(rec.id)) continue;
      const r: Remote = { rec, ws: null, sessions: new Map(), state: null, connected: false, lastSeen: null, error: null, retryMs: RETRY_FIRST_MS, retry: null };
      this.remotes.set(rec.id, r);
      this.connect(r);
      changed = true;
    }
    if (changed) this.onChange();
  }

  private drop(r: Remote): void {
    if (r.retry) clearTimeout(r.retry);
    r.retry = null;
    const ws = r.ws;
    r.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  private base(rec: NodeRecord): string {
    return `http://${rec.ip.includes(":") ? `[${rec.ip}]` : rec.ip}:${rec.port}`;
  }

  /** What every request to a node carries: its token, who asked, and under
   *  the test seam the hub's own address as the source. */
  headers(rec: NodeRecord, person: Person): Record<string, string> {
    const h: Record<string, string> = { "x-agentbox-hub-token": rec.token, "x-agentbox-person": personHeader(person) };
    const self = tailnetSelfNow();
    if (seamOn() && self) h[SEAM_FROM] = self.ip;
    return h;
  }

  socket(rec: NodeRecord, path: string, person: Person): WebSocket {
    const url = this.base(rec).replace(/^http/, "ws") + path;
    return new WebSocket(url, { headers: this.headers(rec, person) } as unknown as string[]);
  }

  private connect(r: Remote): void {
    if (this.remotes.get(r.rec.id) !== r) return;
    let ws: WebSocket;
    try {
      ws = this.socket(r.rec, "/api/node/ws", HUB_PERSON);
    } catch (e) {
      r.error = (e as Error).message;
      this.later(r);
      return;
    }
    r.ws = ws;
    ws.onmessage = (e) => {
      if (r.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      this.frame(r, msg);
    };
    ws.onerror = () => {
      if (r.ws === ws) r.error = "could not reach it";
    };
    ws.onclose = (e) => {
      if (r.ws !== ws) return;
      r.ws = null;
      if (e.reason) r.error = e.reason;
      else r.error ??= `the connection closed (${e.code})`;
      this.away(r);
      this.later(r);
    };
  }

  private later(r: Remote): void {
    if (r.retry || this.remotes.get(r.rec.id) !== r) return;
    r.retry = setTimeout(() => {
      r.retry = null;
      this.connect(r);
    }, r.retryMs);
    r.retry.unref?.();
    r.retryMs = Math.min(RETRY_MAX_MS, r.retryMs * 2);
  }

  private away(r: Remote): void {
    if (!r.connected) return;
    r.connected = false;
    this.onChange();
  }

  private frame(r: Remote, msg: ServerMessage): void {
    r.lastSeen = Date.now();
    if (!r.connected) {
      r.connected = true;
      r.error = null;
      r.retryMs = RETRY_FIRST_MS;
      this.onChange();
    }
    if (msg.type === "hot") {
      r.sessions = new Map(msg.state.sessions.map((s) => [s.id, s]));
      this.onChange();
    } else if (msg.type === "hotDelta") {
      for (const s of msg.sessions) r.sessions.set(s.id, s);
      for (const id of msg.gone) r.sessions.delete(id);
      this.onChange();
    } else if (msg.type === "node") {
      const before = JSON.stringify(r.state);
      r.state = msg.state;
      if (JSON.stringify(r.state) !== before) this.onChange();
    }
  }

  private checkSilence(): void {
    const now = Date.now();
    for (const r of this.remotes.values()) {
      if (!r.connected || !r.ws || (r.lastSeen ?? 0) > now - SILENT_MS) continue;
      r.error = "it stopped answering";
      const ws = r.ws;
      r.ws = null;
      try {
        ws.close();
      } catch {
        /* gone */
      }
      this.away(r);
      this.later(r);
    }
  }

  /** Every remote session's id on the hub: its own, or `<node>-<id>` when that
   *  is already a local session's or an earlier node's. */
  private mapping(): { byHubId: Map<string, Target>; hubIdOf: Map<Remote, Map<string, string>> } {
    const taken = this.localIds();
    const byHubId = new Map<string, Target>();
    const hubIdOf = new Map<Remote, Map<string, string>>();
    for (const r of this.remotes.values()) {
      const own = new Map<string, string>();
      for (const id of r.sessions.keys()) {
        const hubId = taken.has(id) ? `${r.rec.name}-${id}` : id;
        taken.add(hubId);
        own.set(id, hubId);
        byHubId.set(hubId, { rec: r.rec, remoteId: id });
      }
      hubIdOf.set(r, own);
    }
    return { byHubId, hubIdOf };
  }

  /** The joined nodes' shared sessions, as the hub shows them. */
  sessions(): Row[] {
    const { hubIdOf } = this.mapping();
    const out: Row[] = [];
    for (const r of this.remotes.values()) {
      const own = hubIdOf.get(r)!;
      for (const s of r.sessions.values()) {
        out.push({
          ...s,
          id: own.get(s.id)!,
          parent: s.parent ? (own.get(s.parent) ?? null) : null,
          successor: s.successor ? (own.get(s.successor) ?? null) : null,
          node: r.rec.name,
          ...(r.connected ? {} : { away: { lastSeen: r.lastSeen ?? r.rec.approvedAt ?? 0 } }),
        });
      }
    }
    return out;
  }

  /** The node and its own id for a session the hub shows, or null for one of the hub's. */
  resolve(hubId: string): (Target & { reachable: boolean }) | null {
    const t = this.mapping().byHubId.get(hubId);
    if (!t) return null;
    const r = this.remotes.get(t.rec.id);
    return { ...t, reachable: !!r?.connected };
  }

  views(): HubNodeView[] {
    return readNodes().map((rec) => {
      const r = this.remotes.get(rec.id);
      return {
        id: rec.id,
        name: rec.name,
        ip: rec.ip,
        port: rec.port,
        device: rec.device,
        login: rec.login,
        tags: rec.tags,
        requestedAt: rec.requestedAt,
        approvedAt: rec.approvedAt,
        approvedBy: rec.approvedBy,
        reachable: !!r?.connected,
        lastSeen: r?.lastSeen ?? null,
        error: rec.approvedAt === null ? null : (r?.error ?? null),
        sessions: r?.sessions.size ?? 0,
        lend: r?.state?.lend ?? null,
        headroom: r?.state?.headroom ?? null,
      };
    });
  }

  /** `/api/sessions/<hubId>/<rest>` passed to the node that has it. */
  async proxy(req: Request, url: URL, t: Target & { reachable: boolean }, rest: string, person: Person): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers(t.rec, person) };
    for (const h of ["content-type", "x-agentbox", "accept"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const target = `${this.base(t.rec)}/api/node/sessions/${encodeURIComponent(t.remoteId)}${rest}${url.search}`;
    let res: Response;
    try {
      res = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
    } catch (e) {
      const why = t.reachable ? (e as Error).message : "it is away";
      return Response.json({ ok: false, data: null, error: `node ${t.rec.name} could not be reached: ${why}` }, { status: 502 });
    }
    const out = new Headers();
    for (const h of ["content-type", "cache-control", "content-length", "last-modified", "etag"]) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  }

  /** A watch of a remote session's timeline for one page socket: its
   *  `timeline`, `btw` and `error` frames, under the hub's id for it. */
  watch(t: Target, hubId: string, person: Person, onMsg: (m: ServerMessage) => void, onEnd: () => void): () => void {
    let ws: WebSocket | null = this.socket(t.rec, "/api/node/ws?watch=1", person);
    ws.onopen = () => ws?.send(JSON.stringify({ type: "watch", sessionId: t.remoteId }));
    ws.onmessage = (e) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (m.type === "timeline" || m.type === "btw") onMsg({ ...m, sessionId: hubId });
      else if (m.type === "error") onMsg(m);
    };
    ws.onclose = (e) => {
      // Ended by the node, not by the page: say so, and let it be watched again.
      if (!ws) return;
      ws = null;
      if (e.code !== 1000) onMsg({ type: "error", message: `node ${t.rec.name}: the timeline stopped (${e.reason || e.code})` });
      onEnd();
    };
    return () => {
      const w = ws;
      ws = null;
      try {
        w?.close(1000);
      } catch {
        /* gone */
      }
    };
  }
}
