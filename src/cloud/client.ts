/** Typed clients of the agentbox cloud service (docs/cloud.md), over
 *  supabase-js. Two of them, for the two kinds of caller:
 *
 *  - `HumanCloud`: a person signed in with Supabase Auth, in a browser or for
 *    the span of `agentbox cloud login`. Reads go through RLS; changes that
 *    need checks RLS cannot state are RPCs.
 *  - `InstallationCloud`: one machine's agentbox server, holding its own
 *    installation secret and no human session. Every call is an `inst_*` RPC
 *    that re-checks revocation, membership and scope.
 *
 *  Both use only the publishable key. A secret (service-role) key is refused
 *  here: it bypasses RLS, and nothing a person or a machine runs may hold it.
 *  Independent of React and of the local fleet; every answer is parsed with
 *  the protocol's schemas. */

import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import { z } from "zod";
import {
  AcceptedInvite,
  AgentIdentity,
  CreatedInvite,
  DeliveryGrant,
  Directory,
  Hello,
  InboundMessage,
  Installation,
  Invite,
  Me,
  Member,
  MessageReceipt,
  Person,
  Plan,
  PlanRevision,
  PlanWithRevision,
  PublishedPlan,
  PublishedSkill,
  RegisteredInstallation,
  SendResult,
  Skill,
  SkillRevision,
  SkillWithRevision,
  UserSettings,
  Workspace,
  WorkspacePolicy,
  INSTALLATION_SECRET_RE,
  type DeliveryOutcome,
  type FrontendPrefs,
  type PersonalDefaults,
  type ProviderConnection,
  type Scope,
  type SkillFileInput,
  type WorkspacePolicyPatch,
  ProviderConnection as ProviderConnectionSchema,
} from "./protocol";
import { CloudError, checkConfig, type CloudConfig } from "./config";

export { CloudError, checkConfig, isSecretKey, type CloudConfig } from "./config";

export interface ClientOptions {
  /** Keep the human's session (a browser): where, and under which key. */
  storage?: SupportedStorage;
  storageKey?: string;
  persistSession?: boolean;
  /** Read a magic link's code from the page's URL (the browser). */
  detectSessionInUrl?: boolean;
  /** Give up on a request after this long (20s): a network that takes the
   *  connection and never answers must not hold a caller forever. */
  timeoutMs?: number;
}

function timedFetch(ms: number): typeof fetch {
  const f = (input: RequestInfo | URL, init?: RequestInit) => {
    const timer = AbortSignal.timeout(ms);
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timer]) : timer });
  };
  return f as typeof fetch;
}

export function supabaseFor(cfg: CloudConfig, opts: ClientOptions = {}): SupabaseClient {
  const c = checkConfig(cfg);
  const persist = opts.persistSession ?? false;
  return createClient(c.url, c.publishableKey, {
    auth: {
      persistSession: persist,
      autoRefreshToken: persist,
      detectSessionInUrl: opts.detectSessionInUrl ?? false,
      flowType: "pkce",
      storage: opts.storage,
      storageKey: opts.storageKey,
    },
    global: { headers: { "x-agentbox-cloud-protocol": "1" }, fetch: timedFetch(opts.timeoutMs ?? 20_000) },
  });
}

type Raw = { data: unknown; error: { message: string; code?: string; details?: string | null; hint?: string | null } | null; status?: number };

function statusOf(r: Raw): number {
  const code = r.error?.code ?? "";
  const pt = /^PT(\d{3})$/.exec(code);
  if (pt) return Number(pt[1]);
  if (code === "42501") return 403;
  if (code === "23505") return 409;
  if (code === "22P02" || code === "23514" || code === "22023") return 400;
  if (r.status && r.status >= 400) return r.status;
  // supabase-js reports a failed fetch with no status.
  return r.error && /fetch|network|ECONNREFUSED|timed? ?out|abort/i.test(r.error.message) ? 0 : 500;
}

