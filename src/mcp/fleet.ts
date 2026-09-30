/** The fleet MCP server: what a conductor session sees and can do.
 *
 * One claude (or codex) session with this server attached can keep track of
 * every other session on the machine without reading their transcripts into
 * its own context. So every tool answers in compact text, not JSON dumps:
 * `fleet` is a few lines per session, `read_session` condenses a transcript
 * tail to the prompts, the replies and one line per tool call. The conductor
 * pays for exactly what it asks to look at.
 *
 * A thin client of the HTTP API, like the CLI: the server owns the fleet and
 * the balancer, and this process can be started and stopped with the
 * conductor's session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version";
import { apiClient } from "../client";
import type { AppState, Placement, Session, TimelineEvent, TimelinePage } from "../core/types";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const clip = (s: string | null | undefined, n: number): string => {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A session in three lines: who and where, what it was asked, what it said. */
export function brief(s: Session & { attention?: { reason: string } }, accountLabel: string, now: number): string {
  const ctx = s.contextUsed && s.contextLimit ? ` ctx ${Math.round((s.contextUsed / s.contextLimit) * 100)}%` : "";
  const where = s.host === "tmux" ? "" : s.host === "external" ? " (other terminal)" : s.host === "subagent" ? " (subagent)" : "";
  const place = [s.repoRoot ? s.repoRoot.split("/").pop() : s.cwd, s.branch].filter(Boolean).join("@");
  const lines = [
    `[${s.id}] ${s.status}${where} · ${s.provider}/${accountLabel}${s.big ? " · BIG" : ""} · ${place} · ${ago(s.lastActivityAt, now)} ago${ctx}`,
    `  ${clip(s.title, 100)}`,
  ];
  if (s.lastPrompt && s.lastPrompt !== s.title) lines.push(`  asked: ${clip(s.lastPrompt, 160)}`);
  if (s.status === "waiting" && s.turnError) {
    const why =
      s.turnError.kind === "output-cap"
        ? "its reply was cut off by the output token limit — send a message to continue"
        : s.turnError.kind === "transient"
          ? `stopped on an error (${clip(s.turnError.detail, 120)}) — send a message to retry`
          : `stopped on an error a retry cannot fix: ${clip(s.turnError.detail, 120)}`;
    lines.push(`  ! ${why}`);
  }
  if (s.lastMessage) lines.push(`  said: ${clip(s.lastMessage, 220)}`);
  return lines.join("\n");
}

/** A transcript tail as a conductor wants to read it. */
export function condense(events: TimelineEvent[]): string {
  const out: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "user":
        out.push(`USER: ${clip(e.text, 600)}`);
        break;
      case "assistant":
        out.push(`AGENT: ${clip(e.text, 900)}`);
        break;
      case "tool":
        out.push(`  · ${e.name}${e.summary ? ` ${clip(e.summary, 140)}` : ""}${e.status === "error" ? " ✗" : e.status === "running" ? " …" : ""}`);
        break;
      case "meta":
        if (e.tone === "error" || e.tone === "warn") out.push(`  ! ${clip(e.text, 200)}`);
        break;
      case "thinking":
        break;
    }
  }
  return out.join("\n");
}

