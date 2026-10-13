-- agentbox cloud, protocol 1: who the humans are, the workspaces they share,
-- the machines (installations) they register, and what those share: plans,
-- skills and messages between agents. docs/cloud.md is the contract.
--
-- Two kinds of caller:
--   * a human, signed in with Supabase Auth (the `authenticated` role). Reads
--     go through RLS; every change that spans rows or needs a check RLS cannot
--     state is an RPC below.
--   * an installation (an agentbox server on one machine), which holds no
--     human session. It calls the `inst_*` RPCs with its own secret, minted
--     by its owner and stored here only as a SHA-256 hash. Every call
--     re-checks that the installation is not revoked, that its owner is still
--     a member of the workspace, and that it holds the scope the call needs.
--
-- Nothing here is reachable through the Data API unless granted at the end of
-- this file. Agentbox never stores provider credentials or transcripts here.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ------------------------------------------------------------------ tables

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'A human, as co-members of a workspace see them. email is copied from the verified sign-in.';

-- Personal settings. `defaults` are the user's personal defaults (protocol
-- `PersonalDefaults`); `frontend` holds one object per frontend namespace
-- ("agentbox.web", "acme.dashboard"), so a custom UI keeps its own settings
-- beside the stock one without either reading the other's.
create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  defaults jsonb not null default '{}'::jsonb,
  frontend jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_settings_defaults_object check (jsonb_typeof(defaults) = 'object' and pg_column_size(defaults) <= 16384),
  constraint user_settings_frontend_object check (jsonb_typeof(frontend) = 'object' and pg_column_size(frontend) <= 65536)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index workspaces_created_by on public.workspaces (created_by);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  invited_by uuid,
  primary key (workspace_id, user_id)
);
create index workspace_members_user on public.workspace_members (user_id);

-- Team policy: what the workspace's admins decide for everyone in it. Stored
-- sparse; `private.effective_policy` fills in the defaults.
create table public.workspace_policies (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  policy jsonb not null default '{}'::jsonb check (jsonb_typeof(policy) = 'object'),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  email text check (email is null or email = lower(email)),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses int not null default 1 check (max_uses between 1 and 100),
  uses int not null default 0 check (uses >= 0),
  revoked_at timestamptz
);
create index workspace_invites_workspace on public.workspace_invites (workspace_id);

-- The secret half of an invite: never readable through the API.
create table private.invite_tokens (
  invite_id uuid primary key references public.workspace_invites (id) on delete cascade,
  token_hash bytea not null unique
);

-- A machine running agentbox, registered by its owner into one workspace.
create table public.installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$'),
  platform text not null default '' check (char_length(platform) <= 40),
  agentbox_version text not null default '' check (char_length(agentbox_version) <= 40),
  scopes text[] not null check (
    scopes <@ array['messages:send', 'messages:receive', 'artifacts:read', 'artifacts:publish']::text[]
  ),
  -- Messages from the owner's other installations are delivered without a
  -- grant while this is set. Everyone else needs a delivery grant.
  accept_own boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid
);
create unique index installations_active_name on public.installations (workspace_id, lower(name)) where revoked_at is null;
create index installations_owner on public.installations (owner_user_id);

create table private.installation_secrets (
  installation_id uuid primary key references public.installations (id) on delete cascade,
  secret_hash bytea not null unique
);

-- Which provider logins an installation runs on: metadata only. No token,
-- key or credential path is ever sent; inst_sync_providers refuses any field
-- it does not know.
create table public.provider_connections (
  installation_id uuid not null references public.installations (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9-]{1,23}$'),
  account_label text not null check (char_length(account_label) between 1 and 120),
  account_email text check (account_email is null or char_length(account_email) <= 254),
  plan text check (plan is null or char_length(plan) <= 60),
  updated_at timestamptz not null default now(),
  primary key (installation_id, provider, account_label)
);

-- An agent session on an installation, as the workspace can address it. The
-- installation is the authority for its own session ids; `listed` puts it in
-- the workspace directory.
create table public.agent_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  local_session_id text not null check (local_session_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9-]{1,23}$'),
  label text check (label is null or char_length(label) <= 120),
  listed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (installation_id, local_session_id)
);
create index agent_identities_workspace on public.agent_identities (workspace_id) where listed;

-- Permission to deliver into an installation's local agents. Membership in
-- the workspace is not that permission: the target's owner grants it, to a
-- user (any of their installations) or to one installation.
create table public.delivery_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  target_installation_id uuid not null references public.installations (id) on delete cascade,
  grantee_user_id uuid references auth.users (id) on delete cascade,
  grantee_installation_id uuid references public.installations (id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (num_nonnulls(grantee_user_id, grantee_installation_id) = 1)
);
create unique index delivery_grants_active on public.delivery_grants (
  target_installation_id, coalesce(grantee_user_id, grantee_installation_id)
) where revoked_at is null;
create index delivery_grants_grantee_user on public.delivery_grants (grantee_user_id);
create index delivery_grants_grantee_installation on public.delivery_grants (grantee_installation_id);

