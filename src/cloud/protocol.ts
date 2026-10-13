/** agentbox cloud, protocol 1: the shapes the shared Supabase service and
 *  every client agree on (docs/cloud.md). Plain zod schemas and the types
 *  they infer, so a custom frontend, the CLI, the local server and the
 *  stock web app all read one model. Nothing here imports React or the
 *  local fleet's types.
 *
 *  Objects are loose: a newer service may add fields, and an older client
 *  must still read what it knows. A change that removes or retypes a field
 *  is a new protocol number (`cloud_protocol()` in the database). */

import { z } from "zod";

export const CLOUD_PROTOCOL = 1;

// ------------------------------------------------------------- vocabulary

export const SCOPES = ["messages:send", "messages:receive", "artifacts:read", "artifacts:publish"] as const;
export type Scope = (typeof SCOPES)[number];
/** What an installation gets unless its owner picks: it talks and reads,
 *  and publishing is asked for. */
export const DEFAULT_SCOPES: Scope[] = ["messages:send", "messages:receive", "artifacts:read"];

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** A message's life. `queued` and `leased` are in flight; the rest are
 *  final. `uncertain`: the target began typing it into the agent and could
 *  not confirm the end, so it is never typed again. */
export const MESSAGE_STATES = ["queued", "leased", "delivered", "refused", "failed", "uncertain", "expired", "cancelled"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];
export const FINAL_STATES: readonly MessageState[] = ["delivered", "refused", "failed", "uncertain", "expired", "cancelled"];
/** What a target reports after trying to deliver. */
export type DeliveryOutcome = "delivered" | "refused" | "failed" | "uncertain";

/** The four places a setting can live, and who decides it:
 *  - `personal`: the human, everywhere they sign in (`user_settings.defaults`);
 *  - `team`: the workspace's admins, for everyone in it (`workspace_policies`);
 *  - `installation`: one machine, never uploaded (paths, wake, polling);
 *  - `frontend`: one UI, under its own namespace (`user_settings.frontend`). */
export type SettingScope = "personal" | "team" | "installation" | "frontend";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const PLAN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
export const INSTALLATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** `agentbox.web`, `acme.dashboard`: a dotted name, one per frontend. */
export const FRONTEND_NAMESPACE_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
/** The stock web app's namespace. */
export const WEB_NAMESPACE = "agentbox.web";
export const INSTALLATION_SECRET_RE = /^abins_[A-Za-z0-9_-]{43}$/;
export const INVITE_TOKEN_RE = /^abinv_[A-Za-z0-9_-]{43}$/;

const ts = z.string();
const uuid = z.string();

// ----------------------------------------------------------------- people

export const Person = z.looseObject({ user_id: uuid, email: z.string(), display_name: z.string() });
export type Person = z.infer<typeof Person>;

export const Workspace = z.looseObject({ id: uuid, slug: z.string(), name: z.string(), created_by: uuid, created_at: ts });
export type Workspace = z.infer<typeof Workspace>;

export const Membership = z.looseObject({ workspace: Workspace, role: z.enum(ROLES) });
export type Membership = z.infer<typeof Membership>;

export const Me = z.looseObject({ protocol: z.number(), user: Person, memberships: z.array(Membership) });
export type Me = z.infer<typeof Me>;

export const Member = z.looseObject({
  workspace_id: uuid,
  user_id: uuid,
  role: z.enum(ROLES),
  joined_at: ts,
  invited_by: uuid.nullable(),
});
export type Member = z.infer<typeof Member> & { person?: Person };

export const Invite = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  role: z.enum(["admin", "member"]),
  email: z.string().nullable(),
  created_by: uuid,
  created_at: ts,
  expires_at: ts,
  max_uses: z.number(),
  uses: z.number(),
  revoked_at: ts.nullable(),
});
export type Invite = z.infer<typeof Invite>;
export const CreatedInvite = z.looseObject({ invite: Invite, token: z.string().regex(INVITE_TOKEN_RE) });
export type CreatedInvite = z.infer<typeof CreatedInvite>;
export const AcceptedInvite = z.looseObject({ workspace_id: uuid, role: z.enum(ROLES), already: z.boolean() });

// --------------------------------------------------------------- settings

