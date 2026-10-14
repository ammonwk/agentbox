import { CreationSpec, CreationDraft, JUPITER_ROLE, JUPITER_INSTRUCTIONS, creationTool } from "../../cloud/agent-creation";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { transcriptFile } from "../providers/types";
import { agentboxHome, agentboxCommand } from "../paths";
import { z } from "zod";
import type { AgentsRuntime } from "./runtime";
import {
  ProposalInput,
  Proposal,
  ReadCursor,
  relayIdentity,
  sealPage,
  type ConversationPage,
  type AgentThread,
} from "../../cloud/agent-conversation";
import { AGENT_TEMPLATES } from "../../cloud/agents";
import { FleetError, newSessionId } from "../fleet";
import { submitWithReceipt, sendReceipt } from "../send-receipts";
import type { TimelineEvent } from "../types";
import { getRepoById, getSessionRecord, getSettings, listSessionRecords, listOpenWaits, updateSessionRecord } from "../db";
import { AgentMemory, DEFAULT_MEMORY_POLICY, MemoryPolicy, type Supplied } from "./memory";
import { avatarFile, removeAvatar, saveAvatar } from "./avatar";
import { AUTO_PROVIDERS, chooseProvider, type AgentProvider, type ProviderChoice } from "./providers";
import { detectCli } from "../accounts/homes";
import { attribute, type RegisteredAgent, type SenderDirectory } from "../senders";
import { moveCards } from "../cards";
import { movePrClaims, unfinishedClaims } from "../prclaims";
import { isKeepWarmNote } from "../cache";
import { describe as describeWait } from "../waits";

export type LocalAgent = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  /** The provider of the current, or last, conversation. */
  provider: AgentProvider;
  /** An explicit override. Absent is Automatic (`providers.ts`): legacy
   *  records that only carry the old implicit default are Automatic too. */
  pinned?: AgentProvider;
  /** Why the current conversation's provider was chosen. */
  selection?: Pick<ProviderChoice, "provider" | "accountId" | "model" | "policy" | "why" | "at">;
  repo: string | null;
  /** Immutable navigation scope for project instances; legacy general agents have none. */
  project?: string;
  sessionProjects?: Record<string, string | null>;
  session: string | null;
  previous: string[];
  workSessions?: string[];
  enabled: boolean;
  capability?: "creator";
  createdBy?: string;
  creation?: string;
  automation?: string;
  memoryPolicy?: Partial<MemoryPolicy>;
  /** The latest handoff asked of the current conversation. */
  checkpoint?: {
    session: string;
    request: string;
    at: number;
    reason: "idle" | "context";
    /** How full the conversation was when asked, in percent. */
    pct: number;
    state: "requested" | "saved" | "failed";
    handoff?: string;
    error?: string;
  };
  /** A replacement in progress, journaled before each step. */
  rollover?: {
    from: string;
    to: string;
    handoff: string;
    why: "cold" | "context";
    at: number;
    phase: "stopping" | "spawning";
    supplied?: Supplied[];
    /** Chosen before anything was stopped (`providers.ts`). */
    provider?: AgentProvider;
    selection?: LocalAgent["selection"];
  };
  /** For each conversation started from memory, the handoffs its first prompt
   *  carried: the only earlier conversations its main chat scrolls back into. */
  contexts?: Record<string, Supplied[]>;
  /** Conversations replaced from a saved handoff, each to its successor. */
  rolled?: Record<string, string>;
  /** The agent's picture (src/core/agents/avatar.ts); `at` versions its URL. */
  avatar?: { file: string; at: number };
};
/** Starts the fleet's request for a handoff; the request ID follows. */
export const CHECKPOINT_MARK = "[agentbox: memory checkpoint";
/** Ask only while at least this much of the cache's life is left. */
const CHECKPOINT_WARM_MS = 3 * 60_000;
/** A request with no handoff after this long has failed. */
const CHECKPOINT_WAIT_MS = 15 * 60_000;
const policyOf = (a: LocalAgent): MemoryPolicy => ({ ...DEFAULT_MEMORY_POLICY, ...a.memoryPolicy });
export type Checkpoint = NonNullable<LocalAgent["checkpoint"]>;
/** A conversation whose handoff is asked for: a local agent's, or a shared
 *  agent's coordinator run on this host. `target` is what the CLI names. */