export async function runMcp(base: string): Promise<void> {
  const api = apiClient(base);
  const server = new McpServer({ name: "agentbox", version: VERSION });

  server.registerTool(
    "fleet",
    {
      title: "Every session, briefly",
      description:
        "Every coding-agent session on this machine that is not closed — Claude Code, Codex, Devin, omp — " +
        "most urgent first (blocked, then waiting for a reply, then working, then stopped), plus each " +
        "account's usage. Three or four lines per session: id, status, provider/account, repo@branch, " +
        "last activity, the title, the last prompt and the last thing the agent said. Call this first " +
        "and whenever you need to re-orient; use read_session to look closer at one.",
      inputSchema: { include_stopped: z.boolean().optional().describe("Include sessions with no running process (default: only those active in the last 24h)") },
    },
    async ({ include_stopped }) => {
      const state = await api<AppState>("GET", "/api/state");
      const now = Date.now();
      const labels = new Map(state.accounts.map((a) => [a.id, a.label]));
      const sessions = state.sessions.filter(
        (s) => s.status !== "closed" && (include_stopped || s.status !== "stopped" || now - s.lastActivityAt < 86_400_000),
      );
      const parts = sessions.map((s) => brief(s, s.accountId ? labels.get(s.accountId) ?? "?" : "-", now));
      const usage = state.accounts.map((a) => {
        const w = a.usage.windows.map((x) => `${x.label} ${Math.round(x.usedPct)}%`).join(", ") || "no reading";
        const claimed = a.claims.reduce((n, c) => n + c.outstanding, 0);
        return `${a.provider}/${a.label}: ${w}${claimed ? ` (+${Math.round(claimed)} claimed)` : ""}${a.enabled ? "" : " [off]"}`;
      });
      return text(`${parts.join("\n\n") || "No sessions."}\n\nACCOUNTS\n${usage.join("\n")}`);
    },
  );

  server.registerTool(
    "read_session",
    {
      title: "Read what a session has been doing",
      description:
        "The recent transcript of one session, condensed: your prompts, the agent's replies, and one line per " +
        "tool call (✗ failed, … still running). Thinking is omitted. Raise `limit` to look further back.",
      inputSchema: {
        id: z.string().describe("Session id from `fleet`"),
        limit: z.number().int().min(1).max(400).optional().describe("How many events (default 60)"),
      },
    },
    async ({ id, limit }) => {
      const page = await api<TimelinePage>("GET", `/api/sessions/${id}/timeline?limit=${limit ?? 60}`);
      return text(condense(page.events) || "(no transcript yet)");
    },
  );

  server.registerTool(
    "send",
    {
      title: "Type a message into a session",
      description:
        "Sends `text` to a session running in agentbox, exactly as if typed at its prompt and submitted. " +
        "Works only for sessions agentbox runs (not ones in another terminal — adopt those first) and " +
        "only sensibly when the session is waiting for input.",
      inputSchema: { id: z.string(), text: z.string().min(1) },
    },
    async ({ id, text: body }) => {
      await api("POST", `/api/sessions/${id}/send`, { text: body, from: "agent", fromSession: process.env.AGENTBOX_SESSION });
      return text(`sent to ${id}`);
    },
  );

  server.registerTool(
    "spawn",
    {
      title: "Start a new session",
      description:
        "Starts a new agent session in `cwd` with `prompt`, placed on whichever account has the most room " +
        "(or `account`, a label, if given). Set `big` for work expected to use far more than a normal " +
        "session — it reserves more of the account's weekly budget so other sessions go elsewhere. " +
        "Returns the new session's id and why it went to that account.",
      inputSchema: {
        provider: z.enum(["claude", "codex", "devin", "omp"]),
        cwd: z.string().describe("Absolute path of the directory to work in"),
        prompt: z.string().min(1),
        big: z.boolean().optional(),
        account: z.string().optional().describe("Account label to force; omit to let the balancer choose"),
        model: z.string().optional(),
      },
    },
    async ({ provider, cwd, prompt, big, account, model }) => {
      let accountId: string | null = null;
      if (account) {
        const state = await api<AppState>("GET", "/api/state");
        const match = state.accounts.find((a) => a.provider === provider && (a.label === account || a.id === account || a.email === account));
        if (!match) throw new Error(`no ${provider} account "${account}"`);
        accountId = match.id;
      }
      const out = await api<{ session: Session; placement: Placement }>("POST", "/api/sessions", {
        provider, cwd, prompt, big, model, accountId, callerPid: process.pid,
      });
      return text(`started ${out.session.id}: ${out.placement.why}`);
    },
  );

  server.registerTool(
    "resume",
    {
      title: "Resume a stopped session",
      description: "Restarts a stopped session on the account it was on, optionally with a first message.",
      inputSchema: { id: z.string(), prompt: z.string().optional() },
    },
    async ({ id, prompt }) => {
      const s = await api<Session>("POST", `/api/sessions/${id}/resume`, { prompt });
      return text(`${s.id} is ${s.status}`);
    },
  );

  server.registerTool(
    "interrupt",
    {
      title: "Interrupt a working session",
      description: "Presses Escape in the session — stops the current turn, like interrupting it by hand.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      await api("POST", `/api/sessions/${id}/interrupt`, {});
      return text(`interrupted ${id}`);
    },
  );

  server.registerTool(
    "close",
    {
      title: "Close or reopen a session",
      description: "Close stops a finished session's process and takes it, and every session it started (at any depth), off the fleet; they stay resumable. Running ones are stopped, so ask before closing a session whose children are running. closed: false reopens it (back on the list, still stopped).",
      inputSchema: { id: z.string(), closed: z.boolean().optional() },
    },
    async ({ id, closed }) => {
      await api("POST", `/api/sessions/${id}/close`, { closed: closed ?? true });
      return text(`${closed === false ? "reopened" : "closed"} ${id}`);
    },
  );

  await server.connect(new StdioServerTransport());
}