/** Team policy, every key filled in (`private.effective_policy`). */
export const WorkspacePolicy = z.looseObject({
  messaging: z.looseObject({
    enabled: z.boolean(),
    allow_wake: z.boolean(),
    max_body_bytes: z.number(),
    body_retention_hours: z.number(),
    sender_hourly_limit: z.number(),
  }),
  artifacts: z.looseObject({ publish_role: z.enum(["member", "admin"]) }),
  invites: z.looseObject({ max_ttl_hours: z.number() }),
});
export type WorkspacePolicy = z.infer<typeof WorkspacePolicy>;
/** What an admin sends: any subset, validated by the service. */
export type WorkspacePolicyPatch = {
  messaging?: Partial<Pick<WorkspacePolicy["messaging"], "enabled" | "allow_wake" | "max_body_bytes" | "body_retention_hours" | "sender_hourly_limit">>;
  artifacts?: Partial<Pick<WorkspacePolicy["artifacts"], "publish_role">>;
  invites?: Partial<Pick<WorkspacePolicy["invites"], "max_ttl_hours">>;
};

/** Personal defaults: what a human wants wherever they start a session. A
 *  machine's own settings (paths, accounts) are never here. */
export const PersonalDefaults = z.looseObject({
  provider: z.string().max(24).optional(),
  models: z.record(z.string(), z.string().max(120)).optional(),
  effort: z.string().max(24).optional(),
});
export type PersonalDefaults = z.infer<typeof PersonalDefaults>;

export const FrontendPrefs = z.record(z.string().regex(FRONTEND_NAMESPACE_RE), z.record(z.string(), z.unknown()));
export type FrontendPrefs = z.infer<typeof FrontendPrefs>;

export const UserSettings = z.looseObject({
  user_id: uuid,
  defaults: PersonalDefaults,
  frontend: FrontendPrefs,
  updated_at: ts,
});
export type UserSettings = z.infer<typeof UserSettings>;

/** One machine's own cloud settings. Kept in the agentbox home, never sent. */
export const InstallationSettings = z.object({
  /** Let a remote message wake a stopped, parked or cold session when its
   *  sender asks and the team policy allows. Off: such messages are refused. */
  allowRemoteWake: z.boolean().default(false),
  /** Where `skill install` writes: Claude's root or the shared `.agents` one. */
  skillRoot: z.enum(["claude", "agents"]).default("claude"),
  /** Send provider account emails with the provider metadata. Off: labels only. */
  shareAccountEmails: z.boolean().default(false),
  /** How often the mailbox is read, in seconds. */
  pollSeconds: z.number().int().min(2).max(300).default(5),
});
export type InstallationSettings = z.infer<typeof InstallationSettings>;

// ---------------------------------------------------------- installations

export const Installation = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  owner_user_id: uuid,
  name: z.string(),
  platform: z.string(),
  agentbox_version: z.string(),
  scopes: z.array(z.enum(SCOPES)),
  accept_own: z.boolean(),
  created_at: ts,
  last_seen_at: ts.nullable(),
  revoked_at: ts.nullable(),
});
export type Installation = z.infer<typeof Installation>;
export const RegisteredInstallation = z.looseObject({ installation: Installation, secret: z.string().regex(INSTALLATION_SECRET_RE) });
export type RegisteredInstallation = z.infer<typeof RegisteredInstallation>;

/** Provider login metadata. There is deliberately no field a credential
 *  could go in, and the service refuses unknown ones. */
export const ProviderConnection = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
  account_label: z.string().min(1).max(120),
  account_email: z.string().max(254).nullable().optional(),
  plan: z.string().max(60).nullable().optional(),
});
export type ProviderConnection = z.infer<typeof ProviderConnection>;

export const AgentIdentity = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  installation_id: uuid,
  local_session_id: z.string(),
  provider: z.string().nullable(),
  label: z.string().nullable(),
  listed: z.boolean(),
  first_seen_at: ts,
  last_seen_at: ts,
});
export type AgentIdentity = z.infer<typeof AgentIdentity>;

export const DeliveryGrant = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  target_installation_id: uuid,
  grantee_user_id: uuid.nullable(),
  grantee_installation_id: uuid.nullable(),
  created_by: uuid,
  created_at: ts,
  revoked_at: ts.nullable(),
});
export type DeliveryGrant = z.infer<typeof DeliveryGrant>;

export const Hello = z.looseObject({
  protocol: z.number(),
  installation: Installation,
  workspace: Workspace,
  owner: Person,
  policy: WorkspacePolicy,
});
export type Hello = z.infer<typeof Hello>;