export type Keeper = {
  target: string;
  session: string;
  policy: MemoryPolicy;
  checkpoint?: Checkpoint;
  update(change: (c: Checkpoint | undefined) => Checkpoint | undefined): void;
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
  private remembering = false;
  /** Agent → the session `localSend` is delivering to while it holds `busy`. */
  private sending = new Map<string, string>();
  /** Agents whose conversation is being replaced in this process. */
  private rolling = new Set<string>();
  /** Session → the activity time its transcript tail was last checked at. */
  private looked = new Map<string, number>();
  private sessionActions = new Set<string>();
  #memory: AgentMemory | null = null;
  constructor(readonly runtime: AgentsRuntime) {}
  get memory() {
    return (this.#memory ??= new AgentMemory(this.runtime.store.db));
  }
  private get db() {
    const db = this.runtime.store.db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS local_agents(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_proposals(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_submissions(id TEXT PRIMARY KEY,agent TEXT NOT NULL,session TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_creations(id TEXT PRIMARY KEY,creator TEXT NOT NULL,body TEXT NOT NULL);",
    );
    return db;
  }
  local(project?: string): LocalAgent[] {
    if (project && !getRepoById(project)) throw new FleetError(404, "Project is no longer registered");
    const db = this.db;
    for (const t of [...AGENT_TEMPLATES, { id: "jupiter", name: "Jupiter", definition: { role: JUPITER_ROLE, instructions: JUPITER_INSTRUCTIONS } }]) {
      const id = `local-${t.name.toLowerCase()}${project ? `-project-${encodeURIComponent(project)}` : ""}`;
      db.run("INSERT OR IGNORE INTO local_agents(id,body) VALUES (?,?)", [
        id,
        JSON.stringify({
          id,
          name: t.name,
          ...(t.id === "jupiter" ? { capability: "creator" } : {}),
          role: t.definition.role,
          instructions: t.definition.instructions,
          provider: "codex",
          repo: project ?? null,
          ...(project ? { project } : {}),
          sessionProjects: {},
          session: null,
          previous: [],
          enabled: true,
        }),
      ]);
    }
    return (
      db.query("SELECT body FROM local_agents").all() as { body: string }[]
    ).map((x) => {
      const a = JSON.parse(x.body) as LocalAgent;
      return {...a, workSessions: this.runtime.works.list().filter(w=>w.agent.id===a.id).map(w=>w.session)};
    });
  }
  creations(creator: string): CreationDraft[] {
    return (this.db.query("SELECT body FROM local_creations WHERE creator=? ORDER BY rowid DESC LIMIT 100").all(creator) as {body: string}[]).map((r) => CreationDraft.parse(JSON.parse(r.body)));
  }
  async draft(target: string, caller: string | null, request: string, input: unknown) {
    const spec = CreationSpec.parse(input), a = this.local().find((a) => a.id === target);
    if (!a) {
      const { run, a } = await this.runtime.current(target, caller);
      if (a.capability !== "creator") throw new FleetError(403, "Only a creator can propose agents");
      if (spec.provider === "auto") throw new FleetError(400, "Shared agents run on their execution host's configured provider; name codex, claude or muse");
      return this.runtime.api().installation.agentCall("inst_agent_creation_draft", { p_run: run.id, p_fence: run.fence, p_id: request, p_spec: spec }, CreationDraft);
    }
    if (a.capability !== "creator" || !a.enabled || !caller || caller !== a.session) throw new FleetError(403, "Only the current creator session can propose agents");
    const draft: CreationDraft = { id: request, creator: a.id, run: caller, revision: 1, spec, created: null };
    const old = this.db.query("SELECT body FROM local_creations WHERE id=?").get(request) as {body: string} | null;
    if (old) {
      const prior = CreationDraft.parse(JSON.parse(old.body));
      if (prior.creator !== target || prior.run !== caller || JSON.stringify(prior.spec) !== JSON.stringify(spec)) throw new FleetError(409, "Draft ID already used or edited");
      return prior;
    }
    this.db.run("INSERT INTO local_creations(id,creator,body) VALUES(?,?,?)", [request, target, JSON.stringify(draft)]);
    return draft;
  }
  editCreation(creator: string, id: string, revision: number, repo: string | null, input: unknown, create: boolean) {
    const spec = CreationSpec.parse(input);
    return this.db.transaction(() => {
      const a = this.local().find((a) => a.id === creator), draft = this.creations(creator).find((d) => d.id === id);
      if (!a || a.capability !== "creator" || a.repo !== repo || !draft) throw new FleetError(403, "Draft does not belong to this creator/project");
      if (draft.revision !== revision || JSON.stringify(draft.spec) !== JSON.stringify(spec) && create) throw new FleetError(409, "Draft changed; save edits and review the current version");
      if (draft.created) { if (!create) throw new FleetError(409, "Already created"); return draft; }
      if (!a.enabled || a.session !== draft.run) throw new FleetError(409, "Creator conversation replaced; request a new proposal");
      if (repo && !getRepoById(repo)) throw new FleetError(409, "Project no longer registered");
      if (create) {
        const id = `local-custom-${draft.id}`;
        const agent: LocalAgent = { id, name: spec.name, role: spec.role,
          instructions: `${spec.instructions}\n\nLimits: ${spec.limits}`,
          provider: spec.provider === "auto" ? AUTO_PROVIDERS[0]! : spec.provider, ...(spec.provider === "auto" ? {} : { pinned: spec.provider }),
          repo, ...(repo ? { project: repo } : {}), session: null, previous: [], sessionProjects: {}, enabled: true,
          createdBy: "local operator", creation: draft.id, automation: spec.automation };
        this.db.run("INSERT INTO local_agents(id,body) VALUES(?,?)", [id, JSON.stringify(agent)]);
        draft.created = id;
      } else { draft.spec = spec; draft.revision++; }
      this.db.run("UPDATE local_creations SET body=? WHERE id=?", [JSON.stringify(draft), id]);
      return draft;
    })();
  }
  owns(id: string) {
    return !!this.runtime.works.forSession(id) || this.local().some(
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
    if (this.busy.has(id) || this.rolling.has(id))
      throw new FleetError(
        409,
        "Another message or workspace change is in progress",
      );
    this.busy.add(id);
    try {
      const p = z
        .object({
          /** "auto" lets each fresh conversation choose; a provider is an explicit override. */
          provider: z.enum(["auto", "codex", "claude", "muse"]),
          repo: z.string().nullable(),
          enabled: z.boolean(),
          memoryPolicy: MemoryPolicy.optional(),
        })
        .strict()
        .parse(input);
      const a = this.local().find((x) => x.id === id);
      if (!a) throw new FleetError(404, "Agent not found");
      if (a.project && p.repo !== a.project)
        throw new FleetError(409, "Project agents keep separate conversations; switch projects to use another instance");
      if (p.repo && !getRepoById(p.repo))
        throw new FleetError(400, "Choose a registered repository");
      // A conversation the new policy still allows keeps going: Automatic
      // never ends a warm one, and pinning its own provider changes nothing.
      if (a.session && ((p.provider !== "auto" && a.provider !== p.provider) || a.repo !== p.repo)) {
        const old = a.session,
          session = this.runtime.fleet.sessions().find((s) => s.id === old);
        if (session?.status === "running" || session?.status === "blocked")
          throw new FleetError(
            409,
            "Let the current turn finish before changing the workspace",
          );
        const record = getSessionRecord(old);
        if (
          record &&
          (!record.transcriptPath ||
            !existsSync(transcriptFile(record.transcriptPath)))
        )
          throw new FleetError(
            409,
            "The provider has not recorded this conversation yet; try after its first reply",
          );
        if (session && session.host !== "none")
          await this.runtime.fleet.stopSession(old);
        await this.runtime.fleet.tick();
        const after = this.runtime.fleet.sessions().find((s) => s.id === old);
        if (after && (after.host !== "none" || after.pid))
          throw new FleetError(
            409,
            "Previous session has not stopped; binding unchanged",
          );
        a.sessionProjects = { ...a.sessionProjects, [old]: a.repo };
        a.previous = [old, ...a.previous];
        a.session = null;
      }
      if (!p.enabled && a.session) {
        const session = this.runtime.fleet
          .sessions()
          .find((s) => s.id === a.session);
        if (session?.host !== "none" && session)
          await this.runtime.fleet.stopSession(a.session);
      }
      const { memoryPolicy, provider, ...settings } = p;
      // Only what this change decides; a picture or checkpoint saved meanwhile stays.
      const saved = this.patch(id, (x) => {
        Object.assign(x, settings, memoryPolicy ? { memoryPolicy } : {}, { session: a.session, previous: a.previous, sessionProjects: a.sessionProjects });
        if (provider === "auto") delete x.pinned;
        else x.pinned = provider;
      });
      if (!saved.enabled) await this.runtime.works.enforceAuthority();
      return saved;
    } finally {
      this.busy.delete(id);
    }
  }
  async localSend(
    id: string,
    request: string,
    body: string,
    context?: { proposal: string; run: string },
    target?: string | null,
  ) {
    if (this.busy.has(id) || this.rolling.has(id))
      throw new FleetError(409, "Another message is being delivered");
    this.busy.add(id);
    try {
      const a = this.local().find((x) => x.id === id);
      if (!a || !a.enabled) throw new FleetError(409, "Agent is paused");
      if (a.rollover) throw new FleetError(409, "This conversation is being continued in a fresh session; send again in a moment");
      // A conversation replaced from its handoff continues in its successor.
      if (target && target !== a.session && this.continues(target, a.session)) target = a.session;
      if (target && this.runtime.works.writable(id, target)) {
        if (!body.trim() || body.length > 24000) throw new FleetError(400, "Write a message up to 24000 characters");
        if (context) {
          const p=this.localProposals(id).find(p=>p.id===context.proposal && p.run_id===target);
          if (!p || context.run!==target) throw new FleetError(409,"Guidance belongs to another conversation");
          body=`[Guidance on recommendation ${p.id}]\n${body}`;
        }
        this.db.run("INSERT OR IGNORE INTO local_submissions(id,agent,session) VALUES (?,?,?)", [request,id,target]);
        const prior=this.db.query("SELECT agent,session FROM local_submissions WHERE id=?").get(request) as {agent:string;session:string};
        if(prior.agent!==id || prior.session!==target) throw new FleetError(409,"Submission belongs to another conversation");
        return this.runtime.works.guide(id,target,request,body);
      }
      if (target !== undefined && target !== a.session)
        throw new FleetError(409, "Conversation changed. Open the current session before sending.");
      if (target && (!getSessionRecord(target) || getSessionRecord(target)?.archivedAt))
        throw new FleetError(409, "This conversation is closed and read-only");
      if (!body.trim() || body.length > 24000)
        throw new FleetError(400, "Write a message up to 24000 characters");
      if (context) {
        const p = this.localProposals(id).find(
          (p) => p.id === context.proposal,
        );
        if (!p || p.run_id !== context.run || !this.continues(p.run_id, a.session))
          throw new FleetError(
            409,
            "This recommendation belongs to an earlier conversation. Review it before sending new guidance.",
          );
        body = `[Guidance on recommendation ${p.id}]\n${body}`;
      }
      const prior = this.db
        .query("SELECT agent,session FROM local_submissions WHERE id=?")
        .get(request) as { agent: string; session: string } | null;
      if (prior && (prior.agent !== id || !this.continues(prior.session, a.session)))
        throw new FleetError(409, "Submission belongs to another agent");
      // Fleet records its identity before starting tmux. No record proves a
      // previous preflight never spawned; an uncertain existing session stays.
      if (a.session && !getSessionRecord(a.session)) a.session = null;
      const fresh = !a.session && !prior;
      if (fresh) {
        // A first conversation chooses where it runs; nothing is sent when nothing can take it.
        const choice = await this.choose(a);
        if ("none" in choice) throw new FleetError(409, choice.none);
        a.provider = choice.provider;
        a.session = newSessionId();
        a.sessionProjects = { ...a.sessionProjects, [a.session]: a.repo };
        const selection = { provider: choice.provider, accountId: choice.accountId, model: choice.model, policy: choice.policy, why: choice.why, at: choice.at };
        this.patch(id, (x) => Object.assign(x, { session: a.session, sessionProjects: a.sessionProjects, provider: choice.provider, selection }));
      }
      const sid = prior?.session ?? a.session!;
      this.db.run(
        "INSERT OR IGNORE INTO local_submissions(id,agent,session) VALUES (?,?,?)",
        [request, id, sid],
      );
      const cwd = join(agentboxHome(), "agents", "local", a.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      this.sending.set(id, sid);
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
              prompt: this.opening(a, body, a.previous[0] ? { old: a.previous[0] } : null),
            });
          } else await this.runtime.fleet.send(sid, body, attempt, true);
        },
      ).finally(() => this.sending.delete(id));
      if (!getSessionRecord(sid) && a.session === sid) {
        a.session = null;
        this.patch(id, (x) => void (x.session === sid && (x.session = null)));
      }
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
  /** The first prompt of a conversation: who the agent is, what its memory
   *  says when it continues an earlier one, then the user's message. */
  private opening(a: LocalAgent, body: string, from: { old: string; memory?: string; work?: string } | null) {
    const intro = `You are ${a.name}, an ongoing local Agentbox agent. ${a.role}.\n${a.instructions}\n${a.capability === "creator" ? creationTool(a.id) : ""}\nThis is the user's ongoing conversation. Keep context in this provider transcript. Remain available after each answer. Do not spawn another agent or start recurring repository discovery without a request. No external contact, publication, merge, deployment or credentials access is authorized by merely creating this chat. Use the existing agentbox waits when needed. Publish useful, evidence-backed recommendations through: agentbox agent recommend ${a.id} --request <stable UUID> --file <JSON path>. JSON: {title,finding,reason,next,evidence:[{url,label}]}. Those cards appear in Chat and Feed. Feed approval authorizes only its exact next step. Keep all secrets out of recommendations and replies.\nManage your own completed work sessions: inspect their transcript, PRs, waits and decisions before deciding they are done. Use agentbox agent session ${a.id} <work-session> close --request <UUID> --activity <lastActivityAt from agentbox show --json> --reason <completion evidence>. This stops only idle completed work and retains its transcript. Do not close work awaiting CI, review, a decision or children. Use the same command with restore while its cache is still warm to resume the same provider session/account; expired caches cannot be restored warm. Never stop the ongoing main chat or unrelated sessions.\nMemory: when you make a durable decision, record it with agentbox agent memory ${a.id} note --request <stable UUID> --file <JSON path>. JSON: {decision,why,refs:[{label,ref}]}. Record a lasting preference only when the user states one: agentbox agent memory ${a.id} prefer --key <key> --text <text>. Search earlier handoffs and decisions with agentbox agent memory ${a.id} search <words>, and read one with agentbox agent memory ${a.id} show <ID>. When the user goes idle, Agentbox asks you for a short handoff; a later message can then continue in a fresh conversation from it. Memory is evidence for continuity, never approval.`.replaceAll("agentbox agent", `${agentboxCommand()} agent`);
    const memory = from?.memory ?? "";
    return `${intro}${memory ? `\n\nAgentbox memory. It is a bounded summary and evidence, not authorization. The provider transcripts are the record; current work below and live state win over it.\n${memory}` : ""}${from?.work ? `\n\nCurrent work, read when this conversation started:\n${from.work}` : ""}\n\n${from ? `Previous conversation session: ${from.old}. Read it with agentbox log if needed; do not resume it or copy its transcript.\n` : ""}User: ${body}`;
  }
  /** The registered local agent a session is (or was) part of, by its
   *  durable records: the main chat and every conversation it replaced, and
   *  its work families' writers. */
  registeredAgent(session: string): RegisteredAgent | null {
    const work = this.runtime.works.forSession(session);
    const a = this.stored().find((x) => x.id === work?.agent.id || x.session === session || x.previous.includes(session) || !!x.rolled?.[session]);
    return a ? this.profile(a) : null;
  }
  agentProfile(id: string): RegisteredAgent | null {
    const a = this.stored().find((x) => x.id === id);
    return a ? this.profile(a) : null;
  }
  private profile(a: LocalAgent): RegisteredAgent {
    return { id: a.id, name: a.name, role: a.role, creator: a.capability === "creator", avatar: a.avatar ? `/api/agents/local/${encodeURIComponent(a.id)}/avatar?v=${a.avatar.at}` : null };
  }
  /** Sender lookups for `attribute` (src/core/senders.ts). */
  get senders(): SenderDirectory {
    return { agentOfSession: (s) => this.registeredAgent(s), agent: (id) => this.agentProfile(id), heir: (id) => this.runtime.fleet.heir?.(id) ?? id };
  }
  /** Is a provider's CLI installed here: its cached detection; tests replace it. */
  installed = async (p: AgentProvider) => (await detectCli(p)).installed;
  /** The provider, account and model a fresh conversation of `a` starts on (`providers.ts`). */
  private async choose(a: LocalAgent) {
    const continued = !!a.session || a.previous.length > 0;
    const candidates = a.pinned ? [a.pinned] : AUTO_PROVIDERS;
    const present = new Map(await Promise.all(candidates.map(async (p) => [p, await this.installed(p).catch(() => false)] as const)));
    return chooseProvider((p) => this.runtime.fleet.placement(p), {
      pinned: a.pinned,
      previous: continued ? a.provider : null,
      installed: (p) => present.get(p) === true,
      model: (p) => getSettings().models[p] || null,
      now: Date.now(),
    });
  }
  /** The records only, without seeding templates: Fleet asks on every message. */
  private stored(): LocalAgent[] {
    return (this.db.query("SELECT body FROM local_agents").all() as { body: string }[]).map((r) => JSON.parse(r.body) as LocalAgent);
  }
  /** Read, change and write one agent in a transaction, never from a stale copy. */
  private patch(id: string, change: (a: LocalAgent) => void): LocalAgent {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT body FROM local_agents WHERE id=?").get(id) as { body: string } | null;
      if (!row) throw new FleetError(404, "Agent not found");
      const a = JSON.parse(row.body) as LocalAgent;
      change(a);
      this.put(a);
      return a;
    })();
  }
  /** Where `from` continues after its handoff rollovers. */
  private lineEnd(a: LocalAgent, from: string) {
    const seen = new Set<string>();
    let at = from;
    while (a.rolled?.[at] && !seen.has(at)) {
      seen.add(at);
      at = a.rolled[at]!;
    }
    return at;
  }
  /** `current` is `from`, or the conversation `from` was replaced by. */
  continues(from: string | null | undefined, current: string | null | undefined): boolean {
    if (!from || !current) return false;
    if (from === current) return true;
    return this.stored().some((a) => a.session === current && this.lineEnd(a, from) === current);
  }
  /** Fleet asks before resuming a session: one replaced by a successor never runs beside it. */
  replacedBy(id: string): string | null {
    for (const a of this.stored()) {
      if (a.rollover?.from === id && a.rollover.phase === "spawning") return a.rollover.to;
      if (a.rolled?.[id]) return this.lineEnd(a, id);
    }
    return null;
  }
  /**
   * Fleet's hook before a message reaches a session. For an agent's current
   * conversation that is cold (`Session.cacheWarmUntil`) or fuller than its
   * policy allows, with a handoff saved after its last real prompt and
   * nothing running that a stop would lose, start the successor with the
   * message. Otherwise the message goes to the conversation as before; a
   * missing or stale handoff never drops one.
   */
  async deliver(id: string, text: string, attempt?: () => void): Promise<boolean> {
    const a = this.stored().find((x) => x.session === id || x.rolled?.[id] || x.rollover?.from === id);
    if (!a) return false;
    if (a.rollover?.from === id)
      throw new FleetError(409, `this conversation is being continued in ${a.rollover.to}; try again in a moment`);
    if (a.session !== id) {
      if (!a.session || this.lineEnd(a, id) !== a.session) return false;
      await this.runtime.fleet.send(a.session, text, attempt, true);
      return true;
    }
    const policy = policyOf(a);
    if (!a.enabled || !policy.rollover || this.rolling.has(a.id)) return false;
    // A workspace change holds `busy`; only `localSend`'s own delivery may roll.
    if (this.busy.has(a.id) && this.sending.get(a.id) !== id) return false;
    const s = this.runtime.fleet.sessions().find((x) => x.id === id);
    if (!s || s.status === "running" || s.status === "blocked" || s.status === "closed" || s.queued.length || s.question) return false;
    const pct = s.contextUsed && s.contextLimit ? (100 * s.contextUsed) / s.contextLimit : 0;
    const cold = Date.now() > s.cacheWarmUntil;
    const why = cold ? "cold" : pct >= policy.contextPct ? "context" : null;
    if (!why) return false;
    // Only a handoff saved after the last real prompt starts a successor; a
    // stale or missing one leaves the message with this conversation.
    const handoff = await this.freshHandoff(a, id);
    if (!handoff || (await this.runtime.fleet.stopHold(id))) return false;
    this.rolling.add(a.id);
    try {
      return await this.rollover(a.id, id, handoff, why, text, attempt);
    } finally {
      this.rolling.delete(a.id);
    }
  }
  /** The handoff saved on request in `session`, when nothing real reached it since. */
  private async freshHandoff(a: LocalAgent, session: string) {
    const c = a.checkpoint;
    if (!c || c.session !== session || c.state !== "saved" || !c.handoff) return null;
    return (await this.lastPrompt(session)) === c.request ? c.handoff : null;
  }
  /**
   * The checkpoint request the conversation's newest prompt is, or null when
   * its newest prompt is real: the user's, an agent's, a wait's or a card's.
   * Keep-warm notes are skipped. Not found in the tail counts as real.
   */
  private async lastPrompt(session: string): Promise<string | null> {
    const page = await this.runtime.fleet.timeline(session, null, 80).catch(() => null);
    for (const e of [...(page?.events ?? [])].reverse()) {
      if (e.kind !== "user") continue;
      const at = e.text.indexOf(CHECKPOINT_MARK);
      if (at >= 0) return /^ ([0-9a-f-]{36})\]/.exec(e.text.slice(at + CHECKPOINT_MARK.length))?.[1] ?? null;
      if (!isKeepWarmNote(e.text)) return null;
    }
    return null;
  }
  /** What the successor must know is live: the agent's work, and what the
   *  replaced conversation holds that now passes to it. */
  private currentWork(a: LocalAgent, old: string) {
    const fleet = this.runtime.fleet;
    const lines = [
      ...this.runtime.works.list().filter((w) => w.agent.id === a.id).map((w) => `- Work ${w.id}: ${w.state}; writer session ${w.session}; branch ${w.branch}; ${w.input.issues.length} issue(s): ${w.input.issues.map((i) => i.source).join(", ")}. Read it with agentbox agent work ${w.id}.`),
      ...listOpenWaits(0).filter((w) => !w.ended && (fleet.heir?.(w.sessionId) ?? w.sessionId) === old).map((w) => `- Wait ${w.id}: ${describeWait(w.spec)}`),
      ...this.runtime.cards.list({ sessionId: old }).filter((c) => c.sessionId === old && (c.state === "open" || c.state === "later")).map((c) => `- Review card ${c.id} (${c.kind}): ${c.title}`),
      ...(unfinishedClaims().get(old) ?? []).map((pr) => `- PR ${pr}, claimed`),
      ...(fleet.startedBy?.(old) ?? []).map((id) => `- Session ${id}, started earlier and still yours`),
    ];
    return lines.slice(0, 30).map((l) => safeText(l).slice(0, 300)).join("\n").replaceAll("agentbox agent", `${agentboxCommand()} agent`);
  }
  /**
   * Replace `old` with a successor started from `handoff` and `text`. Each
   * step is journaled first. The old process is stopped and proven gone
   * before the successor starts; succession (waits, agent messages), Review
   * cards and PR claims move only once the successor has started.
   */
  private async rollover(agent: string, old: string, handoff: string, why: "cold" | "context", text: string, attempt?: () => void) {
    const fleet = this.runtime.fleet, to = newSessionId();
    // Where the successor runs is chosen before anything is stopped; nothing
    // available leaves the message to the old conversation.
    const choice = await this.choose(this.stored().find((x) => x.id === agent)!);
    if ("none" in choice) {
      console.error(`agentbox: ${agent}: not continuing ${old} in a fresh conversation: ${choice.none}`);
      return false;
    }
    // Journaled before anything is stopped: provider, account, model and why.
    const selection = { provider: choice.provider, accountId: choice.accountId, model: choice.model, policy: choice.policy, why: choice.why, at: choice.at };
    this.patch(agent, (a) => void (a.rollover = { from: old, to, handoff, why, at: Date.now(), phase: "stopping", provider: choice.provider, selection }));
    const live = () => fleet.sessions().find((s) => s.id === old);
    const before = live();
    if (before && (before.host !== "none" || before.pid)) {
      await fleet.stopSession(old);
      await fleet.tick();
    }
    const after = live();
    if (after && (after.host !== "none" || after.pid)) {
      this.patch(agent, (a) => void delete a.rollover);
      return false;
    }
    const work = this.currentWork(this.stored().find((x) => x.id === agent)!, old);
    const boot = this.memory.bootstrap(agent, handoff, text);
    const a = this.patch(agent, (a) => {
      a.rollover!.phase = "spawning";
      a.rollover!.supplied = boot.supplied;
      a.sessionProjects = { ...a.sessionProjects, [to]: a.repo };
      a.previous = [old, ...a.previous.filter((x) => x !== old)];
      a.session = to;
    });
    const rec = getSessionRecord(old), fallback = join(agentboxHome(), "agents", "local", a.id);
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    attempt?.();
    let failure: string | null = null;
    try {
      await fleet.spawn({
        id: to,
        provider: choice.provider,
        accountId: choice.accountId,
        ...(choice.model ? { model: choice.model } : {}),
        // Continue in the replaced conversation's worktree when it is still there.
        ...(rec?.cwd && existsSync(rec.cwd) ? { cwd: rec.cwd } : { repoId: a.repo ?? undefined, cwd: fallback, worktree: !!a.repo }),
        prompt: this.opening(a, text, { old, memory: boot.text, work }),
      });
    } catch (e) {
      failure = (e as Error).message;
    }
    // Proven only once its transcript exists: the CLI took the first prompt.
    if (!failure && !(await this.proveStarted(to))) failure = "it never wrote its transcript";
    if (failure) {
      const undone = await this.undoSuccessor(agent, to, `the fresh conversation could not start: ${failure}`);
      if (undone === "undone") return false;
      if (undone === "stuck")
        // Its process could not be proven gone: neither conversation gets the message twice.
        throw new FleetError(409, `the fresh conversation ${to} could not be proven started or stopped; check it before sending again`);
      return true;
    }
    await this.completeRollover(agent);
    console.log(`agentbox: ${agent} continues ${old} in ${to} on ${choice.provider} (${choice.accountId}) from handoff ${handoff} (${why}): ${choice.why}`);
    return true;
  }
  /** The CLI has written the successor's transcript: it has the first prompt. */
  private started(id: string) {
    const rec = getSessionRecord(id);
    return !!rec?.transcriptPath && existsSync(transcriptFile(rec.transcriptPath));
  }
  /** How long a successor has to write its transcript. */
  proofMs = 60_000;
  private async proveStarted(id: string) {
    const fleet = this.runtime.fleet, from = Date.now(), grace = this.proofMs / 9;
    for (;;) {
      await fleet.tick();
      if (this.started(id)) return true;
      const v = fleet.sessions().find((s) => s.id === id), waited = Date.now() - from;
      // Never got a pane, or its process exited before writing anything.
      if (waited > grace && (getSessionRecord(id)?.tmux === null || (v && v.host === "none" && !v.pid))) return false;
      if (waited >= this.proofMs) return false;
      await Bun.sleep(Math.min(1_000, grace / 4));
    }
  }
  /** Stop a successor that never proved itself and make the replaced
   *  conversation current again: "undone"; "completed" when it wrote its
   *  transcript after all (it has the message); "stuck" when it will not stop. */
  private async undoSuccessor(agent: string, to: string, error: string): Promise<"undone" | "completed" | "stuck"> {
    const fleet = this.runtime.fleet;
    if (getSessionRecord(to)) {
      await fleet.tick();
      if (!this.started(to)) {
        const v = fleet.sessions().find((s) => s.id === to);
        if (v && (v.host !== "none" || v.pid)) await fleet.stopSession(to).catch(() => undefined);
        // Two fresh passes: one may have begun before a late transcript was written.
        await fleet.tick();
        await fleet.tick();
        const after = fleet.sessions().find((s) => s.id === to);
        if (after && (after.host !== "none" || after.pid)) return "stuck";
      }
      if (this.started(to)) {
        this.unstop(to);
        await this.completeRollover(agent);
        return "completed";
      }
      // Off the board: it never had a conversation.
      await fleet.close(to, true, true).catch(() => undefined);
    }
    this.revert(agent, error);
    return "undone";
  }
  private async completeRollover(agent: string) {
    const r = this.stored().find((x) => x.id === agent)?.rollover;
    if (!r || r.phase !== "spawning") return;
    await this.runtime.fleet.handOver(r.from, r.to);
    moveCards(r.from, r.to);
    movePrClaims(r.from, r.to);
    this.memory.used(r.handoff, r.to);
    this.patch(agent, (a) => {
      if (r.provider) Object.assign(a, { provider: r.provider, selection: r.selection });
      a.rolled = { ...a.rolled, [r.from]: r.to };
      a.contexts = { ...a.contexts, [r.to]: r.supplied ?? [] };
      delete a.rollover;
      delete a.checkpoint;
    });
    // Off the board, alone: what it started now belongs to the successor.
    await this.runtime.fleet.close(r.from, true, true).catch(() => undefined);
  }
  /** The successor never started: the replaced conversation stays current,
   *  parked rather than stopped by hand, so the next message resumes it. */
  private revert(agent: string, error: string) {
    this.patch(agent, (a) => {
      const r = a.rollover;
      if (!r) return;
      this.unstop(r.from);
      a.session = r.from;
      a.previous = a.previous.filter((x) => x !== r.from && x !== r.to);
      delete a.rollover;
      if (a.checkpoint?.session === r.from) Object.assign(a.checkpoint, { state: "failed", error });
    });
    console.error(`agentbox: ${agent}: ${error}; the previous conversation stays current`);
  }
  private unstop(id: string) {
    const rec = getSessionRecord(id);
    if (rec && !rec.parkedAt && !rec.archivedAt && this.runtime.fleet.sessions().find((s) => s.id === id)?.host === "none")
      updateSessionRecord(id, { parkedAt: Date.now() });
  }
  /** Finish or undo a replacement a restart interrupted, and ask idle
   *  conversations for their handoff while they are still warm. */
  private async remember() {
    const now = Date.now(), keepers: Keeper[] = [];
    for (const a of this.stored()) {
      if (this.busy.has(a.id) || this.rolling.has(a.id)) continue;
      const r = a.rollover;
      if (r) {
        try {
          if (r.phase === "stopping") {
            this.unstop(r.from);
            this.patch(a.id, (x) => void delete x.rollover);
          } else if (this.started(r.to)) await this.completeRollover(a.id);
          else if (now - r.at > (getSessionRecord(r.to) ? 5 * 60_000 : 60_000)) await this.undoSuccessor(a.id, r.to, "the fresh conversation never started");
        } catch (e) {
          console.error(`agentbox: ${a.id}: finishing its conversation rollover:`, e);
        }
        continue;
      }
      if (a.enabled && a.session && policyOf(a).rollover)
        keepers.push({
          target: a.id,
          session: a.session,
          policy: policyOf(a),
          checkpoint: a.checkpoint,
          update: (change) => this.patch(a.id, (x) => void (x.checkpoint = change(x.checkpoint))),
        });
    }
    keepers.push(...this.runtime.coordinators());
    for (const k of keepers) {
      try {
        await this.checkpointIfDue(k, now);
      } catch (e) {
        console.error(`agentbox: ${k.target}: memory checkpoint:`, e);
      }
    }
    for (const id of this.looked.keys()) if (!keepers.some((k) => k.session === id)) this.looked.delete(id);
  }
  /**
   * Ask for a handoff once the user has been away `idleMin` (or the
   * conversation is past `contextPct`) while at least `CHECKPOINT_WARM_MS`
   * of its cache's life is left. The request and its reply refresh the
   * cache, so it is asked again only after something real reached it.
   */
  private async checkpointIfDue(k: Keeper, now: number) {
    const s = this.runtime.fleet.sessions().find((x) => x.id === k.session);
    if (!s || s.host !== "tmux") return;
    const c = k.checkpoint?.session === s.id ? k.checkpoint : undefined;
    if (c?.state === "requested") {
      if (now - c.at > CHECKPOINT_WAIT_MS && s.status === "waiting")
        k.update((x) => (x?.request === c.request && x.state === "requested" ? { ...x, state: "failed", error: "No handoff was saved" } : x));
      return;
    }
    // The cache's own lifetime sets the window: an hour-long cache is asked
    // after `idleMin`; a five-minute one about halfway, leaving time to write.
    const lifetime = Math.max(0, s.cacheWarmUntil - s.lastActivityAt);
    const lead = Math.min(CHECKPOINT_WARM_MS, lifetime / 2.5);
    if (s.status !== "waiting" || s.queued.length || s.question || s.limitHit || s.cacheWarmUntil - now < lead) return;
    const idleDue = Math.min(k.policy.idleMin * 60_000, Math.max(30_000, lifetime - lead - 30_000));
    const idle = now - s.lastActivityAt, pct = s.contextUsed && s.contextLimit ? Math.round((100 * s.contextUsed) / s.contextLimit) : 0;
    const reason = idle >= idleDue ? "idle" : pct >= k.policy.contextPct && idle >= Math.min(2 * 60_000, idleDue) && (!c || pct - c.pct >= 5) ? "context" : null;
    if (!reason || this.looked.get(s.id) === s.lastActivityAt) return;
    this.looked.set(s.id, s.lastActivityAt);
    if (c && (await this.lastPrompt(s.id)) === c.request) return;
    const request = crypto.randomUUID();
    k.update(() => ({ session: s.id, request, at: now, reason, pct, state: "requested" }));
    const command = `${agentboxCommand()} agent memory ${k.target} handoff --request ${request} --file <that file>`;
    const note = `${CHECKPOINT_MARK} ${request}] ${reason === "idle" ? `The user has been away for ${Math.round(idle / 60_000)} minutes.` : `This conversation is ${pct}% full.`} Save a handoff now, so that a fresh conversation can continue from it later. Write a JSON file {"intent":"what the user wants overall","decisions":[{"decision":"…","why":"…"}],"open":["questions still unanswered"],"commitments":["what you said you will do or follow"],"refs":[{"label":"…","ref":"a PR or issue URL, a work, wait or card ID, a file path or a session ID"}]} of at most 500 words. Put in only what a successor needs that the work records do not already say, and no secrets. Then run: ${command}\nReply with one short line and do nothing else. This is not a new task.`;
    try {
      await this.runtime.fleet.send(s.id, note);
      console.log(`agentbox: asked ${s.id} (${k.target}) for a handoff (${reason})`);
    } catch (e) {
      k.update((x) => (x?.request === request ? { ...x, state: "failed", error: (e as Error).message } : x));
    }
  }
  /** Scope rules: a local agent's records are its own; only its current
   *  conversation (or the local operator, with no session) reads and writes them. */
  private memoryAgent(agent: string, caller: string | null, write: boolean) {
    const a = this.stored().find((x) => x.id === agent);
    if (!a) throw new FleetError(404, "Agent not found");
    if (caller ? caller !== a.session : write) throw new FleetError(403, "Only this agent's current conversation can use its memory");
    return a;
  }
  memoryView(agent: string, caller: string | null, query = "") {
    const a = this.memoryAgent(agent, caller, false), m = this.memory;
    return {
      policy: policyOf(a),
      checkpoint: a.checkpoint ?? null,
      preferences: m.preferences(a.id),
      handoffs: m.recent(a.id, "handoff", 20),
      notes: m.recent(a.id, "note", 20),
      results: query.trim() ? m.search(a.id, query) : [],
    };
  }
  memoryRecord(agent: string, caller: string | null, id: string) {
    return this.memory.get(this.memoryAgent(agent, caller, false).id, id);
  }
  saveHandoff(agent: string, caller: string | null, request: string, input: unknown) {
    const a = this.memoryAgent(agent, caller, true);
    const asked = a.checkpoint?.session === caller && a.checkpoint.request === request;
    const rec = this.memory.handoff(a.id, request, caller!, input, asked ? request : null);
    if (asked)
      this.patch(a.id, (x) => {
        if (x.checkpoint?.request === request) Object.assign(x.checkpoint, { state: "saved", handoff: rec.id, error: undefined });
      });
    return rec;
  }
  saveNote(agent: string, caller: string | null, request: string, input: unknown) {
    return this.memory.note(this.memoryAgent(agent, caller, true).id, request, caller!, input);
  }
  prefer(agent: string, caller: string | null, input: unknown) {
    const a = this.stored().find((x) => x.id === agent);
    if (!a) throw new FleetError(404, "Agent not found");
    if (caller && caller !== a.session) throw new FleetError(403, "Only this agent's current conversation can record its preferences");
    return this.memory.prefer(a.id, caller, input);
  }
  /** The human operator's choice: a provider session cannot change it. */
  setAvatar(id: string, caller: string | null, bytes: Uint8Array, mime: string) {
    if (caller) throw new FleetError(403, "Only the operator can change an agent's picture");
    if (!this.stored().some((a) => a.id === id)) throw new FleetError(404, "Agent not found");
    const file = saveAvatar(bytes, mime);
    let old: string | undefined;
    const a = this.patch(id, (x) => {
      old = x.avatar?.file;
      x.avatar = { file, at: Date.now() };
    });
    removeAvatar(old);
    return a.avatar!;
  }
  clearAvatar(id: string, caller: string | null) {
    if (caller) throw new FleetError(403, "Only the operator can change an agent's picture");
    let old: string | undefined;
    this.patch(id, (x) => {
      old = x.avatar?.file;
      delete x.avatar;
    });
    removeAvatar(old);
    return null;
  }
  avatar(id: string) {
    const name = this.stored().find((a) => a.id === id)?.avatar?.file;
    return name ? avatarFile(name) : null;
  }
  localReceipt(id: string, request: string) {
    const a = this.local().find((x) => x.id === id),
      prior = this.db
        .query("SELECT session FROM local_submissions WHERE id=? AND agent=?")
        .get(request, id) as { session: string } | null,
      sid = prior?.session ?? a?.session,
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
      .map((p) => this.reconcileLocalDecision(p))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  private reconcileLocalDecision(p: Proposal): Proposal {
    if (p.delivery?.state === "queued" && !this.busy.has(p.agent_id)) {
      const receipt = this.localReceipt(p.agent_id, p.delivery.request);
      p.delivery = {
        ...p.delivery,
        state:
          (receipt?.state as "sent" | "refused" | "uncertain") || "uncertain",
        result:
          receipt?.result ||
          "Decision recorded; delivery not confirmed. It will not be replayed.",
      };
      this.db.run("UPDATE local_proposals SET body=? WHERE id=?", [
        JSON.stringify(p),
        p.id,
      ]);
    }
    return p;
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
      if (!session || (a.session !== session && !this.runtime.works.writable(a.id,session)))
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
    const proposal = await this.runtime.api().installation.agentCall(
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
    if (!["approved", "dismissed"].includes(decision))
      throw new FleetError(400, "Invalid decision");
    let fresh = false;
    const p = this.db.transaction(() => {
      const row = this.db
        .query("SELECT body FROM local_proposals WHERE id=?")
        .get(id) as { body: string } | null;
      const p = row ? (JSON.parse(row.body) as Proposal) : null;
      if (!p || p.agent_id !== agent)
        throw new FleetError(404, "Recommendation not found");
      if (p.state === decision) return p;
      if (p.state !== "open") throw new FleetError(409, "Already decided");
      const a = this.local().find((x) => x.id === agent);
      if (!a?.enabled)
        throw new FleetError(409, "Agent unavailable");
      if (decision === "approved" && !this.continues(p.run_id, a.session) && !this.runtime.works.writable(agent,p.run_id))
        throw new FleetError(
          409,
          "Recommendation belongs to an earlier conversation; ask the agent to review it in the current workspace",
        );
      p.state = decision as "approved" | "dismissed";
      if (decision === "approved")
        p.delivery = { request, state: "queued", result: "" };
      this.db.run("UPDATE local_proposals SET body=? WHERE id=?", [
        JSON.stringify(p),
        id,
      ]);
      fresh = true;
      return p;
    })();
    if (fresh && decision === "approved") {
      try {
        const r = await this.localSend(
          agent,
          p.delivery!.request,
          `Approved recommendation ${id}: ${p.next_step}. Only this next step is authorized; other actions and outreach keep their existing requirements.`,
          { proposal: p.id, run: p.run_id },
          p.run_id,
        );
        p.delivery = {
          request: p.delivery!.request,
          state: r.state as "sent" | "refused" | "uncertain",
          result: r.result,
        };
      } catch (e) {
        p.delivery = {
          request: p.delivery!.request,
          state: e instanceof FleetError ? "refused" : "uncertain",
          result: (e as Error).message,
        };
      }
      this.db.run("UPDATE local_proposals SET body=? WHERE id=?", [
        JSON.stringify(p),
        id,
      ]);
    } else this.reconcileLocalDecision(p);
    const card = this.runtime.cards
      .list()
      .find((c) => c.key === `agent-proposal:${id}`);
    if (
      card?.state === "open" &&
      (decision === "dismissed" || p.delivery?.state === "sent")
    )
      this.runtime.cards.close(
        card.id,
        decision === "dismissed"
          ? "Dismissed in Feed"
          : "Approved in Feed and delivered",
      );
    return p;
  }
  /** Only the recorded agent links authorize a read; a Fleet ID or cwd does not. */
  async sessionAction(agent: string, session: string, caller: string | null, input: unknown) {
    const p = z.object({ request: z.string().uuid(), action: z.enum(["close", "restore"]), activity: z.number().finite(), reason: z.string().trim().min(1).max(1000) }).strict().parse(input);
    const authorize = () => {
      const a = this.local().find((a) => a.id === agent), w = this.runtime.works.forSession(session);
      const worker = w?.agent.id === agent && w.session === session;
      if (!a || (!worker && a.session !== session)) throw new FleetError(403, "This is not the agent's current chat or work session");
      if (caller && caller !== a.session && (!worker || caller !== w!.session)) throw new FleetError(403, "Only this agent's current coordinator or work owner may manage this session");
      if (p.action === "close") {
        if (!worker) throw new FleetError(409, "Keep the main chat available; close completed work sessions instead");
        if (this.runtime.cards.list().some((c) => c.kind === "decision" && (c.state === "open" || c.state === "later") && (c.sessionId === session || c.about === session)))
          throw new FleetError(409, "This session is still waiting on a decision");
      } else if (!a.enabled || (worker && !this.runtime.works.restorable(agent, session))) {
        throw new FleetError(403, "This session's work authority has expired or cannot be restored");
      }
    };
    authorize();
    const db = this.db;
    db.exec("CREATE TABLE IF NOT EXISTS agent_session_actions(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL)");
    const fingerprint = JSON.stringify({ agent, session, ...p });
    const old = db.query("SELECT fingerprint,state,result FROM agent_session_actions WHERE id=?").get(p.request) as {fingerprint:string;state:string;result:string}|null;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new FleetError(409, "Request already names another session action");
      return {state:old.state === "attempting" ? "uncertain" : old.state, result:old.result};
    }
    if (this.sessionActions.has(session)) throw new FleetError(409, "Another session action is in progress");
    this.sessionActions.add(session);
    db.run("INSERT INTO agent_session_actions VALUES (?,?,?,?)", [p.request, fingerprint, "attempting", "Action not confirmed; inspect the session before another attempt"]);
    try {
      if (p.action === "close") await this.runtime.fleet.closeIfIdle(session, p.activity, authorize);
      else await this.runtime.fleet.resumeCached(session, authorize);
      const result = p.action === "close" ? "Closed; transcript and cache metadata retained" : "Restored on the existing session and account";
      db.run("UPDATE agent_session_actions SET state='done',result=? WHERE id=?", [result,p.request]);
      return {state:"done",result};
    } catch (e) {
      const result = (e as Error).message;
      db.run("UPDATE agent_session_actions SET state='uncertain',result=? WHERE id=?", [result,p.request]);
      throw e;
    } finally { this.sessionActions.delete(session); }
  }

  threads(agent: string): AgentThread[] {
    const local = this.local().find((x) => x.id === agent);
    const linked: { id: string; run: string; kind: "conversation" | "work"; current: boolean; successor: string | null }[] = [];
    if (local) {
      for (const id of [local.session, ...local.previous].filter((x): x is string => !!x))
        linked.push({ id, run: id, kind: "conversation", current: local.enabled && id === local.session, successor: id !== local.session ? local.session : null });
    } else {
      for (const r of this.runtime.store.runs().filter((x) => x.run.agent_id === agent)) {
        const rows = this.runtime.store.db.query("SELECT id FROM sessions WHERE run=? ORDER BY rowid DESC").all(r.run.id) as { id: string }[];
        for (const { id } of rows) linked.push({ id, run: r.run.id, kind: r.coordinator ? "conversation" : "work",
          current: id === r.session && r.phase === "attached" && ["running", "waiting"].includes(r.run.state),
          successor: id !== r.session ? r.session : null });
      }
    }
    for(const w of this.runtime.works.list().filter(w=>w.agent.id===agent)) {
      linked.push({id:w.session,run:w.session,kind:"work",current:this.runtime.works.writable(agent,w.session),successor:null});
    }
    if (local) {
      // Persisted parents also link ordinary detached child sessions. Listing
      // them grants transcript reads only; send/close/restore keep their gates.
      const owner = this.runtime.sessionOwnership(), known = new Set(linked.map((s) => s.id));
      for (const record of listSessionRecords()) {
        if (record.parent && !known.has(record.id) && owner(record.id) === agent)
          linked.push({id:record.id,run:record.id,kind:"work",current:false,successor:null});
      }
    }
    const live = new Map(this.runtime.fleet.sessions().map((s) => [s.id, s]));
    return [...new Map(linked.map((x) => [x.id, x])).values()].map((x) => {
      const s = live.get(x.id), record = getSessionRecord(x.id), facts = record?.facts as { title?: string } | null;
      const status = record?.archivedAt ? "closed" : s?.status ?? "stopped";
      const at = s?.lastActivityAt ?? record?.lastActivityAt ?? 0;
      return { id: x.id, run: x.run, kind: x.kind, title: safeText(s?.label || s?.title || record?.label || facts?.title || "Conversation").slice(0, 200),
        cacheWarmUntil: s?.cacheWarmUntil,
        canRestore: !!local && s?.host === "none" && Date.now() < s.cacheWarmUntil &&
          (x.kind === "work" ? this.runtime.works.restorable(agent, x.id) : local.enabled && local.session === x.id),
        status, at, active: status !== "closed" && (status === "running" || Date.now() - at < 3 * 60 * 60_000),
        writable: x.current && status !== "closed", successor: x.successor };
    }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }
  async page(agent: string, input: unknown): Promise<ConversationPage> {
    const cursor = ReadCursor.parse(input), threads = this.threads(agent), local = this.stored().find((a) => a.id === agent);
    const thread = cursor.target ? threads.find((t) => t.id === cursor.target) : threads[cursor.session];
    if (cursor.target && !thread) throw new FleetError(403, "Session does not belong to this agent");
    if (cursor.list) {
      const offset = cursor.offset ?? 0;
      return { events: [], next: null, session: null, status: "idle", threads: threads.slice(offset, offset + 200),
        counts: { active: threads.filter((t) => t.active).length, inactive: threads.filter((t) => !t.active).length },
        more: offset + 200 < threads.length ? offset + 200 : null };
    }
    if (!thread) return { events: [], next: null, session: null, status: "idle" };
    // Only the conversations whose handoffs this one started from, newest first.
    const sources = [...new Map((local?.contexts?.[thread.id] ?? []).sort((a, b) => b.at - a.at).map((x) => [x.session, x])).values()];
    const after = (session: string | null) => {
      const at = session ? sources.findIndex((x) => x.session === session) + 1 : 0;
      return sources[at] ? { session: 0, target: thread.id, history: sources[at]!.session, before: null } : null;
    };
    if (cursor.history !== undefined && !sources.some((x) => x.session === cursor.history))
      throw new FleetError(403, "That conversation was not carried into this one");
    const id = cursor.history ?? thread.id, source = sources.find((x) => x.session === cursor.history);
    const rail = { threads: threads.slice(0, 200), counts: { active: threads.filter((t) => t.active).length, inactive: threads.filter((t) => !t.active).length }, more: threads.length > 200 ? 200 : null };
    try {
      const page = await this.runtime.fleet.timeline(id, cursor.before, 60);
      const events = page.events
        .filter((e) => SAFE_EVENT.has(e.kind))
        .filter((e) => !(e.kind === "user" && "text" in e && String(e.text).includes(CHECKPOINT_MARK)))
        .filter(
          (e) =>
            !(
              e.kind === "user" &&
              "text" in e &&
              /^You are [^\n]+, a shared Agentbox agent\. Run [a-f0-9-]{36}; work /.test(
                String(e.text),
              )
            ),
        )
        .map((e) => ({
          ...e,
          text: safeText(
            ("text" in e ? String(e.text) : "").replace(
              /^You are [\s\S]*?\n\n(?:Previous conversation session:[^\n]*\n)?User: /,
              "",
            ),
          ).slice(0, 10000),
        })) as TimelineEvent[];
      const carried = source && { handoff: source.handoff, at: source.at, oldest: source === sources.at(-1) };
      // Senders by the server's records; a shared reader sees no local identities.
      const attributed = attribute(id, events, this.senders, !local);
      return {
        ...rail,
        events: carried ? attributed.map((e) => ({ ...e, id: `${id}:${e.id}`, source: id, carried })) : attributed,
        next: page.before ? { session: 0, target: thread.id, ...(source ? { history: id } : {}), before: page.before } : after(source ? id : null),
        session: thread.id,
        thread,
        status: thread.status,
      };
    } catch (e) {
      // An earlier conversation that cannot be read is said, and retried; the current one is not affected.
      return { ...rail, events: [], next: source ? cursor : null, session: thread.id, thread, status: thread.status, error: source ? `Could not read the summarized conversation ${id}: ${(e as Error).message}` : (e as Error).message };
    }
  }

  async tick() {
    if (!this.remembering) {
      this.remembering = true;
      void this.remember()
        .catch((e) => console.error("agentbox: agent memory:", e))
        .finally(() => (this.remembering = false));
    }
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.transportTick();
    } finally {
      this.ticking = false;
    }
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
        const page = await this.page(q.agent_id, q.cursor).catch((e): ConversationPage => ({ events: [], next: null, session: null, status: "unavailable", error: (e as Error).message })),
          sealed = await sealPage(identity.pair, q.client_key, q.id, page);
        const channel = api.sb.channel(`agent-read:${q.id}`, {
          config: { broadcast: { ack: true } },
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Realtime subscription timed out")),
              8000,
            );
            channel.subscribe((status, error) => {
              if (status === "SUBSCRIBED") {
                clearTimeout(timeout);
                resolve();
              } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                clearTimeout(timeout);
                reject(error ?? new Error(status));
              }
            });
          });
          for (let index = 0; index < sealed.chunks.length; index++) {
            await api.agentCall(
              "inst_agent_read_offer",
              { p_id: q.id, p_key: identity.key },
              z.unknown(),
            );
            const result = await channel.send({
              type: "broadcast",
              event: "page",
              payload: {
                index,
                total: sealed.chunks.length,
                iv: sealed.iv,
                data: sealed.chunks[index],
              },
            });
            if (result !== "ok")
              throw new Error(`Realtime read relay unavailable (${result})`);
          }
        } finally {
          await api.sb.removeChannel(channel);
        }
      } catch (e) {
        this.runtime.lastError = `Conversation relay: ${(e as Error).message}`;
        /* No plaintext error/response on an unauthenticated broadcast. Request expires. */
      }
    }
  }
}