function unwrap<T>(schema: z.ZodType<T>, r: Raw): T {
  if (r.error) {
    const status = statusOf(r);
    throw new CloudError(status === 0 ? `could not reach the cloud (${r.error.message})` : r.error.message, status, r.error.code ?? null);
  }
  const parsed = schema.safeParse(r.data);
  if (!parsed.success) {
    throw new CloudError(`the cloud answered in a shape this agentbox does not read (${parsed.error.issues[0]?.message ?? "invalid"}): is it on another protocol?`, 502);
  }
  return parsed.data;
}

async function call<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  let r: Raw;
  try {
    r = (await sb.rpc(fn, args)) as Raw;
  } catch (e) {
    throw new CloudError(`could not reach the cloud: ${(e as Error).message}`, 0);
  }
  return unwrap(schema, r);
}

async function select<T>(q: PromiseLike<unknown>, schema: z.ZodType<T>): Promise<T> {
  let r: Raw;
  try {
    r = (await q) as Raw;
  } catch (e) {
    throw new CloudError(`could not reach the cloud: ${(e as Error).message}`, 0);
  }
  return unwrap(schema, r);
}

// ------------------------------------------------------------------ human

export class HumanCloud {
  constructor(readonly sb: SupabaseClient) {}

  /** Email a sign-in: a six-digit code and a link (`redirectTo` must be in
   *  the project's allowed redirect URLs). New addresses get an account. */
  async sendCode(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirectTo } });
    if (error) throw new CloudError(error.message, error.status ?? 400, error.code ?? null);
  }

  async verifyCode(email: string, code: string): Promise<Me> {
    const { error } = await this.sb.auth.verifyOtp({ email, token: code.trim(), type: "email" });
    if (error) throw new CloudError(error.message, error.status ?? 400, error.code ?? null);
    return this.me();
  }

  /** Who is signed in, from the session the client holds; null for nobody. */
  async userId(): Promise<string | null> {
    const { data } = await this.sb.auth.getSession();
    return data.session?.user.id ?? null;
  }

  async signOut(): Promise<void> {
    await this.sb.auth.signOut({ scope: "local" });
  }

  me(): Promise<Me> {
    return call(this.sb, "cloud_me", {}, Me);
  }

  async setDisplayName(name: string): Promise<void> {
    const uid = await this.mustUser();
    await select(this.sb.from("profiles").update({ display_name: name.slice(0, 80) }).eq("user_id", uid).select("user_id"), z.array(z.unknown()));
  }

  async settings(): Promise<UserSettings> {
    await this.me(); // creates the row on first sign-in
    const uid = await this.mustUser();
    return select(this.sb.from("user_settings").select("*").eq("user_id", uid).single(), UserSettings);
  }

  async saveDefaults(defaults: PersonalDefaults): Promise<UserSettings> {
    const uid = await this.mustUser();
    return select(this.sb.from("user_settings").update({ defaults }).eq("user_id", uid).select("*").single(), UserSettings);
  }

  /** Replace one frontend's namespace, leaving every other frontend's alone.
   *  Read, change, write only if nothing else wrote meanwhile; one retry. */
  async saveFrontend(namespace: string, value: Record<string, unknown>): Promise<UserSettings> {
    const uid = await this.mustUser();
    for (let tries = 0; ; tries++) {
      const cur = await this.settings();
      const frontend: FrontendPrefs = { ...cur.frontend, [namespace]: value };
      const rows = await select(
        this.sb.from("user_settings").update({ frontend }).eq("user_id", uid).eq("updated_at", cur.updated_at).select("*"),
        z.array(UserSettings),
      );
      if (rows[0]) return rows[0];
      if (tries >= 1) throw new CloudError("your settings changed elsewhere at the same moment: try again", 409);
    }
  }

  // ---- workspaces

  createWorkspace(name: string, slug: string): Promise<Workspace> {
    return call(this.sb, "create_workspace", { p_name: name, p_slug: slug }, Workspace);
  }

  async members(workspaceId: string): Promise<(Member & { person: Person })[]> {
    const rows = await select(this.sb.from("workspace_members").select("*").eq("workspace_id", workspaceId).order("joined_at"), z.array(Member));
    const people = await select(
      this.sb.from("profiles").select("user_id, email, display_name").in("user_id", rows.map((r) => r.user_id)),
      z.array(Person),
    );
    const byId = new Map(people.map((p) => [p.user_id, p]));
    return rows.map((r) => ({ ...r, person: byId.get(r.user_id) ?? { user_id: r.user_id, email: "", display_name: "" } }));
  }

  invites(workspaceId: string): Promise<Invite[]> {
    return select(this.sb.from("workspace_invites").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }), z.array(Invite));
  }

  createInvite(workspaceId: string, opts: { role?: "admin" | "member"; email?: string | null; ttlHours?: number; maxUses?: number } = {}) {
    return call(
      this.sb,
      "create_invite",
      { p_workspace: workspaceId, p_role: opts.role ?? "member", p_email: opts.email || null, p_ttl_hours: opts.ttlHours ?? 72, p_max_uses: opts.maxUses ?? 1 },
      CreatedInvite,
    );
  }

  revokeInvite(inviteId: string): Promise<Invite> {
    return call(this.sb, "revoke_invite", { p_invite: inviteId }, Invite);
  }

  acceptInvite(token: string) {
    return call(this.sb, "accept_invite", { p_token: token.trim() }, AcceptedInvite);
  }

  removeMember(workspaceId: string, userId: string): Promise<unknown> {
    return call(this.sb, "remove_member", { p_workspace: workspaceId, p_user: userId }, z.unknown());
  }

  setRole(workspaceId: string, userId: string, role: "owner" | "admin" | "member"): Promise<unknown> {
    return call(this.sb, "set_member_role", { p_workspace: workspaceId, p_user: userId, p_role: role }, z.unknown());
  }

  policy(workspaceId: string): Promise<WorkspacePolicy> {
    return call(this.sb, "workspace_policy", { p_workspace: workspaceId }, WorkspacePolicy);
  }

  setPolicy(workspaceId: string, patch: WorkspacePolicyPatch): Promise<WorkspacePolicy> {
    return call(this.sb, "set_workspace_policy", { p_workspace: workspaceId, p_policy: patch }, WorkspacePolicy);
  }

  // ---- installations

  installations(workspaceId: string): Promise<Installation[]> {
    return select(this.sb.from("installations").select("*").eq("workspace_id", workspaceId).order("created_at"), z.array(Installation));
  }

  /** The secret in the answer is shown once: hand it to the machine. */
  registerInstallation(workspaceId: string, name: string, opts: { platform?: string; version?: string; scopes?: Scope[] } = {}) {
    return call(
      this.sb,
      "register_installation",
      { p_workspace: workspaceId, p_name: name, p_platform: opts.platform ?? "", p_version: opts.version ?? "", p_scopes: opts.scopes ?? undefined },
      RegisteredInstallation,
    );
  }

  updateInstallation(id: string, patch: { name?: string; acceptOwn?: boolean; scopes?: Scope[] }): Promise<Installation> {
    return call(
      this.sb,
      "update_installation",
      { p_installation: id, p_name: patch.name ?? null, p_accept_own: patch.acceptOwn ?? null, p_scopes: patch.scopes ?? null },
      Installation,
    );
  }

  revokeInstallation(id: string): Promise<Installation> {
    return call(this.sb, "revoke_installation", { p_installation: id }, Installation);
  }

  providerConnections(installationId: string): Promise<ProviderConnection[]> {
    return select(
      this.sb.from("provider_connections").select("provider, account_label, account_email, plan").eq("installation_id", installationId),
      z.array(ProviderConnectionSchema),
    );
  }

  agents(workspaceId: string): Promise<AgentIdentity[]> {
    return select(this.sb.from("agent_identities").select("*").eq("workspace_id", workspaceId).order("last_seen_at", { ascending: false }), z.array(AgentIdentity));
  }

  grants(workspaceId: string): Promise<DeliveryGrant[]> {
    return select(this.sb.from("delivery_grants").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }), z.array(DeliveryGrant));
  }

  grantDelivery(target: string, to: { user?: string; installation?: string }): Promise<DeliveryGrant> {
    return call(this.sb, "grant_delivery", { p_target: target, p_user: to.user ?? null, p_installation: to.installation ?? null }, DeliveryGrant);
  }

  revokeDelivery(grantId: string): Promise<DeliveryGrant> {
    return call(this.sb, "revoke_delivery", { p_grant: grantId }, DeliveryGrant);
  }

  /** Receipts the signed-in human may see: sent from their installations, or
   *  to them. Bodies are still in the row until delivery ends. */
  messages(workspaceId: string, limit = 100): Promise<(MessageReceipt & { body?: string | null })[]> {
    return select(
      this.sb.from("messages").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(limit),
      z.array(MessageReceipt.extend({ body: z.string().nullable().optional() })),
    );
  }

  // ---- plans and skills

  plans(workspaceId: string): Promise<Plan[]> {
    return select(this.sb.from("plans").select("*").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }), z.array(Plan));
  }

  async plan(workspaceId: string, slug: string, rev?: number): Promise<PlanWithRevision> {
    const plan = await select(this.sb.from("plans").select("*").eq("workspace_id", workspaceId).eq("slug", slug).single(), Plan);
    const revisions = await select(
      this.sb.from("plan_revisions").select("plan_id, workspace_id, rev, title, sha256, summary, created_by, created_by_installation, created_at").eq("plan_id", plan.id).order("rev", { ascending: false }),
      z.array(PlanRevision),
    );
    const revision = await select(this.sb.from("plan_revisions").select("*").eq("plan_id", plan.id).eq("rev", rev ?? plan.latest_rev).single(), PlanRevision);
    return { plan, revision, revisions };
  }

  publishPlan(workspaceId: string, p: { slug: string; title: string; body: string; baseRev?: number | null; summary?: string }) {
    return call(
      this.sb,
      "publish_plan",
      { p_workspace: workspaceId, p_slug: p.slug, p_title: p.title, p_body: p.body, p_base_rev: p.baseRev ?? null, p_summary: p.summary ?? "" },
      PublishedPlan,
    );
  }

  skills(workspaceId: string): Promise<Skill[]> {
    return select(this.sb.from("skills").select("*").eq("workspace_id", workspaceId).order("name"), z.array(Skill));
  }

  async skill(workspaceId: string, name: string, rev?: number): Promise<SkillWithRevision> {
    const skill = await select(this.sb.from("skills").select("*").eq("workspace_id", workspaceId).eq("name", name).single(), Skill);
    const revisions = await select(
      this.sb.from("skill_revisions").select("skill_id, workspace_id, rev, description, bundle_sha256, total_bytes, summary, created_by, created_by_installation, created_at").eq("skill_id", skill.id).order("rev", { ascending: false }),
      z.array(SkillRevision),
    );
    const revision = await select(this.sb.from("skill_revisions").select("*").eq("skill_id", skill.id).eq("rev", rev ?? skill.latest_rev).single(), SkillRevision);
    return { skill, revision, revisions };
  }

  publishSkill(workspaceId: string, s: { name: string; files: SkillFileInput[]; description?: string; baseRev?: number | null; summary?: string }) {
    return call(
      this.sb,
      "publish_skill",
      { p_workspace: workspaceId, p_name: s.name, p_files: s.files, p_description: s.description ?? "", p_base_rev: s.baseRev ?? null, p_summary: s.summary ?? "" },
      PublishedSkill,
    );
  }

  private async mustUser(): Promise<string> {
    const uid = await this.userId();
    if (!uid) throw new CloudError("sign in first", 401);
    return uid;
  }
}

