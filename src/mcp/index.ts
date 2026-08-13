import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * agentbox MCP server — lets a conductor agent run and babysit every agent.
 *
 * This is a thin adapter over the running agentbox HTTP API: the HTTP server
 * owns all omp processes, so the conductor talks to that one source of truth.
 */

const API = process.env.AGENTBOX_API ?? "http://127.0.0.1:4479";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? "agentbox request failed");
  return body.data as T;
}

function sessionView(s: any) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    waiting: s.waitingForInput,
    blocked: s.blocked,
    repo: s.repo,
    branch: s.branch,
    model: s.model,
    lastMessage: s.lastMessage,
    costUsd: s.costUsd,
    tokens: s.tokens,
    followUps: s.followUps,
    prNumber: s.prNumber,
    updatedAt: s.updatedAt,
  };
}

const server = new McpServer({ name: "agentbox", version: "0.1.0" });

server.registerTool(
  "state",
  { title: "Current agentbox state", description: "Sessions, conductor, PRs, skills, repos and settings in one call." },
  async () => {
    const st = await api<any>("/api/state");
    return {
      content: [{ type: "text", text: JSON.stringify({
        sessions: st.sessions.map(sessionView),
        conductor: st.conductor,
        prs: st.prs,
        skills: st.skills.map((s: any) => ({ name: s.name, description: s.description, source: s.source })),
        repos: st.repos,
        settings: st.settings,
      }, null, 2) }],
    };
  }
);

server.registerTool(
  "list_sessions",
  { title: "List sessions", description: "Every agentbox session and its status." },
  async () => {
    const st = await api<any>("/api/state");
    return { content: [{ type: "text", text: JSON.stringify(st.sessions.map(sessionView), null, 2) }] };
  }
);

server.registerTool(
  "spawn_session",
  {
    title: "Spawn an omp session",
    description: "Create a worktree and start an omp agent on the given task.",
    inputSchema: {
      repo_ref: z.string().describe("Repo the session works on: a registered repo id, a local path, or an owner/repo slug"),
      prompt: z.string().describe("The task for the agent"),
      model: z.string().optional().describe("omp model id (defaults to settings)"),
      branch: z.string().optional().describe("Check out this existing branch instead of a fresh one (e.g. a PR head branch)"),
    },
  },
  async ({ repo_ref, prompt, model, branch }) => {
    let repo = (await api<any[]>("/api/repos")).find((r) => r.id === repo_ref || r.ref === repo_ref);
    if (!repo) {
      repo = await api<any>("/api/repos", { method: "POST", body: JSON.stringify({ ref: repo_ref }) });
    }
    const s = await api<any>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ repo_id: repo.id, prompt, model, branch }),
    });
    return { content: [{ type: "text", text: JSON.stringify(sessionView(s), null, 2) }] };
  }
);

server.registerTool(
  "send_message",
  {
    title: "Send a message to a session",
    description: "Steer an agent: queues the message if it is mid-turn, delivers immediately if it is waiting. Resurrects a dead session via its saved conversation.",
    inputSchema: { session_id: z.string(), text: z.string() },
  },
  async ({ session_id, text }) => {
    const s = await api<any>(`/api/sessions/${session_id}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    return { content: [{ type: "text", text: JSON.stringify(sessionView(s), null, 2) }] };
  }
);

server.registerTool(
  "interrupt",
  {
    title: "Interrupt a session",
    description: "Cancel the current turn. The session returns to waiting and any queued messages are still delivered next.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    const s = await api<any>(`/api/sessions/${session_id}/interrupt`, { method: "POST" });
    return { content: [{ type: "text", text: JSON.stringify(sessionView(s), null, 2) }] };
  }
);

server.registerTool(
  "reply_permission",
  {
    title: "Approve or deny a permission request",
    description: "Resolve a blocked session's pending tool permission request.",
    inputSchema: { session_id: z.string(), approved: z.boolean() },
  },
  async ({ session_id, approved }) => {
    const s = await api<any>(`/api/sessions/${session_id}/permission`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
    return { content: [{ type: "text", text: JSON.stringify(sessionView(s), null, 2) }] };
  }
);

server.registerTool(
  "wait",
  {
    title: "Wait for a session to stop working",
    description: "Polls until the session leaves 'running'/'spawning' (or the timeout hits). Returns the final status — the core babysitting primitive.",
    inputSchema: {
      session_id: z.string(),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe("default 120"),
    },
  },
  async ({ session_id, timeout_seconds }) => {
    const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
    for (;;) {
      const st = await api<any>("/api/state");
      const s = st.sessions.find((x: any) => x.id === session_id);
      if (!s) return { content: [{ type: "text", text: JSON.stringify({ error: "session not found" }) }] };
      if (s.status !== "running" && s.status !== "spawning") {
        return { content: [{ type: "text", text: JSON.stringify(sessionView(s), null, 2) }] };
      }
      if (Date.now() > deadline) {
        return { content: [{ type: "text", text: JSON.stringify({ timedOut: true, ...sessionView(s) }, null, 2) }] };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
);

server.registerTool(
  "get_transcript",
  {
    title: "Session transcript",
    description: "The user/assistant exchange for a session, from its log.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    const tl = await api<any[]>(`/api/sessions/${session_id}/transcript`);
    const text = tl.map((l) => `[${l.role}] ${l.text}`).join("\n\n");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "archive_session",
  {
    title: "Archive a session",
    description: "File a session away off the board (keeps transcript).",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    await api<any>(`/api/sessions/${session_id}/archive`, { method: "POST" });
    return { content: [{ type: "text", text: "archived" }] };
  }
);

server.registerTool(
  "delete_session",
  {
    title: "Delete a session",
    description: "Permanently delete a session, its worktree, and logs.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    await api<any>(`/api/sessions/${session_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: "deleted" }] };
  }
);

server.registerTool(
  "list_prs",
  { title: "List open pull requests", description: "Open PRs across registered GitHub repos." },
  async () => {
    const st = await api<any>("/api/state");
    return { content: [{ type: "text", text: JSON.stringify(st.prs, null, 2) }] };
  }
);

server.registerTool(
  "list_repos",
  { title: "List repositories", description: "Repositories agentbox can spawn sessions on." },
  async () => {
    const repos = await api<any[]>("/api/repos");
    return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
  }
);

server.registerTool(
  "add_repo",
  {
    title: "Add a repository",
    description: "Register a local git path or owner/repo slug.",
    inputSchema: { ref: z.string() },
  },
  async ({ ref }) => {
    const r = await api<any>("/api/repos", { method: "POST", body: JSON.stringify({ ref }) });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

server.registerTool(
  "list_skills",
  { title: "List skills", description: "Skills available to agents." },
  async () => {
    const st = await api<any>("/api/state");
    return { content: [{ type: "text", text: JSON.stringify(st.skills.map((s: any) => ({ name: s.name, description: s.description, source: s.source })), null, 2) }] };
  }
);

server.registerTool(
  "get_settings",
  { title: "Get settings", description: "agentbox settings (model, auto-approve, max run time, theme)." },
  async () => {
    const s = await api<any>("/api/settings");
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  }
);

server.registerTool(
  "set_settings",
  {
    title: "Update settings",
    description: "Change agentbox settings.",
    inputSchema: {
      model: z.string().optional(),
      autoApprove: z.boolean().optional(),
      maxMinutes: z.number().int().optional(),
      theme: z.enum(["light", "dark", "system"]).optional(),
    },
  },
  async (patch) => {
    const s = await api<any>("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agentbox MCP server ready");