export const DirectoryInstallation = Installation.extend({
  owner: Person,
  accepts_from_me: z.boolean(),
  refusal: z.string().nullable(),
});
export type DirectoryInstallation = z.infer<typeof DirectoryInstallation>;
export const Directory = z.looseObject({ installations: z.array(DirectoryInstallation), agents: z.array(AgentIdentity) });
export type Directory = z.infer<typeof Directory>;

// --------------------------------------------------------------- messages

/** A receipt: everything about a message but its body. */
export const MessageReceipt = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  client_msg_id: z.string(),
  sender_installation_id: uuid,
  sender_user_id: uuid,
  sender_agent: z.string().nullable(),
  sender_label: z.string(),
  target_installation_id: uuid,
  target_agent: z.string().nullable(),
  target_installation_name: z.string().optional(),
  kind: z.literal("agent.message"),
  body_sha256: z.string(),
  body_bytes: z.number(),
  wake: z.boolean(),
  state: z.enum(MESSAGE_STATES),
  reason: z.string().nullable(),
  attempts: z.number(),
  created_at: ts,
  leased_at: ts.nullable(),
  finished_at: ts.nullable(),
  body_expires_at: ts,
});
export type MessageReceipt = z.infer<typeof MessageReceipt>;

/** A message as its target installation leases it. */
export const InboundMessage = MessageReceipt.extend({
  body: z.string(),
  sender: Person,
  sender_installation_name: z.string(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export const SendResult = z.looseObject({ message: MessageReceipt, duplicate: z.boolean() });
export type SendResult = z.infer<typeof SendResult>;

// ---------------------------------------------------------------- artifacts

export const Plan = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  slug: z.string(),
  title: z.string(),
  latest_rev: z.number(),
  created_by: uuid,
  created_at: ts,
  updated_at: ts,
});
export type Plan = z.infer<typeof Plan>;

export const PlanRevision = z.looseObject({
  plan_id: uuid,
  workspace_id: uuid,
  rev: z.number(),
  title: z.string(),
  body: z.string().optional(),
  sha256: z.string(),
  summary: z.string(),
  created_by: uuid,
  created_by_installation: uuid.nullable(),
  created_at: ts,
});
export type PlanRevision = z.infer<typeof PlanRevision>;
export const PlanWithRevision = z.looseObject({ plan: Plan, revision: PlanRevision, revisions: z.array(PlanRevision) });
export type PlanWithRevision = z.infer<typeof PlanWithRevision>;
export const PublishedPlan = z.looseObject({ plan: Plan, revision: PlanRevision, unchanged: z.boolean() });
export type PublishedPlan = z.infer<typeof PublishedPlan>;

export const SkillFile = z.looseObject({ path: z.string(), sha256: z.string(), bytes: z.number(), content: z.string() });
export type SkillFile = z.infer<typeof SkillFile>;
/** What a publisher sends for each file; the service adds the hashes. */
export type SkillFileInput = { path: string; content: string };

export const Skill = z.looseObject({
  id: uuid,
  workspace_id: uuid,
  name: z.string(),
  description: z.string(),
  latest_rev: z.number(),
  created_by: uuid,
  created_at: ts,
  updated_at: ts,
});
export type Skill = z.infer<typeof Skill>;

export const SkillRevision = z.looseObject({
  skill_id: uuid,
  workspace_id: uuid,
  rev: z.number(),
  description: z.string(),
  files: z.array(SkillFile).optional(),
  bundle_sha256: z.string(),
  total_bytes: z.number(),
  summary: z.string(),
  created_by: uuid,
  created_by_installation: uuid.nullable(),
  created_at: ts,
});
export type SkillRevision = z.infer<typeof SkillRevision>;
export const SkillWithRevision = z.looseObject({ skill: Skill, revision: SkillRevision, revisions: z.array(SkillRevision) });
export type SkillWithRevision = z.infer<typeof SkillWithRevision>;
export const PublishedSkill = z.looseObject({ skill: Skill, revision: SkillRevision, unchanged: z.boolean() });
export type PublishedSkill = z.infer<typeof PublishedSkill>;

/** Limits the service enforces, mirrored so a client can say no first. */
export const LIMITS = {
  skillFiles: 200,
  skillBytes: 512 * 1024,
  planBytes: 256 * 1024,
  maxMessageBytes: 64 * 1024,
} as const;