-- The mailbox. A row is one message from an agent (or its owner) on one
-- installation to a session on another. `body` is kept only until the target
-- reports what happened, or until `body_expires_at`; the row itself (the
-- receipt) until `purge_at`.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_msg_id text not null check (client_msg_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  sender_installation_id uuid not null references public.installations (id) on delete cascade,
  sender_user_id uuid not null,
  sender_agent text check (sender_agent is null or sender_agent ~ '^[A-Za-z0-9_-]{1,64}$'),
  sender_label text not null default '',
  target_installation_id uuid not null references public.installations (id) on delete cascade,
  target_agent text check (target_agent is null or target_agent ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind text not null default 'agent.message' check (kind in ('agent.message')),
  body text,
  body_sha256 text not null,
  body_bytes int not null,
  wake boolean not null default false,
  state text not null default 'queued' check (
    state in ('queued', 'leased', 'delivered', 'refused', 'failed', 'uncertain', 'expired', 'cancelled')
  ),
  reason text check (reason is null or char_length(reason) <= 1000),
  attempts int not null default 0,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  leased_at timestamptz,
  finished_at timestamptz,
  body_expires_at timestamptz not null,
  purge_at timestamptz not null,
  unique (sender_installation_id, client_msg_id)
);
create index messages_inbox on public.messages (target_installation_id, created_at) where state in ('queued', 'leased');
create index messages_sender on public.messages (sender_installation_id, created_at);
create index messages_target on public.messages (target_installation_id, created_at);
create index messages_sender_user on public.messages (sender_user_id);
create index messages_body_expiry on public.messages (body_expires_at) where body is not null;
create index messages_purge on public.messages (purge_at);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  title text not null check (char_length(title) between 1 and 200),
  latest_rev int not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table public.plan_revisions (
  plan_id uuid not null references public.plans (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rev int not null check (rev >= 1),
  title text not null,
  body text not null check (octet_length(body) <= 262144),
  sha256 text not null,
  summary text not null default '' check (char_length(summary) <= 500),
  created_by uuid not null,
  created_by_installation uuid references public.installations (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (plan_id, rev)
);
create index plan_revisions_workspace on public.plan_revisions (workspace_id);

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' and position('..' in name) = 0),
  description text not null default '' check (char_length(description) <= 1024),
  latest_rev int not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

-- A skill bundle: the whole directory as text files, `[{path, sha256, bytes,
-- content}]`, sorted by path, with one hash over all of it.
create table public.skill_revisions (
  skill_id uuid not null references public.skills (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rev int not null check (rev >= 1),
  description text not null default '',
  files jsonb not null,
  bundle_sha256 text not null,
  total_bytes int not null,
  summary text not null default '' check (char_length(summary) <= 500),
  created_by uuid not null,
  created_by_installation uuid references public.installations (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (skill_id, rev)
);
create index skill_revisions_workspace on public.skill_revisions (workspace_id);

-- ------------------------------------------------------- private helpers
-- SECURITY DEFINER so RLS policies can ask about membership without the
-- policy on workspace_members recursing into itself. They live in `private`,
-- which the Data API does not expose, and each answers only about the caller.

create function private.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create function private.is_admin(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  );
$$;

create function private.owns_installation(inst uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.installations i
    where i.id = inst and i.owner_user_id = (select auth.uid())
  );
$$;

create function private.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members a
    join public.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  );
$$;

-- The signed-in human, or an error. Anonymous sessions are not humans here.
create function private.human() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in first' using errcode = 'PT401';
  end if;
  return uid;
end;
$$;

-- `prefix_` + 43 url-safe characters (32 random bytes).
create function private.new_secret(prefix text) returns text
language sql volatile set search_path = '' as $$
  select prefix || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
$$;

create function private.hash_secret(secret text) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.digest(convert_to(secret, 'utf8'), 'sha256');
$$;

create function private.sha256_hex(t text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(t, 'utf8'), 'sha256'), 'hex');
$$;

create function private.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_settings_touch before update on public.user_settings
  for each row execute function private.touch();
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch();

-- Frontend preferences are namespaced: every key is a dotted name, every
-- value an object.
create function private.check_frontend() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
begin
  for k in select jsonb_object_keys(new.frontend) loop
    if k !~ '^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$' then
      raise exception 'frontend preferences are kept under a dotted namespace such as "agentbox.web", not "%"', k using errcode = 'PT400';
    end if;
    if jsonb_typeof(new.frontend -> k) <> 'object' then
      raise exception 'frontend namespace "%" must hold an object', k using errcode = 'PT400';
    end if;
  end loop;
  return new;
end;
$$;
create trigger user_settings_frontend before insert or update on public.user_settings
  for each row execute function private.check_frontend();

-- ------------------------------------------------------------ team policy

create function private.default_policy() returns jsonb
language sql immutable set search_path = '' as $$
  select '{
    "messaging": {"enabled": true, "allow_wake": false, "max_body_bytes": 16384, "body_retention_hours": 72, "sender_hourly_limit": 120},
    "artifacts": {"publish_role": "member"},
    "invites": {"max_ttl_hours": 168}
  }'::jsonb;
$$;

-- Refuses unknown sections and keys and out-of-range values, so a typo is an
-- error rather than a policy that silently does nothing.
create function private.check_policy(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  d jsonb := private.default_policy();
  sec text;
  k text;
  v jsonb;
begin
  if jsonb_typeof(p) <> 'object' then
    raise exception 'a policy is an object' using errcode = 'PT400';
  end if;
  for sec in select jsonb_object_keys(p) loop
    if not d ? sec then
      raise exception 'unknown policy section "%"', sec using errcode = 'PT400';
    end if;
    if jsonb_typeof(p -> sec) <> 'object' then
      raise exception 'policy section "%" must be an object', sec using errcode = 'PT400';
    end if;
    for k, v in select * from jsonb_each(p -> sec) loop
      if not (d -> sec) ? k then
        raise exception 'unknown policy key "%.%"', sec, k using errcode = 'PT400';
      end if;
      if jsonb_typeof(v) <> jsonb_typeof(d -> sec -> k) then
        raise exception 'policy key "%.%" must be a %', sec, k, jsonb_typeof(d -> sec -> k) using errcode = 'PT400';
      end if;
    end loop;
  end loop;
  if (p #>> '{messaging,max_body_bytes}')::int not between 256 and 65536 then
    raise exception 'messaging.max_body_bytes must be between 256 and 65536' using errcode = 'PT400';
  end if;
  if (p #>> '{messaging,body_retention_hours}')::int not between 1 and 720 then
    raise exception 'messaging.body_retention_hours must be between 1 and 720' using errcode = 'PT400';
  end if;
  if (p #>> '{messaging,sender_hourly_limit}')::int not between 1 and 10000 then
    raise exception 'messaging.sender_hourly_limit must be between 1 and 10000' using errcode = 'PT400';
  end if;
  if (p #>> '{artifacts,publish_role}') not in ('member', 'admin') then
    raise exception 'artifacts.publish_role must be "member" or "admin"' using errcode = 'PT400';
  end if;
  if (p #>> '{invites,max_ttl_hours}')::int not between 1 and 2160 then
    raise exception 'invites.max_ttl_hours must be between 1 and 2160' using errcode = 'PT400';
  end if;
  return p;
end;
$$;

create function private.effective_policy(ws uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'messaging', (d -> 'messaging') || coalesce(p.policy -> 'messaging', '{}'::jsonb),
    'artifacts', (d -> 'artifacts') || coalesce(p.policy -> 'artifacts', '{}'::jsonb),
    'invites', (d -> 'invites') || coalesce(p.policy -> 'invites', '{}'::jsonb)
  )
  from (select private.default_policy() as d) defaults
  left join public.workspace_policies p on p.workspace_id = ws;
$$;

-- Whether `uid` may publish plans and skills in `ws` under its policy.
create function private.may_publish(ws uuid, uid uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = uid
      and (m.role in ('owner', 'admin') or private.effective_policy(ws) #>> '{artifacts,publish_role}' = 'member')
  );
$$;

-- ------------------------------------------------------- installations

create function private.inst(p_secret text, p_scope text) returns public.installations
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations;
begin
  if p_secret is null or p_secret !~ '^abins_[A-Za-z0-9_-]{43}$' then
    raise exception 'installation credential is not valid' using errcode = 'PT401';
  end if;
  select inst.* into i
  from private.installation_secrets s
  join public.installations inst on inst.id = s.installation_id
  where s.secret_hash = private.hash_secret(p_secret);
  if not found or i.revoked_at is not null then
    raise exception 'installation credential is not valid (unknown or revoked)' using errcode = 'PT401';
  end if;
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = i.workspace_id and m.user_id = i.owner_user_id
  ) then
    raise exception 'installation credential is not valid: its owner is no longer a member of the workspace' using errcode = 'PT401';
  end if;
  if p_scope is not null and not (p_scope = any (i.scopes)) then
    raise exception 'this installation was not granted %', p_scope using errcode = 'PT403';
  end if;
  if i.last_seen_at is null or i.last_seen_at < now() - interval '1 minute' then
    update public.installations set last_seen_at = now() where id = i.id;
  end if;
  return i;
end;
$$;

-- Null when `s` may deliver into `t`'s agents, else why not.
create function private.delivery_refusal(s public.installations, t public.installations) returns text
language plpgsql stable set search_path = '' as $$
begin
  if t.id is null or t.workspace_id <> s.workspace_id then
    return 'no such installation in this workspace';
  end if;
  if t.revoked_at is not null then
    return 'the target installation has been revoked';
  end if;
  if not ('messages:receive' = any (t.scopes)) then
    return 'the target installation does not receive messages';
  end if;
  if not exists (
    select 1 from public.workspace_members m where m.workspace_id = t.workspace_id and m.user_id = t.owner_user_id
  ) then
    return 'the target installation''s owner is no longer a member of the workspace';
  end if;
  if s.revoked_at is not null then
    return 'the sending installation has been revoked';
  end if;
  if s.owner_user_id = t.owner_user_id and t.accept_own then
    return null;
  end if;
  if exists (
    select 1 from public.delivery_grants g
    where g.target_installation_id = t.id and g.revoked_at is null
      and g.created_by = t.owner_user_id
      and (g.grantee_installation_id = s.id or g.grantee_user_id = s.owner_user_id)
      and (g.grantee_user_id is null or exists (
        select 1 from public.workspace_members m where m.workspace_id = t.workspace_id and m.user_id = g.grantee_user_id
      ))
  ) then
    return null;
  end if;
  return 'the target installation''s owner has not allowed messages from you: ask them for a delivery grant';
end;
$$;

create function private.installation_view(i public.installations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'workspace_id', i.workspace_id, 'owner_user_id', i.owner_user_id, 'name', i.name,
    'platform', i.platform, 'agentbox_version', i.agentbox_version, 'scopes', to_jsonb(i.scopes),
    'accept_own', i.accept_own, 'created_at', i.created_at, 'last_seen_at', i.last_seen_at,
    'revoked_at', i.revoked_at
  );
$$;

create function private.person(uid uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('user_id', p.user_id, 'email', p.email, 'display_name', p.display_name)
     from public.profiles p where p.user_id = uid),
    jsonb_build_object('user_id', uid, 'email', '', 'display_name', '')
  );
$$;

-- What a sender (or a human) sees of a message: never the body.
create function private.message_view(m public.messages) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'workspace_id', m.workspace_id, 'client_msg_id', m.client_msg_id,
    'sender_installation_id', m.sender_installation_id, 'sender_user_id', m.sender_user_id,
    'sender_agent', m.sender_agent, 'sender_label', m.sender_label,
    'target_installation_id', m.target_installation_id, 'target_agent', m.target_agent,
    'kind', m.kind, 'body_sha256', m.body_sha256, 'body_bytes', m.body_bytes, 'wake', m.wake,
    'state', m.state, 'reason', m.reason, 'attempts', m.attempts,
    'created_at', m.created_at, 'leased_at', m.leased_at, 'finished_at', m.finished_at,
    'body_expires_at', m.body_expires_at
  );
$$;

-- Bodies past their retention are dropped and their messages expire; rows
-- past `purge_at` go. Called from the mailbox RPCs, so it needs no scheduler.
create function private.expire_messages() returns void
language sql set search_path = '' as $$
  update public.messages
     set state = case when state in ('queued', 'leased') then 'expired' else state end,
         reason = case when state in ('queued', 'leased') then 'not delivered before the workspace''s retention ran out' else reason end,
         finished_at = coalesce(finished_at, now()),
         body = null,
         lease_until = null
   where body is not null and body_expires_at < now();
  delete from public.messages where purge_at < now();
$$;

-- ------------------------------------------------------------ human RPCs

create function public.cloud_protocol() returns int
language sql immutable set search_path = '' as $$ select 1 $$;

-- The signed-in human: profile (created on first call), memberships.
create function public.cloud_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  insert into public.profiles (user_id, email) values (uid, mail)
  on conflict (user_id) do update set email = excluded.email
  where public.profiles.email is distinct from excluded.email;
  insert into public.user_settings (user_id) values (uid) on conflict do nothing;
  return jsonb_build_object(
    'protocol', 1,
    'user', private.person(uid),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('workspace', to_jsonb(w), 'role', m.role) order by w.name)
      from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
      where m.user_id = uid
    ), '[]'::jsonb)
  );
end;
$$;

create function public.create_workspace(p_name text, p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  ws public.workspaces;
begin
  perform public.cloud_me();
  if (select count(*) from public.workspaces w where w.created_by = uid) >= 20 then
    raise exception 'you have created 20 workspaces, the most one person may' using errcode = 'PT429';
  end if;
  begin
    insert into public.workspaces (slug, name, created_by) values (lower(trim(p_slug)), trim(p_name), uid) returning * into ws;
  exception when unique_violation then
    raise exception 'the workspace name "%" is taken', p_slug using errcode = 'PT409';
  end;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws.id, uid, 'owner');
  insert into public.workspace_policies (workspace_id, updated_by) values (ws.id, uid);
  return to_jsonb(ws);
end;
$$;

create function public.create_invite(
  p_workspace uuid, p_role text default 'member', p_email text default null,
  p_ttl_hours int default 72, p_max_uses int default 1
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  my_role text;
  max_ttl int := (private.effective_policy(p_workspace) #>> '{invites,max_ttl_hours}')::int;
  tok text := private.new_secret('abinv_');
  inv public.workspace_invites;
begin
  select m.role into my_role from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = uid;
  if my_role is null or my_role not in ('owner', 'admin') then
    raise exception 'only a workspace''s owners and admins invite' using errcode = 'PT403';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'an invite is for an admin or a member' using errcode = 'PT400';
  end if;
  if p_role = 'admin' and my_role <> 'owner' then
    raise exception 'only an owner invites admins' using errcode = 'PT403';
  end if;
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > max_ttl then
    raise exception 'an invite lasts between 1 and % hours in this workspace', max_ttl using errcode = 'PT400';
  end if;
  if p_email is not null and p_email !~ '^[^@\s]+@[^@\s]+$' then
    raise exception 'that is not an email address' using errcode = 'PT400';
  end if;
  insert into public.workspace_invites (workspace_id, role, email, created_by, expires_at, max_uses)
  values (p_workspace, p_role, lower(nullif(trim(p_email), '')), uid, now() + make_interval(hours => p_ttl_hours), coalesce(p_max_uses, 1))
  returning * into inv;
  insert into private.invite_tokens (invite_id, token_hash) values (inv.id, private.hash_secret(tok));
  return jsonb_build_object('invite', to_jsonb(inv), 'token', tok);
end;
$$;

create function public.revoke_invite(p_invite uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  inv public.workspace_invites;
begin
  perform private.human();
  select * into inv from public.workspace_invites where id = p_invite;
  if not found or not private.is_admin(inv.workspace_id) then
    raise exception 'no such invite' using errcode = 'PT404';
  end if;
  update public.workspace_invites set revoked_at = coalesce(revoked_at, now()) where id = p_invite returning * into inv;
  return to_jsonb(inv);
end;
$$;

create function public.accept_invite(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  inv public.workspace_invites;
  existing text;
begin
  perform public.cloud_me();
  if p_token is null or p_token !~ '^abinv_[A-Za-z0-9_-]{43}$' then
    raise exception 'that is not an invite token' using errcode = 'PT400';
  end if;
  select i.* into inv
  from private.invite_tokens t join public.workspace_invites i on i.id = t.invite_id
  where t.token_hash = private.hash_secret(p_token)
  for update of i;
  if not found then
    raise exception 'no such invite' using errcode = 'PT404';
  end if;
  select m.role into existing from public.workspace_members m where m.workspace_id = inv.workspace_id and m.user_id = uid;
  if existing is not null then
    return jsonb_build_object('workspace_id', inv.workspace_id, 'role', existing, 'already', true);
  end if;
  if inv.revoked_at is not null then
    raise exception 'this invite was revoked' using errcode = 'PT403';
  end if;
  if inv.expires_at < now() then
    raise exception 'this invite expired' using errcode = 'PT403';
  end if;
  if inv.uses >= inv.max_uses then
    raise exception 'this invite has been used up' using errcode = 'PT403';
  end if;
  if inv.email is not null and inv.email <> mail then
    raise exception 'this invite is for another email address' using errcode = 'PT403';
  end if;
  update public.workspace_invites set uses = uses + 1 where id = inv.id;
  insert into public.workspace_members (workspace_id, user_id, role, invited_by) values (inv.workspace_id, uid, inv.role, inv.created_by);
  return jsonb_build_object('workspace_id', inv.workspace_id, 'role', inv.role, 'already', false);
end;
$$;

-- Leave (yourself) or remove (an admin removing a member, an owner anyone).
-- Their installations in the workspace are revoked and grants to them end;
-- the checks in private.inst and private.delivery_refusal hold even without
-- this, so a removal takes effect on the next call either way.
create function public.remove_member(p_workspace uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  my_role text;
  their_role text;
begin
  select m.role into my_role from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = uid;
  select m.role into their_role from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user;
  if my_role is null or their_role is null then
    raise exception 'no such member' using errcode = 'PT404';
  end if;
  if p_user <> uid and not (my_role = 'owner' or (my_role = 'admin' and their_role = 'member')) then
    raise exception 'you may not remove this member' using errcode = 'PT403';
  end if;
  if their_role = 'owner' and (
    select count(*) from public.workspace_members m where m.workspace_id = p_workspace and m.role = 'owner'
  ) = 1 then
    raise exception 'a workspace keeps at least one owner: make someone else owner first' using errcode = 'PT409';
  end if;
  delete from public.workspace_members where workspace_id = p_workspace and user_id = p_user;
  update public.installations set revoked_at = now(), revoked_by = uid
   where workspace_id = p_workspace and owner_user_id = p_user and revoked_at is null;
  delete from private.installation_secrets s using public.installations i
   where s.installation_id = i.id and i.workspace_id = p_workspace and i.owner_user_id = p_user;
  update public.delivery_grants set revoked_at = now()
   where workspace_id = p_workspace and grantee_user_id = p_user and revoked_at is null;
  return jsonb_build_object('removed', p_user);
end;
$$;

create function public.set_member_role(p_workspace uuid, p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = uid and m.role = 'owner') then
    raise exception 'only an owner changes roles' using errcode = 'PT403';
  end if;
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'a role is owner, admin or member' using errcode = 'PT400';
  end if;
  if p_role <> 'owner' and exists (
    select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user and m.role = 'owner'
  ) and (select count(*) from public.workspace_members m where m.workspace_id = p_workspace and m.role = 'owner') = 1 then
    raise exception 'a workspace keeps at least one owner' using errcode = 'PT409';
  end if;
  update public.workspace_members set role = p_role where workspace_id = p_workspace and user_id = p_user;
  if not found then
    raise exception 'no such member' using errcode = 'PT404';
  end if;
  return jsonb_build_object('user_id', p_user, 'role', p_role);
end;
$$;

create function public.set_workspace_policy(p_workspace uuid, p_policy jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  merged jsonb;
begin
  if not private.is_admin(p_workspace) then
    raise exception 'only a workspace''s owners and admins set its policy' using errcode = 'PT403';
  end if;
  -- Validate what it would become, every default filled in.
  merged := jsonb_build_object(
    'messaging', (private.default_policy() -> 'messaging') || coalesce(p_policy -> 'messaging', '{}'::jsonb),
    'artifacts', (private.default_policy() -> 'artifacts') || coalesce(p_policy -> 'artifacts', '{}'::jsonb),
    'invites', (private.default_policy() -> 'invites') || coalesce(p_policy -> 'invites', '{}'::jsonb)
  );
  perform private.check_policy(p_policy);
  perform private.check_policy(merged);
  insert into public.workspace_policies (workspace_id, policy, updated_by, updated_at)
  values (p_workspace, p_policy, uid, now())
  on conflict (workspace_id) do update set policy = excluded.policy, updated_by = excluded.updated_by, updated_at = now();
  return private.effective_policy(p_workspace);
end;
$$;

create function public.workspace_policy(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.human();
  if not private.is_member(p_workspace) then
    raise exception 'no such workspace' using errcode = 'PT404';
  end if;
  return private.effective_policy(p_workspace);
end;
$$;

create function private.check_scopes(p_scopes text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
begin
  if p_scopes is null or not (p_scopes <@ array['messages:send', 'messages:receive', 'artifacts:read', 'artifacts:publish']::text[]) then
    raise exception 'scopes are messages:send, messages:receive, artifacts:read and artifacts:publish' using errcode = 'PT400';
  end if;
  return (select coalesce(array_agg(distinct s order by s), '{}') from unnest(p_scopes) s);
end;
$$;

-- Register a machine. The secret is returned once and kept here only as its
-- hash; the owner's browser or CLI hands it to that machine's agentbox.
create function public.register_installation(
  p_workspace uuid, p_name text, p_platform text default '', p_version text default '',
  p_scopes text[] default array['messages:send', 'messages:receive', 'artifacts:read']
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  i public.installations;
  secret text := private.new_secret('abins_');
begin
  if not private.is_member(p_workspace) then
    raise exception 'no such workspace' using errcode = 'PT404';
  end if;
  if (select count(*) from public.installations x where x.owner_user_id = uid and x.workspace_id = p_workspace and x.revoked_at is null) >= 20 then
    raise exception 'you have 20 installations in this workspace: revoke one first' using errcode = 'PT429';
  end if;
  begin
    insert into public.installations (workspace_id, owner_user_id, name, platform, agentbox_version, scopes)
    values (p_workspace, uid, trim(p_name), coalesce(p_platform, ''), coalesce(p_version, ''), private.check_scopes(p_scopes))
    returning * into i;
  exception when unique_violation then
    raise exception 'an installation named "%" is already registered in this workspace', p_name using errcode = 'PT409';
  end;
  insert into private.installation_secrets (installation_id, secret_hash) values (i.id, private.hash_secret(secret));
  return jsonb_build_object('installation', private.installation_view(i), 'secret', secret);
end;
$$;

create function public.update_installation(
  p_installation uuid, p_name text default null, p_accept_own boolean default null, p_scopes text[] default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  i public.installations;
begin
  select * into i from public.installations where id = p_installation and owner_user_id = uid and revoked_at is null for update;
  if not found then
    raise exception 'no such installation of yours' using errcode = 'PT404';
  end if;
  update public.installations set
    name = coalesce(trim(p_name), name),
    accept_own = coalesce(p_accept_own, accept_own),
    scopes = case when p_scopes is null then scopes else private.check_scopes(p_scopes) end
  where id = p_installation returning * into i;
  return private.installation_view(i);
end;
$$;

-- Revoking takes effect on the installation's next call: its secret is
-- deleted, what it had queued is cancelled, and what was queued for it fails.
create function private.revoke_installation(i public.installations, by_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.installations set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, by_user)
   where id = i.id returning * into i;
  delete from private.installation_secrets where installation_id = i.id;
  update public.delivery_grants set revoked_at = now()
   where (target_installation_id = i.id or grantee_installation_id = i.id) and revoked_at is null;
  update public.messages set state = 'cancelled', reason = 'the sending installation was revoked', body = null,
         finished_at = now(), lease_until = null
   where sender_installation_id = i.id and state in ('queued', 'leased');
  update public.messages set state = 'failed', reason = 'the target installation was revoked', body = null,
         finished_at = now(), lease_until = null
   where target_installation_id = i.id and state in ('queued', 'leased');
  return private.installation_view(i);
end;
$$;

create function public.revoke_installation(p_installation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  i public.installations;
begin
  select * into i from public.installations where id = p_installation;
  if not found or not (i.owner_user_id = uid or private.is_admin(i.workspace_id)) then
    raise exception 'no such installation, or not yours to revoke' using errcode = 'PT404';
  end if;
  return private.revoke_installation(i, uid);
end;
$$;

create function public.grant_delivery(
  p_target uuid, p_user uuid default null, p_installation uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  t public.installations;
  g public.delivery_grants;
begin
  select * into t from public.installations where id = p_target and owner_user_id = uid and revoked_at is null;
  if not found then
    raise exception 'no such installation of yours' using errcode = 'PT404';
  end if;
  if num_nonnulls(p_user, p_installation) <> 1 then
    raise exception 'grant to one user or one installation' using errcode = 'PT400';
  end if;
  if p_user is not null and not exists (
    select 1 from public.workspace_members m where m.workspace_id = t.workspace_id and m.user_id = p_user
  ) then
    raise exception 'that user is not a member of this workspace' using errcode = 'PT404';
  end if;
  if p_installation is not null and not exists (
    select 1 from public.installations x where x.id = p_installation and x.workspace_id = t.workspace_id and x.revoked_at is null
  ) then
    raise exception 'no such installation in this workspace' using errcode = 'PT404';
  end if;
  select * into g from public.delivery_grants d
   where d.target_installation_id = t.id and d.revoked_at is null
     and coalesce(d.grantee_user_id, d.grantee_installation_id) = coalesce(p_user, p_installation);
  if not found then
    insert into public.delivery_grants (workspace_id, target_installation_id, grantee_user_id, grantee_installation_id, created_by)
    values (t.workspace_id, t.id, p_user, p_installation, uid) returning * into g;
  end if;
  return to_jsonb(g);
end;
$$;

-- The target's owner takes a grant back; a grantee may give one up.
create function public.revoke_delivery(p_grant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  g public.delivery_grants;
begin
  select * into g from public.delivery_grants where id = p_grant;
  if not found or not (
    private.owns_installation(g.target_installation_id) or g.grantee_user_id = uid
    or (g.grantee_installation_id is not null and private.owns_installation(g.grantee_installation_id))
  ) then
    raise exception 'no such grant' using errcode = 'PT404';
  end if;
  update public.delivery_grants set revoked_at = coalesce(revoked_at, now()) where id = p_grant returning * into g;
  return to_jsonb(g);
end;
$$;

-- ------------------------------------------------------ plans and skills

create function private.publish_plan(
  ws uuid, uid uuid, inst uuid, p_slug text, p_title text, p_body text, p_base_rev int, p_summary text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.plans;
  r public.plan_revisions;
  sha text := private.sha256_hex(coalesce(p_body, ''));
begin
  if not private.may_publish(ws, uid) then
    raise exception 'this workspace''s policy lets only admins publish' using errcode = 'PT403';
  end if;
  if p_body is null or p_title is null or char_length(trim(p_title)) = 0 then
    raise exception 'a plan has a title and a body' using errcode = 'PT400';
  end if;
  insert into public.plans (workspace_id, slug, title, created_by)
  values (ws, lower(p_slug), trim(p_title), uid)
  on conflict (workspace_id, slug) do nothing;
  select * into p from public.plans where workspace_id = ws and slug = lower(p_slug) for update;
  if p_base_rev is not null and p_base_rev <> p.latest_rev then
    raise exception 'plan "%" is at revision %, not %: read it again and publish on top of it', p.slug, p.latest_rev, p_base_rev
      using errcode = 'PT409';
  end if;
  -- Publishing what is already the latest is not a new revision: a retry
  -- after a lost answer lands on the revision it made.
  select * into r from public.plan_revisions where plan_id = p.id and rev = p.latest_rev;
  if found and r.sha256 = sha and r.title = trim(p_title) then
    return jsonb_build_object('plan', to_jsonb(p), 'revision', to_jsonb(r) - 'body', 'unchanged', true);
  end if;
  insert into public.plan_revisions (plan_id, workspace_id, rev, title, body, sha256, summary, created_by, created_by_installation)
  values (p.id, ws, p.latest_rev + 1, trim(p_title), p_body, sha, coalesce(p_summary, ''), uid, inst)
  returning * into r;
  update public.plans set latest_rev = r.rev, title = r.title, updated_at = now() where id = p.id returning * into p;
  return jsonb_build_object('plan', to_jsonb(p), 'revision', to_jsonb(r) - 'body', 'unchanged', false);
end;
$$;

create function public.publish_plan(
  p_workspace uuid, p_slug text, p_title text, p_body text, p_base_rev int default null, p_summary text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return private.publish_plan(p_workspace, private.human(), null, p_slug, p_title, p_body, p_base_rev, p_summary);
end;
$$;

-- Normalises a bundle to `[{path, sha256, bytes, content}]` sorted by path,
-- or refuses it: text files only, relative paths without `.` or `..`
-- segments, at most 200 files and 512 KiB, a SKILL.md at the top.
create function private.normalize_skill_files(p_files jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  f jsonb;
  acc jsonb := '[]'::jsonb;
  total int := 0;
  path text;
  content text;
  seen text[] := '{}'::text[];
begin
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 or jsonb_array_length(p_files) > 200 then
    raise exception 'a skill bundle is 1 to 200 files' using errcode = 'PT400';
  end if;
  for f in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(f) <> 'object' or jsonb_typeof(f -> 'path') <> 'string' or jsonb_typeof(f -> 'content') <> 'string'
       or exists (select 1 from jsonb_object_keys(f) k where k not in ('path', 'content', 'sha256', 'bytes')) then
      raise exception 'each file is {path, content}' using errcode = 'PT400';
    end if;
    path := f ->> 'path';
    content := f ->> 'content';
    if char_length(path) > 200 or path !~ '^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$'
       or path ~ '(^|/)\.\.?(/|$)' then
      raise exception 'bad file path "%"', path using errcode = 'PT400';
    end if;
    if path = any (seen) then
      raise exception 'file "%" appears twice', path using errcode = 'PT400';
    end if;
    seen := seen || path;
    total := total + octet_length(content);
    acc := acc || jsonb_build_array(jsonb_build_object(
      'path', path, 'sha256', private.sha256_hex(content), 'bytes', octet_length(content), 'content', content
    ));
  end loop;
  if total > 524288 then
    raise exception 'a skill bundle is at most 512 KiB of text' using errcode = 'PT400';
  end if;
  if not 'SKILL.md' = any (seen) then
    raise exception 'a skill bundle has a SKILL.md at its top' using errcode = 'PT400';
  end if;
  return (select jsonb_agg(e order by e ->> 'path') from jsonb_array_elements(acc) e);
end;
$$;

create function private.publish_skill(
  ws uuid, uid uuid, inst uuid, p_name text, p_description text, p_files jsonb, p_base_rev int, p_summary text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.skills;
  r public.skill_revisions;
  files jsonb := private.normalize_skill_files(p_files);
  bundle text;
  total int;
begin
  if not private.may_publish(ws, uid) then
    raise exception 'this workspace''s policy lets only admins publish' using errcode = 'PT403';
  end if;
  select string_agg((e ->> 'path') || chr(9) || (e ->> 'sha256'), chr(10) order by e ->> 'path'), sum((e ->> 'bytes')::int)
    into bundle, total from jsonb_array_elements(files) e;
  bundle := private.sha256_hex(bundle);
  insert into public.skills (workspace_id, name, description, created_by)
  values (ws, p_name, coalesce(p_description, ''), uid)
  on conflict (workspace_id, name) do nothing;
  select * into s from public.skills where workspace_id = ws and name = p_name for update;
  if p_base_rev is not null and p_base_rev <> s.latest_rev then
    raise exception 'skill "%" is at revision %, not %', s.name, s.latest_rev, p_base_rev using errcode = 'PT409';
  end if;
  select * into r from public.skill_revisions where skill_id = s.id and rev = s.latest_rev;
  if found and r.bundle_sha256 = bundle then
    return jsonb_build_object('skill', to_jsonb(s), 'revision', to_jsonb(r) - 'files', 'unchanged', true);
  end if;
  insert into public.skill_revisions (skill_id, workspace_id, rev, description, files, bundle_sha256, total_bytes, summary, created_by, created_by_installation)
  values (s.id, ws, s.latest_rev + 1, coalesce(p_description, ''), files, bundle, total, coalesce(p_summary, ''), uid, inst)
  returning * into r;
  update public.skills set latest_rev = r.rev, description = r.description, updated_at = now() where id = s.id returning * into s;
  return jsonb_build_object('skill', to_jsonb(s), 'revision', to_jsonb(r) - 'files', 'unchanged', false);
end;
$$;

create function public.publish_skill(
  p_workspace uuid, p_name text, p_files jsonb, p_description text default '', p_base_rev int default null, p_summary text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return private.publish_skill(p_workspace, private.human(), null, p_name, p_description, p_files, p_base_rev, p_summary);
end;
$$;

-- ----------------------------------------------------- installation RPCs

create function public.inst_hello(p_secret text, p_version text default null, p_platform text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
begin
  update public.installations set
    agentbox_version = coalesce(left(p_version, 40), agentbox_version),
    platform = coalesce(left(p_platform, 40), platform),
    last_seen_at = now()
  where id = i.id returning * into i;
  return jsonb_build_object(
    'protocol', 1,
    'installation', private.installation_view(i),
    'workspace', (select to_jsonb(w) from public.workspaces w where w.id = i.workspace_id),
    'owner', private.person(i.owner_user_id),
    'policy', private.effective_policy(i.workspace_id)
  );
end;
$$;

-- An installation may give up its own credential (`agentbox cloud logout`).
create function public.inst_revoke_self(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
begin
  return private.revoke_installation(i, i.owner_user_id);
end;
$$;

create function public.inst_sync_providers(p_secret text, p_connections jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
  conn jsonb;
  n int := 0;
begin
  if jsonb_typeof(p_connections) <> 'array' or jsonb_array_length(p_connections) > 50 then
    raise exception 'provider connections are a list of at most 50' using errcode = 'PT400';
  end if;
  for conn in select value from jsonb_array_elements(p_connections) loop
    if jsonb_typeof(conn) <> 'object' or exists (
      select 1 from jsonb_object_keys(conn) k where k not in ('provider', 'account_label', 'account_email', 'plan')
    ) then
      raise exception 'a provider connection is {provider, account_label, account_email?, plan?}: nothing else, and never a credential'
        using errcode = 'PT400';
    end if;
  end loop;
  delete from public.provider_connections where installation_id = i.id;
  insert into public.provider_connections (installation_id, provider, account_label, account_email, plan)
  select i.id, c ->> 'provider', c ->> 'account_label', c ->> 'account_email', c ->> 'plan'
  from jsonb_array_elements(p_connections) c
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.inst_upsert_agent(
  p_secret text, p_session text, p_provider text default null, p_label text default null, p_listed boolean default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, case when p_listed then 'messages:receive' end);
  a public.agent_identities;
begin
  insert into public.agent_identities (workspace_id, installation_id, local_session_id, provider, label, listed)
  values (i.workspace_id, i.id, p_session, p_provider, left(p_label, 120), coalesce(p_listed, false))
  on conflict (installation_id, local_session_id) do update set
    provider = coalesce(excluded.provider, public.agent_identities.provider),
    label = coalesce(excluded.label, public.agent_identities.label),
    listed = coalesce(p_listed, public.agent_identities.listed),
    last_seen_at = now()
  returning * into a;
  return to_jsonb(a);
end;
$$;

-- The workspace as this installation can address it: active installations,
-- whether each takes messages from this one, and the agents listed there.
create function public.inst_directory(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
begin
  return jsonb_build_object(
    'installations', coalesce((
      select jsonb_agg(private.installation_view(t) || jsonb_build_object(
        'owner', private.person(t.owner_user_id),
        'accepts_from_me', private.delivery_refusal(i, t) is null,
        'refusal', private.delivery_refusal(i, t)
      ) order by t.name)
      from public.installations t
      where t.workspace_id = i.workspace_id and t.revoked_at is null
    ), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.last_seen_at desc)
      from public.agent_identities a
      join public.installations t on t.id = a.installation_id and t.revoked_at is null
      where a.workspace_id = i.workspace_id and a.listed
    ), '[]'::jsonb)
  );
end;
$$;

create function public.inst_send(
  p_secret text, p_client_id text, p_target uuid, p_target_agent text, p_body text,
  p_sender_agent text default null, p_wake boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.installations := private.inst(p_secret, 'messages:send');
  t public.installations;
  pol jsonb := private.effective_policy(s.workspace_id);
  sha text := private.sha256_hex(coalesce(p_body, ''));
  m public.messages;
  why text;
  who jsonb := private.person(s.owner_user_id);
begin
  perform private.expire_messages();
  if not (pol #>> '{messaging,enabled}')::boolean then
    raise exception 'this workspace''s policy has messaging turned off' using errcode = 'PT403';
  end if;
  if p_client_id is null or p_client_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'a message id is 8 to 64 of A-Z a-z 0-9 _ -' using errcode = 'PT400';
  end if;
  -- A retry with the same id is the same message, never a second one.
  select * into m from public.messages where sender_installation_id = s.id and client_msg_id = p_client_id;
  if found then
    if m.body_sha256 = sha and m.target_installation_id = p_target and m.target_agent is not distinct from p_target_agent then
      return jsonb_build_object('message', private.message_view(m), 'duplicate', true);
    end if;
    raise exception 'message id % was already used for a different message', p_client_id using errcode = 'PT409';
  end if;
  if p_body is null or octet_length(p_body) = 0 then
    raise exception 'the message is empty' using errcode = 'PT400';
  end if;
  if octet_length(p_body) > (pol #>> '{messaging,max_body_bytes}')::int then
    raise exception 'the message is % bytes; this workspace takes at most %', octet_length(p_body), pol #>> '{messaging,max_body_bytes}'
      using errcode = 'PT400';
  end if;
  if p_wake and not (pol #>> '{messaging,allow_wake}')::boolean then
    raise exception 'this workspace''s policy does not let a message wake a session' using errcode = 'PT403';
  end if;
  select * into t from public.installations where id = p_target;
  why := private.delivery_refusal(s, t);
  if why is not null then
    raise exception 'not sent: %', why using errcode = 'PT403';
  end if;
  if (select count(*) from public.messages x where x.sender_installation_id = s.id and x.created_at > now() - interval '1 hour')
     >= (pol #>> '{messaging,sender_hourly_limit}')::int then
    raise exception 'this installation has sent % messages in the last hour, the workspace''s limit', pol #>> '{messaging,sender_hourly_limit}'
      using errcode = 'PT429';
  end if;
  insert into public.messages (
    workspace_id, client_msg_id, sender_installation_id, sender_user_id, sender_agent, sender_label,
    target_installation_id, target_agent, body, body_sha256, body_bytes, wake, body_expires_at, purge_at
  ) values (
    s.workspace_id, p_client_id, s.id, s.owner_user_id, p_sender_agent,
    left(coalesce(nullif(who ->> 'display_name', ''), who ->> 'email') || ' on ' || s.name || coalesce('/' || p_sender_agent, ''), 200),
    t.id, p_target_agent, p_body, sha, octet_length(p_body), coalesce(p_wake, false),
    now() + make_interval(hours => (pol #>> '{messaging,body_retention_hours}')::int),
    now() + interval '30 days'
  )
  on conflict (sender_installation_id, client_msg_id) do nothing
  returning * into m;
  if m.id is null then
    -- Lost a race with the same id: answer as the retry it is.
    select * into m from public.messages where sender_installation_id = s.id and client_msg_id = p_client_id;
    if m.body_sha256 <> sha then
      raise exception 'message id % was already used for a different message', p_client_id using errcode = 'PT409';
    end if;
    return jsonb_build_object('message', private.message_view(m), 'duplicate', true);
  end if;
  return jsonb_build_object('message', private.message_view(m), 'duplicate', false);
end;
$$;

-- Leases what is waiting for this installation, bodies included. A lease
-- that runs out without an answer makes the message fetchable again; the
-- installation's own record decides whether that is a redelivery (never: it
-- reports what it already did).
create function public.inst_fetch(p_secret text, p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.installations := private.inst(p_secret, 'messages:receive');
  m public.messages;
  s public.installations;
  why text;
  acc jsonb := '[]'::jsonb;
begin
  perform private.expire_messages();
  for m in
    select * from public.messages x
    where x.target_installation_id = t.id
      and (x.state = 'queued' or (x.state = 'leased' and x.lease_until < now()))
      and x.body is not null
    order by x.created_at
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update skip locked
  loop
    -- Permission is checked again at delivery: a grant revoked or a sender
    -- removed after the send stops the message here.
    select * into s from public.installations where id = m.sender_installation_id;
    why := private.delivery_refusal(s, t);
    if why is not null then
      update public.messages set state = 'refused', reason = 'not delivered: ' || why, body = null, finished_at = now(), lease_until = null
       where id = m.id;
      continue;
    end if;
    update public.messages set state = 'leased', lease_until = now() + interval '2 minutes', leased_at = now(), attempts = attempts + 1
     where id = m.id returning * into m;
    acc := acc || jsonb_build_array(private.message_view(m) || jsonb_build_object(
      'body', m.body,
      'sender', private.person(m.sender_user_id),
      'sender_installation_name', s.name
    ));
  end loop;
  return acc;
end;
$$;

create function public.inst_ack(p_secret text, p_message uuid, p_state text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.installations := private.inst(p_secret, 'messages:receive');
  m public.messages;
begin
  if p_state not in ('delivered', 'refused', 'failed', 'uncertain') then
    raise exception 'a delivery ends delivered, refused, failed or uncertain' using errcode = 'PT400';
  end if;
  select * into m from public.messages where id = p_message and target_installation_id = t.id for update;
  if not found then
    raise exception 'no such message for this installation' using errcode = 'PT404';
  end if;
  if m.state = p_state then
    return private.message_view(m);
  end if;
  -- What the target did is the truth, even after the cloud gave up waiting.
  if m.state not in ('leased', 'expired') then
    raise exception 'message % is already %', m.id, m.state using errcode = 'PT409';
  end if;
  update public.messages set state = p_state, reason = left(p_reason, 1000), body = null, finished_at = now(), lease_until = null
   where id = m.id returning * into m;
  return private.message_view(m);
end;
$$;

-- Receipts this installation can see: what it sent (`out`) or what was sent
-- to it (`in`), newest first, never bodies.
create function public.inst_messages(p_secret text, p_box text default 'out', p_limit int default 50, p_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
begin
  perform private.expire_messages();
  return coalesce((
    select jsonb_agg(v order by v ->> 'created_at' desc) from (
      select private.message_view(m) || jsonb_build_object('target_installation_name', t.name) as v
      from public.messages m join public.installations t on t.id = m.target_installation_id
      where (case when p_box = 'in' then m.target_installation_id = i.id else m.sender_installation_id = i.id end)
        and (p_ids is null or m.id = any (p_ids))
      order by m.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) x
  ), '[]'::jsonb);
end;
$$;

create function public.inst_plans(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'artifacts:read');
begin
  return coalesce((select jsonb_agg(to_jsonb(p) order by p.updated_at desc) from public.plans p where p.workspace_id = i.workspace_id), '[]'::jsonb);
end;
$$;

create function public.inst_plan(p_secret text, p_slug text, p_rev int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'artifacts:read');
  p public.plans;
  r public.plan_revisions;
begin
  select * into p from public.plans where workspace_id = i.workspace_id and slug = lower(p_slug);
  if not found then
    raise exception 'no plan "%"', p_slug using errcode = 'PT404';
  end if;
  select * into r from public.plan_revisions where plan_id = p.id and rev = coalesce(p_rev, p.latest_rev);
  if not found then
    raise exception 'plan "%" has no revision %', p_slug, p_rev using errcode = 'PT404';
  end if;
  return jsonb_build_object(
    'plan', to_jsonb(p), 'revision', to_jsonb(r),
    'revisions', (select jsonb_agg(to_jsonb(x) - 'body' order by x.rev desc) from public.plan_revisions x where x.plan_id = p.id)
  );
end;
$$;

create function public.inst_publish_plan(
  p_secret text, p_slug text, p_title text, p_body text, p_base_rev int default null, p_summary text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'artifacts:publish');
begin
  return private.publish_plan(i.workspace_id, i.owner_user_id, i.id, p_slug, p_title, p_body, p_base_rev, p_summary);
end;
$$;

create function public.inst_skills(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'artifacts:read');
begin
  return coalesce((select jsonb_agg(to_jsonb(s) order by s.name) from public.skills s where s.workspace_id = i.workspace_id), '[]'::jsonb);
end;
$$;

create function public.inst_skill(p_secret text, p_name text, p_rev int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'artifacts:read');
  s public.skills;
  r public.skill_revisions;
begin
  select * into s from public.skills where workspace_id = i.workspace_id and name = p_name;
  if not found then
    raise exception 'no skill "%"', p_name using errcode = 'PT404';
  end if;
  select * into r from public.skill_revisions where skill_id = s.id and rev = coalesce(p_rev, s.latest_rev);
  if not found then
    raise exception 'skill "%" has no revision %', p_name, p_rev using errcode = 'PT404';
  end if;
  return jsonb_build_object(
    'skill', to_jsonb(s), 'revision', to_jsonb(r),
    'revisions', (select jsonb_agg(to_jsonb(x) - 'files' order by x.rev desc) from public.skill_revisions x where x.skill_id = s.id)
  );
end;
$$;

create function public.inst_publish_skill(
  p_secret text, p_name text, p_files jsonb, p_description text default '', p_base_rev int default null, p_summary text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'artifacts:publish');
begin
  return private.publish_skill(i.workspace_id, i.owner_user_id, i.id, p_name, p_description, p_files, p_base_rev, p_summary);
end;
$$;

-- -------------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_policies enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.installations enable row level security;
alter table public.provider_connections enable row level security;
alter table public.agent_identities enable row level security;
alter table public.delivery_grants enable row level security;
alter table public.messages enable row level security;
alter table public.plans enable row level security;
alter table public.plan_revisions enable row level security;
alter table public.skills enable row level security;
alter table public.skill_revisions enable row level security;
alter table private.invite_tokens enable row level security;
alter table private.installation_secrets enable row level security;

create policy "own or co-member profile" on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or private.shares_workspace(user_id));
create policy "own profile" on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own settings: read" on public.user_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own settings: create" on public.user_settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own settings: change" on public.user_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "members see their workspace" on public.workspaces for select to authenticated
  using (private.is_member(id));
create policy "members see co-members" on public.workspace_members for select to authenticated
  using (private.is_member(workspace_id));
create policy "members see the policy" on public.workspace_policies for select to authenticated
  using (private.is_member(workspace_id));
create policy "admins see invites" on public.workspace_invites for select to authenticated
  using (private.is_admin(workspace_id));
create policy "members see installations" on public.installations for select to authenticated
  using (private.is_member(workspace_id));
create policy "owners see provider metadata" on public.provider_connections for select to authenticated
  using (private.owns_installation(installation_id));
create policy "listed agents and your own" on public.agent_identities for select to authenticated
  using (private.is_member(workspace_id) and (listed or private.owns_installation(installation_id)));
create policy "grants you made or hold" on public.delivery_grants for select to authenticated
  using (private.is_member(workspace_id) and (
    private.owns_installation(target_installation_id)
    or grantee_user_id = (select auth.uid())
    or (grantee_installation_id is not null and private.owns_installation(grantee_installation_id))
  ));
create policy "messages you sent or your machines got" on public.messages for select to authenticated
  using (private.is_member(workspace_id) and (
    sender_user_id = (select auth.uid()) or private.owns_installation(target_installation_id)
  ));
create policy "members read plans" on public.plans for select to authenticated
  using (private.is_member(workspace_id));
create policy "members read plan revisions" on public.plan_revisions for select to authenticated
  using (private.is_member(workspace_id));
create policy "members read skills" on public.skills for select to authenticated
  using (private.is_member(workspace_id));
create policy "members read skill revisions" on public.skill_revisions for select to authenticated
  using (private.is_member(workspace_id));

-- ------------------------------------------------------------------ grants
-- Explicit, so nothing depends on the project's default privileges (new
-- public tables stop being exposed by default on 2026-10-30).

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.is_admin(uuid), private.owns_installation(uuid),
  private.shares_workspace(uuid) to authenticated;

revoke all on public.profiles, public.user_settings, public.workspaces, public.workspace_members,
  public.workspace_policies, public.workspace_invites, public.installations, public.provider_connections,
  public.agent_identities, public.delivery_grants, public.messages, public.plans, public.plan_revisions,
  public.skills, public.skill_revisions from anon, authenticated;

grant select on public.profiles, public.user_settings, public.workspaces, public.workspace_members,
  public.workspace_policies, public.workspace_invites, public.installations, public.provider_connections,
  public.agent_identities, public.delivery_grants, public.messages, public.plans, public.plan_revisions,
  public.skills, public.skill_revisions to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant insert (user_id, defaults, frontend), update (defaults, frontend) on public.user_settings to authenticated;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'cloud_protocol', 'cloud_me', 'create_workspace', 'create_invite', 'revoke_invite', 'accept_invite',
      'remove_member', 'set_member_role', 'set_workspace_policy', 'workspace_policy', 'register_installation',
      'update_installation', 'revoke_installation', 'grant_delivery', 'revoke_delivery', 'publish_plan',
      'publish_skill', 'inst_hello', 'inst_revoke_self', 'inst_sync_providers', 'inst_upsert_agent',
      'inst_directory', 'inst_send', 'inst_fetch', 'inst_ack', 'inst_messages', 'inst_plans', 'inst_plan',
      'inst_publish_plan', 'inst_skills', 'inst_skill', 'inst_publish_skill'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = 'cloud_protocol' or f.proname like 'inst\_%' then
      -- An installation calls with the publishable key and no user session.
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end;
$$;
