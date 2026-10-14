import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../paths";
import { z } from "zod";
import type { AgentsRuntime } from "./runtime";
import {
  ProposalInput,
  Proposal,
  ReadCursor,
  relayIdentity,
  sealPage,
  type ConversationPage,
} from "../../cloud/agent-conversation";
import { AGENT_TEMPLATES } from "../../cloud/agents";
import { FleetError, newSessionId } from "../fleet";
import { submitWithReceipt, sendReceipt } from "../send-receipts";
import type { TimelineEvent } from "../types";
import { getRepoById, getSessionRecord } from "../db";

type LocalAgent = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  provider: "codex" | "claude" | "muse";
  repo: string | null;
  session: string | null;
  previous: string[];
  enabled: boolean;
};
const SAFE_EVENT = new Set(["user", "assistant"]);
const safeText = (s: string) =>
  s
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[credential removed]",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[private key removed]",
    );
export class AgentConversations {
  private busy = new Set<string>();
  private ticking = false;
  constructor(readonly runtime: AgentsRuntime) {}
  private get db() {
    const db = this.runtime.store.db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS local_agents(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_proposals(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_submissions(id TEXT PRIMARY KEY,agent TEXT NOT NULL,session TEXT NOT NULL);",
    );
    return db;
  }
  local(): LocalAgent[] {
    const db = this.db;
    for (const t of AGENT_TEMPLATES) {
      const id = `local-${t.name.toLowerCase()}`;
      db.run("INSERT OR IGNORE INTO local_agents(id,body) VALUES (?,?)", [
        id,
        JSON.stringify({
          id,
          name: t.name,
          role: t.definition.role,
          instructions: t.definition.instructions,
          provider: "codex",
          repo: null,
          session: null,
          previous: [],
          enabled: true,
        }),
      ]);
    }
    return (
      db.query("SELECT body FROM local_agents").all() as { body: string }[]
    ).map((x) => JSON.parse(x.body));
  }
  owns(id: string) {
    return this.local().some(
      (a) => a.session === id || a.previous.includes(id),
    );
  }
  private put(a: LocalAgent) {
    this.db.run("UPDATE local_agents SET body=? WHERE id=?", [
      JSON.stringify(a),
      a.id,
    ]);
  }
  async configure(id: string, input: unknown) {
    const p = z
      .object({
        provider: z.enum(["codex", "claude", "muse"]),
        repo: z.string().nullable(),
        enabled: z.boolean(),
      })
      .strict()
      .parse(input);
    const a = this.local().find((x) => x.id === id);
    if (!a) throw new FleetError(404, "Agent not found");
    if (p.repo && !getRepoById(p.repo))
      throw new FleetError(400, "Choose a registered repository");
    if (a.session && (a.provider !== p.provider || a.repo !== p.repo))
      throw new FleetError(
        409,
        "This conversation already has a provider and workspace",
      );
    if (!p.enabled && a.session) {
      const session = this.runtime.fleet
        .sessions()
        .find((s) => s.id === a.session);
      if (session?.host !== "none" && session)
        await this.runtime.fleet.stopSession(a.session);
    }
    Object.assign(a, p);
    this.put(a);
    return a;
  }
  async localSend(id: string, request: string, body: string) {
    if (this.busy.has(id))
      throw new FleetError(409, "Another message is being delivered");
    this.busy.add(id);
    try {
      const a = this.local().find((x) => x.id === id);
      if (!a || !a.enabled) throw new FleetError(409, "Agent is paused");
      if (!body.trim() || body.length > 24000)
        throw new FleetError(400, "Write a message up to 24000 characters");
      const prior=this.db.query("SELECT agent,session FROM local_submissions WHERE id=?").get(request) as {agent:string;session:string}|null;
      if(prior&&prior.agent!==id)throw new FleetError(409,"Submission belongs to another agent");
      // Fleet records its identity before starting tmux. No record proves a
      // previous preflight never spawned; an uncertain existing session stays.
      if(a.session&&!getSessionRecord(a.session))a.session=null;
      const fresh = !a.session&&!prior;
      if (fresh) {
        a.session = newSessionId();
        this.put(a);
      }
      const sid = prior?.session??a.session!;
      this.db.run("INSERT OR IGNORE INTO local_submissions(id,agent,session) VALUES (?,?,?)",[request,id,sid]);
      const cwd=join(agentboxHome(),"agents","local",a.id);mkdirSync(cwd,{recursive:true,mode:0o700});
      const receipt = await submitWithReceipt(
        sid,
        request,
        "agent-chat",
        body,
        async (attempt) => {
          if (fresh) {
            attempt();
            await this.runtime.fleet.spawn({
              id: sid,
              provider: a.provider,
              repoId: a.repo ?? undefined,
              cwd,
              worktree: !!a.repo,
              prompt: `You are ${a.name}, an ongoing local Agentbox agent. ${a.role}.\n${a.instructions}\nThis is the user's ongoing conversation. Keep context in this provider transcript. Remain available after each answer. Do not spawn another agent or start recurring repository discovery without a request. No external contact, publication, merge, deployment or credentials access is authorized by merely creating this chat. Use the existing agentbox waits when needed. Publish useful, evidence-backed recommendations through: agentbox agent recommend ${a.id} --request <stable UUID> --file <JSON path>. JSON: {title,finding,reason,next,evidence:[{url,label}]}. Those cards appear in Chat and Feed. Feed approval authorizes only its exact next step. Keep all secrets out of recommendations and replies.\n\nUser: ${body}`,
            });
          } else await this.runtime.fleet.send(sid, body, attempt, true);
        },
      );
      if(!getSessionRecord(sid)&&a.session===sid){a.session=null;this.put(a);}
      return {
        id: request,
        state:
          receipt.state === "sent"
            ? "sent"
            : receipt.state === "failed" || !getSessionRecord(sid)
              ? "refused"
              : "uncertain",
        result: receipt.error ?? "",
      };
    } finally {
      this.busy.delete(id);
    }
  }
  localReceipt(id: string, request: string) {
    const a = this.local().find((x) => x.id === id),
      prior=this.db.query("SELECT session FROM local_submissions WHERE id=? AND agent=?").get(request,id) as {session:string}|null,
      sid=prior?.session??a?.session,
      r = sid ? sendReceipt(sid, request) : null;
    return r
      ? {
          id: request,
          state:
            r.state === "sent"
              ? "sent"
              : r.state === "failed" || !getSessionRecord(sid!)
                ? "refused"
                : "uncertain",
          result: r.error ?? "",
        }
      : null;
  }
  localProposals(id: string) {
    return (
      this.db.query("SELECT body FROM local_proposals").all() as {
        body: string;
      }[]
    )
      .map((x) => JSON.parse(x.body) as Proposal)
      .filter((p) => p.agent_id === id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async propose(
    target: string,
    session: string | null,
    id: string,
    input: unknown,
  ) {
    const p = ProposalInput.parse(input);
    const a = this.local().find((x) => x.id === target);
    if (a) {
      if (!session || a.session !== session)
        throw new FleetError(
          403,
          "Only the current linked agent session can curate this Feed",
        );
      if (p.action)
        throw new FleetError(
          400,
          "Local recommendations cannot approve managed GitHub actions",
        );
      const item: Proposal = {
        id,
        agent_id: a.id,
        run_id: session,
        config_revision: 1,
        title: p.title,
        finding: p.finding,
        reason: p.reason,
        next_step: p.next,
        evidence: p.evidence,
        action_id: null,
        state: "open",
        decided_by: null,
        created_at: new Date().toISOString(),
      };
      const old = this.localProposals(a.id).find((x) => x.id === id);
      if (old) {
        for (const k of [
          "title",
          "finding",
          "reason",
          "next_step",
          "evidence",
        ] as const)
          if (JSON.stringify(old[k]) !== JSON.stringify(item[k]))
            throw new FleetError(
              409,
              "This proposal ID already names another recommendation",
            );
        return old;
      }
      this.db.run("INSERT INTO local_proposals(id,body) VALUES (?,?)", [
        id,
        JSON.stringify(item),
      ]);
      this.runtime.cards.add({
        kind: "note",
        key: `agent-proposal:${id}`,
        title: p.title,
        short: `${p.finding}\n\nDecide this recommendation in Agents → Feed.`,
        long: JSON.stringify(item, null, 2),
        sessionId: session,
        notify: false,
        recommend: p.next,
      });
      return item;
    }
    const { local } = await this.runtime.current(target, session);
    const proposal = await this.runtime
      .api()
      .installation.agentCall(
        "inst_agent_propose",
        {
          p_run: local.run.id,
          p_fence: local.run.fence,
          p_id: id,
          p_proposal: p,
        },
        Proposal,
      );
    this.runtime.cards.add({
      kind: "note",
      key: `agent-proposal:${id}`,
      title: p.title,
      short: `${p.finding}\n\nDecide this shared recommendation in Agents → Feed.`,
      sessionId: session,
      notify: false,
    });
    return proposal;
  }
  async localDecide(
    agent: string,
    id: string,
    decision: string,
    request: string,
  ) {
    const p = this.localProposals(agent).find((p) => p.id === id);
    if (!p) throw new FleetError(404, "Recommendation not found");
    if (!["approved", "dismissed"].includes(decision))
      throw new FleetError(400, "Invalid decision");
    if (p.state === decision) return p;
    if (p.state !== "open") throw new FleetError(409, "Already decided");
    const a = this.local().find((x) => x.id === agent);
    if (!a?.session || !a.enabled)
      throw new FleetError(409, "Agent unavailable");
    if (decision === "approved")
      await this.localSend(
        agent,
        request,
        `Approved recommendation ${id}: ${p.next_step}. Only this next step is authorized; other actions and outreach keep their existing requirements.`,
      );
    p.state = decision as "approved" | "dismissed";
    this.db.run("UPDATE local_proposals SET body=? WHERE id=?", [
      JSON.stringify(p),
      id,
    ]);
    const card = this.runtime.cards
      .list()
      .find((c) => c.key === `agent-proposal:${id}`);
    if (card?.state === "open")
      this.runtime.cards.close(
        card.id,
        decision === "dismissed"
          ? "Dismissed in Feed"
          : "Decided in Feed; delivery has its own receipt",
      );
    return p;
  }
  async page(agent: string, input: unknown): Promise<ConversationPage> {
    const cursor = ReadCursor.parse(input);
    const local = this.local().find((x) => x.id === agent);
    let ids: string[];
    if (local)
      ids = [local.session, ...local.previous].filter((x): x is string => !!x);
    else {
      const runs = this.runtime.store
        .runs()
        .filter((x) => x.run.agent_id === agent)
        .sort((a, b) => b.run.created_at.localeCompare(a.run.created_at));
      const seen = new Set<string>();
      ids = [];
      for (const r of runs) {
        const rows = this.runtime.store.db
          .query("SELECT id FROM sessions WHERE run=? ORDER BY rowid DESC")
          .all(r.run.id) as { id: string }[];
        for (const x of rows)
          if (!seen.has(x.id)) {
            seen.add(x.id);
            ids.push(x.id);
          }
      }
    }
    const id = ids[cursor.session];
    if (!id) return { events: [], next: null, session: null, status: "idle" };
    const session = this.runtime.fleet.sessions().find((s) => s.id === id);
    try {
      const page = await this.runtime.fleet.timeline(id, cursor.before, 60);
      const events = page.events
        .filter((e) => SAFE_EVENT.has(e.kind))
        .map((e) => ({
          ...e,
          text: safeText("text" in e ? String(e.text) : "").slice(0, 10000),
        })) as TimelineEvent[];
      return {
        events,
        next: page.before
          ? { session: cursor.session, before: page.before }
          : ids[cursor.session + 1]
            ? { session: cursor.session + 1, before: null }
            : null,
        session: id,
        status: session?.status ?? "stopped",
      };
    } catch (e) {
      return {
        events: [],
        next: ids[cursor.session + 1]
          ? { session: cursor.session + 1, before: null }
          : null,
        session: id,
        status: session?.status ?? "starting",
        error: (e as Error).message,
      };
    }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.transportTick(); } finally { this.ticking = false; }
  }
  private async transportTick() {
    if (!this.runtime.cloud.status().installation) return;
    const api = this.runtime.api().installation;
    const pending = await api.agentCall(
      "inst_agent_commands",
      {},
      z.array(
        z.object({
          id: z.string(),
          run_id: z.string(),
          state: z.string(),
          session_id: z.string().nullable(),
        }),
      ),
    );
    for (const item of pending) {
      try {
        const c = await api.agentCall(
          "inst_agent_command_claim",
          { p_id: item.id },
          z.object({
            id: z.string(),
            run_id: z.string(),
            user_id: z.string(),
            body: z.string().nullable(),
            session_id: z.string(),
            fence: z.number(),
            proposal_id: z.string().nullable(),
          }),
        );
        const local = this.runtime.store
          .runs()
          .find((r) => r.run.id === c.run_id);
        if (
          !local ||
          local.session !== c.session_id ||
          local.run.fence !== c.fence
        )
          throw new Error("Responsible session changed; delivery refused");
        const payload = `[Workspace guidance from ${c.user_id}${c.proposal_id ? `; proposal ${c.proposal_id}` : ""}]\n${c.body}`;
        const r = await submitWithReceipt(
          c.session_id,
          c.id,
          "shared-agent-guidance",
          payload,
          async (attempt) => {
            // Recheck current membership, lease, host grant and target immediately
            // before typing. The transport body is purged after its terminal receipt.
            await api.agentCall(
              "inst_agent_command_claim",
              { p_id: c.id },
              z.unknown(),
            );
            await this.runtime.fleet.send(c.session_id, payload, attempt, true);
          },
        );
        await api.agentCall(
          "inst_agent_command_result",
          {
            p_id: c.id,
            p_state:
              r.state === "sent"
                ? "sent"
                : r.state === "failed"
                  ? "refused"
                  : "uncertain",
            p_result: r.error ?? "",
          },
          z.unknown(),
        );
      } catch (e) {
        if (item.state === "attempting" && item.session_id) {
          const receipt = sendReceipt(item.session_id, item.id);
          await api
            .agentCall(
              "inst_agent_command_result",
              {
                p_id: item.id,
                p_state: receipt?.state === "sent" ? "sent" : "uncertain",
                p_result: "Delivery authorization changed; no replay",
              },
              z.unknown(),
            )
            .catch(() => undefined);
        } else
          await api
            .agentCall(
              "inst_agent_command_result",
              {
                p_id: item.id,
                p_state: "refused",
                p_result: (e as Error).message,
              },
              z.unknown(),
            )
            .catch(() => undefined);
      }
    }
    const reads = await api.agentCall(
      "inst_agent_reads",
      {},
      z.array(
        z.object({
          id: z.string(),
          agent_id: z.string(),
          client_key: z.string(),
          cursor: z.unknown(),
        }),
      ),
    );
    for (const q of reads) {
      try {
        const identity = await relayIdentity();
        await api.agentCall(
          "inst_agent_read_offer",
          { p_id: q.id, p_key: identity.key },
          z.unknown(),
        );
        const page = await this.page(q.agent_id, q.cursor),
          sealed = await sealPage(identity.pair, q.client_key, q.id, page);
        const channel = api.sb.channel(`agent-read:${q.id}`);
        try {
          for (let index = 0; index < sealed.chunks.length; index++) {
            await api.agentCall(
              "inst_agent_read_offer",
              { p_id: q.id, p_key: identity.key },
              z.unknown(),
            );
            const result = await channel.httpSend("page", {
              index,
              total: sealed.chunks.length,
              iv: sealed.iv,
              data: sealed.chunks[index],
            });
            if (!result.success)
              throw new Error("Realtime read relay unavailable");
          }
        } finally {
          await api.sb.removeChannel(channel);
        }
      } catch {
        /* No plaintext error/response on an unauthenticated broadcast. Request expires. */
      }
    }
  }
}