// ----------------------------------------------------------- installation

export class InstallationCloud {
  readonly #secret: string;

  constructor(
    readonly sb: SupabaseClient,
    secret: string,
  ) {
    if (!INSTALLATION_SECRET_RE.test(secret)) throw new CloudError("that is not an installation secret", 400);
    this.#secret = secret;
  }

  #call<T>(fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    return call(this.sb, fn, { p_secret: this.#secret, ...args }, schema);
  }

  hello(version: string, platform: string): Promise<Hello> {
    return this.#call("inst_hello", { p_version: version, p_platform: platform }, Hello);
  }

  revokeSelf(): Promise<Installation> {
    return this.#call("inst_revoke_self", {}, Installation);
  }

  /** Replace this machine's provider metadata. Each entry is checked against
   *  the schema first, so nothing but the four known fields can leave. */
  syncProviders(list: ProviderConnection[]): Promise<number> {
    const clean = list.map((c) => ProviderConnectionSchema.parse(c));
    return this.#call("inst_sync_providers", { p_connections: clean }, z.number());
  }

  upsertAgent(session: string, opts: { provider?: string | null; label?: string | null; listed?: boolean | null } = {}): Promise<AgentIdentity> {
    return this.#call(
      "inst_upsert_agent",
      { p_session: session, p_provider: opts.provider ?? null, p_label: opts.label ?? null, p_listed: opts.listed ?? null },
      AgentIdentity,
    );
  }

  directory(): Promise<Directory> {
    return this.#call("inst_directory", {}, Directory);
  }

  send(m: { clientId: string; target: string; targetAgent: string | null; body: string; senderAgent?: string | null; wake?: boolean }): Promise<SendResult> {
    return this.#call(
      "inst_send",
      { p_client_id: m.clientId, p_target: m.target, p_target_agent: m.targetAgent, p_body: m.body, p_sender_agent: m.senderAgent ?? null, p_wake: m.wake ?? false },
      SendResult,
    );
  }

  fetch(limit = 20): Promise<InboundMessage[]> {
    return this.#call("inst_fetch", { p_limit: limit }, z.array(InboundMessage));
  }

  ack(id: string, state: DeliveryOutcome, reason: string | null): Promise<MessageReceipt> {
    return this.#call("inst_ack", { p_message: id, p_state: state, p_reason: reason }, MessageReceipt);
  }

  messages(box: "in" | "out", opts: { limit?: number; ids?: string[] } = {}): Promise<MessageReceipt[]> {
    return this.#call("inst_messages", { p_box: box, p_limit: opts.limit ?? 50, p_ids: opts.ids ?? null }, z.array(MessageReceipt));
  }

  plans(): Promise<Plan[]> {
    return this.#call("inst_plans", {}, z.array(Plan));
  }

  plan(slug: string, rev?: number): Promise<PlanWithRevision> {
    return this.#call("inst_plan", { p_slug: slug, p_rev: rev ?? null }, PlanWithRevision);
  }

  publishPlan(p: { slug: string; title: string; body: string; baseRev?: number | null; summary?: string }): Promise<PublishedPlan> {
    return this.#call("inst_publish_plan", { p_slug: p.slug, p_title: p.title, p_body: p.body, p_base_rev: p.baseRev ?? null, p_summary: p.summary ?? "" }, PublishedPlan);
  }

  skills(): Promise<Skill[]> {
    return this.#call("inst_skills", {}, z.array(Skill));
  }

  skill(name: string, rev?: number): Promise<SkillWithRevision> {
    return this.#call("inst_skill", { p_name: name, p_rev: rev ?? null }, SkillWithRevision);
  }

  publishSkill(s: { name: string; files: SkillFileInput[]; description?: string; baseRev?: number | null; summary?: string }): Promise<PublishedSkill> {
    return this.#call(
      "inst_publish_skill",
      { p_name: s.name, p_files: s.files, p_description: s.description ?? "", p_base_rev: s.baseRev ?? null, p_summary: s.summary ?? "" },
      PublishedSkill,
    );
  }
}
