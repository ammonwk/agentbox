-- Shared superagents (docs/cloud.md, "Shared superagents"): a registry of
-- superagent instances, each shared by the machine that runs it, the live
-- relay's requests, the claims of shared instances, and the contact
-- preferences the GitHub broker checks.
--
-- What is here is metadata. A superagent's code travels by git only (an
-- instance names a source commit), a transcript or a page never lands in a
-- table (the relay's pages cross Realtime Broadcast sealed, src/cloud/relay.ts),
-- and a command's body is deleted when it reaches a final state.
--
-- Who does what:
--   * The host owner (the human who owns the installation that runs the
--     superagent) shares, changes and unshares it. Nobody else can, and the
--     host is always the installation that shared it: an instance never
--     points at another person's machine.
--   * A member who can see an instance (a maintainer, or anyone in the
--     workspace when its visibility is `workspace`) reads its chat and its
--     page through the relay, and sends it guidance or an action. Seeing it
--     gives no right to change it or to run it.
--   * The host installation answers reads, runs commands and keeps the
--     instance's claims, with its own secret and the `superagents:host` scope.
-- Every check runs again on every call: a removed member, a revoked machine
-- or an unshared instance stops on the next call.

-- ------------------------------------------------------------------ scope

alter table public.installations drop constraint installations_scopes_check;
alter table public.installations add constraint installations_scopes_check check (
  scopes <@ array['messages:send', 'messages:receive', 'artifacts:read', 'artifacts:publish', 'superagents:host']::text[]
);

create or replace function private.check_scopes(p_scopes text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
begin
  if p_scopes is null or not (p_scopes <@ array['messages:send', 'messages:receive', 'artifacts:read', 'artifacts:publish', 'superagents:host']::text[]) then
    raise exception 'scopes are messages:send, messages:receive, artifacts:read, artifacts:publish and superagents:host' using errcode = 'PT400';
  end if;
  return (select coalesce(array_agg(distinct s order by s), '{}') from unnest(p_scopes) s);
end;
$$;

-- ------------------------------------------------------------------ tables

create function private.valid_superagent_source(s jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select s is null or (
    jsonb_typeof(s) = 'object'
    and (select count(*) from jsonb_object_keys(s) k where k not in ('repo', 'path', 'commit')) = 0
    and jsonb_typeof(s -> 'repo') = 'string' and (s ->> 'repo') ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    and jsonb_typeof(s -> 'path') = 'string' and char_length(s ->> 'path') <= 500
    and (s ->> 'path') !~ '(^/|(^|/)\.\.(/|$))'
    and jsonb_typeof(s -> 'commit') = 'string' and (s ->> 'commit') ~ '^[0-9a-f]{40}$'
  );
$$;

-- One superagent on one host, as its host owner shared it. A row stays after
-- an unshare (claims may still name it); sharing again brings it back.
create table public.superagent_instances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  host_installation_id uuid not null references public.installations (id) on delete cascade,
  -- The host installation's owner, who shared it: the only one who changes it.
  shared_by uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9-]{0,39}$'),
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  -- Where a teammate copies it from as a template: {repo, path, commit}.
  source jsonb check (private.valid_superagent_source(source)),
  maintainers uuid[] not null check (cardinality(maintainers) between 1 and 30),
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  revision int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unshared_at timestamptz,
  unique (host_installation_id, name)
);
create index superagent_instances_workspace on public.superagent_instances (workspace_id) where unshared_at is null;

-- A teammate's request to read an instance's chat or page. Only the request
-- and the two ephemeral public keys: the page itself crosses Realtime sealed.
create table public.superagent_reads (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  instance_id uuid not null references public.superagent_instances (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  kind text not null check (kind in ('chat', 'view')),
  request jsonb not null default '{}' check (jsonb_typeof(request) = 'object' and pg_column_size(request) <= 1000),
  client_key text not null check (char_length(client_key) between 80 and 200),
  host_key text check (host_key is null or char_length(host_key) between 80 and 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '45 seconds'
);
create index superagent_reads_host on public.superagent_reads (installation_id, created_at);

-- Guidance to an instance's main conversation, or an action on its page.
-- The body is transport: it is deleted at the final state, and the receipt
-- (no body) a week later.
create table public.superagent_commands (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  instance_id uuid not null references public.superagent_instances (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  kind text not null check (kind in ('guide', 'action')),
  body jsonb check (body is null or pg_column_size(body) <= 65536),
  fingerprint text not null,
  -- guide: the main conversation the teammate saw. Delivered there or nowhere.
  expected_session text check (expected_session is null or expected_session ~ '^[A-Za-z0-9_-]{1,64}$'),
  client_key text check (client_key is null or char_length(client_key) between 80 and 200),
  host_key text check (host_key is null or char_length(host_key) between 80 and 200),
  state text not null default 'queued' check (state in ('queued', 'attempting', 'sent', 'refused', 'failed', 'uncertain')),
  result text not null default '' check (char_length(result) <= 1000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  finished_at timestamptz,
  check (kind <> 'guide' or expected_session is not null)
);
create index superagent_commands_host on public.superagent_commands (installation_id, created_at) where state in ('queued', 'attempting');
create index superagent_commands_purge on public.superagent_commands (finished_at);

-- Who holds a piece of work, for shared instances: one holder per
-- (workspace, scope, key) across every instance of the workspace. The same
-- rules as src/core/workclaims.ts: a fence that grows on each change of
-- holder, a lease the host renews, and an expired lease that stays exclusive.
create table public.superagent_claims (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  scope text not null check (scope in ('work', 'env')),
  key text not null check (char_length(key) between 1 and 2048),
  source text not null check (char_length(source) between 1 and 2048),
  fence int not null check (fence >= 1),
  state text not null check (state in ('active', 'uncertain', 'takeover_requested', 'released')),
  instance_id uuid not null references public.superagent_instances (id) on delete cascade,
  session text check (session is null or session ~ '^[A-Za-z0-9_-]{1,64}$'),
  note text check (note is null or char_length(note) <= 2000),
  lease_until timestamptz not null,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, scope, key)
);
create index superagent_claims_instance on public.superagent_claims (instance_id) where state <> 'released';

create table public.superagent_claim_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  scope text not null,
  key text not null,
  kind text not null,
  fence int not null,
  instance_id uuid,
  session text,
  note text,
  at timestamptz not null default now()
);
create index superagent_claim_events_key on public.superagent_claim_events (workspace_id, scope, key, id);

-- A person's own choice to be contacted by superagents' GitHub App, keyed by
-- the numeric GitHub id of the identity they verified. Default off; a row
-- that says no wins over every row that says yes.
create table public.contact_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  repo text not null default '*' check (repo = '*' or repo ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  instance_id uuid references public.superagent_instances (id) on delete cascade,
  allowed boolean not null,
  github_user_id bigint,
  updated_at timestamptz not null default now()
);
create unique index contact_preferences_scope on public.contact_preferences (
  workspace_id, user_id, repo, coalesce(instance_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- --------------------------------------------------------------- helpers

-- The installation is live as a host: not revoked, its owner still a member,
-- and `superagents:host` still on.
create function private.superagent_host_ok(s public.superagent_instances) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.installations i
    join public.workspace_members m on m.workspace_id = i.workspace_id and m.user_id = i.owner_user_id
    where i.id = s.host_installation_id and i.workspace_id = s.workspace_id and i.revoked_at is null
      and i.owner_user_id = s.shared_by and 'superagents:host' = any (i.scopes)
  );
$$;

-- `uid` sees the instance: shared, `uid` a member now, and a maintainer or
-- the host owner unless its visibility is `workspace`.
create function private.superagent_can_read(s public.superagent_instances, uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select s.id is not null and s.unshared_at is null and uid is not null
    and exists (select 1 from public.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = uid)
    and (s.visibility = 'workspace' or uid = any (s.maintainers) or uid = s.shared_by);
$$;

-- `uid` sees the claims of `p_instance`: a member now, and a maintainer or
-- the host owner unless its visibility is `workspace`. Shared or not: the
-- claims of an unshared instance are as private as the instance was.
create function private.superagent_claims_visible(p_instance uuid, uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select uid is not null and exists (
    select 1 from public.superagent_instances s
    join public.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = uid
    where s.id = p_instance and (s.visibility = 'workspace' or uid = any (s.maintainers) or uid = s.shared_by)
  );
$$;

-- The maintainers as stored: distinct, the host owner among them, each a member now.
create function private.superagent_maintainers(ws uuid, owner uuid, p uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  out uuid[];
begin
  select coalesce(array_agg(distinct x), '{}') into out from unnest(coalesce(p, '{}') || array[owner]) x where x is not null;
  if cardinality(out) > 30 then
    raise exception 'an instance has at most 30 maintainers' using errcode = 'PT400';
  end if;
  if exists (select 1 from unnest(out) x where not exists (
    select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = x
  )) then
    raise exception 'every maintainer must be a member of the workspace' using errcode = 'PT400';
  end if;
  return out;
end;
$$;

create function private.superagent_view(s public.superagent_instances, uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'workspace_id', s.workspace_id, 'name', s.name, 'title', s.title,
    'description', s.description, 'source', s.source, 'maintainers', to_jsonb(s.maintainers),
    'visibility', s.visibility, 'revision', s.revision, 'shared_by', private.person(s.shared_by),
    'host', jsonb_build_object(
      'installation_id', s.host_installation_id,
      'name', (select i.name from public.installations i where i.id = s.host_installation_id),
      'live', private.superagent_host_ok(s),
      'last_seen_at', (select i.last_seen_at from public.installations i where i.id = s.host_installation_id)
    ),
    'can_edit', uid is not null and uid = s.shared_by and private.superagent_host_ok(s),
    'maintainer', uid is not null and uid = any (s.maintainers),
    'created_at', s.created_at, 'updated_at', s.updated_at, 'unshared_at', s.unshared_at
  );
$$;

-- The instance, for the host owner who changes it; anyone else is refused.
create function private.superagent_owned(p_instance uuid, uid uuid) returns public.superagent_instances
language plpgsql security definer set search_path = '' as $$
declare
  s public.superagent_instances;
begin
  select * into s from public.superagent_instances where id = p_instance for update;
  if not found or not private.superagent_can_read(s, uid) and uid <> s.shared_by then
    raise exception 'no such shared superagent' using errcode = 'PT404';
  end if;
  if uid <> s.shared_by or not exists (
    select 1 from public.installations i where i.id = s.host_installation_id and i.owner_user_id = uid and i.revoked_at is null
  ) or not private.is_member(s.workspace_id) then
    raise exception 'only the owner of the machine that runs it can change or unshare it' using errcode = 'PT403';
  end if;
  return s;
end;
$$;

-- The installation calling, as the host of `p_instance`. With `p_live`, the
-- instance must be shared and the machine must hold `superagents:host`;
-- without it (giving work back, renewing, a handover), being its host is enough.
-- A live call holds the instance's row (FOR SHARE) until it commits, so an
-- unshare waits for a claim it makes and then sees it, or the claim sees the unshare.
create function private.superagent_hosted(p_secret text, p_instance uuid, p_live boolean) returns public.superagent_instances
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, case when p_live then 'superagents:host' else null end);
  s public.superagent_instances;
begin
  if p_live then
    select * into s from public.superagent_instances where id = p_instance for share;
  else
    select * into s from public.superagent_instances where id = p_instance;
  end if;
  if not found or s.host_installation_id <> i.id or s.workspace_id <> i.workspace_id or s.shared_by <> i.owner_user_id then
    raise exception 'this installation does not host that superagent' using errcode = 'PT403';
  end if;
  if p_live and s.unshared_at is not null then
    raise exception 'that superagent is no longer shared' using errcode = 'PT409';
  end if;
  return s;
end;
$$;

-- Old relay rows: an expired read, a queued command past its time, a receipt past a week.
create function private.superagent_relay_cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from public.superagent_reads where expires_at <= now();
  update public.superagent_commands set state = 'refused', result = 'It expired before its host ran it.', body = null, finished_at = now()
   where state = 'queued' and expires_at <= now();
  delete from public.superagent_commands where finished_at < now() - interval '7 days';
$$;

-- ------------------------------------------------------- host owner RPCs

-- Share a superagent that runs on `p_installation`, or change how it is
-- shared. Only that installation's owner; the host is always that installation.
create function public.superagent_share(
  p_installation uuid, p_name text, p_title text, p_description text default '', p_source jsonb default null,
  p_visibility text default 'private', p_maintainers uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  i public.installations;
  s public.superagent_instances;
begin
  select * into i from public.installations where id = p_installation;
  if not found or i.owner_user_id <> uid or i.revoked_at is not null or not private.is_member(i.workspace_id) then
    raise exception 'only the owner of the machine that runs a superagent can share it' using errcode = 'PT403';
  end if;
  if not ('superagents:host' = any (i.scopes)) then
    raise exception 'turn on superagents:host for this machine first' using errcode = 'PT403';
  end if;
  if p_visibility is null or p_visibility not in ('private', 'workspace') then
    raise exception 'visibility is private or workspace' using errcode = 'PT400';
  end if;
  if not private.valid_superagent_source(p_source) then
    raise exception 'source is {repo: owner/name, path: a relative path, commit: 40 hex digits}' using errcode = 'PT400';
  end if;
  if (select count(*) from public.superagent_instances x where x.host_installation_id = i.id and x.unshared_at is null) >= 50
     and not exists (select 1 from public.superagent_instances x where x.host_installation_id = i.id and x.name = p_name) then
    raise exception 'this machine shares 50 superagents: unshare one first' using errcode = 'PT429';
  end if;
  insert into public.superagent_instances (workspace_id, host_installation_id, shared_by, name, title, description, source, maintainers, visibility)
  values (i.workspace_id, i.id, uid, p_name, coalesce(nullif(trim(p_title), ''), p_name), coalesce(p_description, ''), p_source,
          private.superagent_maintainers(i.workspace_id, uid, p_maintainers), p_visibility)
  on conflict (host_installation_id, name) do update set
    title = excluded.title, description = excluded.description, source = excluded.source,
    maintainers = excluded.maintainers, visibility = excluded.visibility,
    unshared_at = null, revision = public.superagent_instances.revision + 1, updated_at = now()
  returning * into s;
  return private.superagent_view(s, uid);
end;
$$;

-- Change one thing or more; null keeps it. `p_revision`, when given, must be
-- the revision you read, so a change made meanwhile is not replaced.
create function public.superagent_update(
  p_instance uuid, p_revision int default null, p_title text default null, p_description text default null,
  p_source jsonb default null, p_visibility text default null, p_maintainers uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  s public.superagent_instances := private.superagent_owned(p_instance, uid);
begin
  if s.unshared_at is not null then
    raise exception 'it is not shared: share it again from its machine' using errcode = 'PT409';
  end if;
  if p_revision is not null and p_revision <> s.revision then
    raise exception 'it changed since you read it: read it again' using errcode = 'PT409';
  end if;
  if p_visibility is not null and p_visibility not in ('private', 'workspace') then
    raise exception 'visibility is private or workspace' using errcode = 'PT400';
  end if;
  if not private.valid_superagent_source(p_source) then
    raise exception 'source is {repo: owner/name, path: a relative path, commit: 40 hex digits}' using errcode = 'PT400';
  end if;
  update public.superagent_instances set
    title = coalesce(nullif(trim(p_title), ''), title),
    description = coalesce(p_description, description),
    source = coalesce(p_source, source),
    visibility = coalesce(p_visibility, visibility),
    maintainers = case when p_maintainers is null then maintainers else private.superagent_maintainers(workspace_id, uid, p_maintainers) end,
    revision = revision + 1, updated_at = now()
  where id = s.id returning * into s;
  return private.superagent_view(s, uid);
end;
$$;

-- Stop sharing. Reads and queued commands end now. Refused while it holds a
-- claim that is not released: its host gives the claims back first, so no
-- claim stays with an instance that nobody keeps (expiry never frees work).
-- The instance's row is locked (superagent_owned) and its claims too, so a
-- claim made at the same time is either seen here or refused as unshared.
create function public.superagent_unshare(p_instance uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  s public.superagent_instances := private.superagent_owned(p_instance, uid);
  held int;
begin
  select count(*) into held from (
    select 1 from public.superagent_claims c where c.instance_id = s.id and c.state <> 'released' for update
  ) x;
  if held > 0 then
    raise exception 'it holds % claim(s): its host releases them before you unshare it', held using errcode = 'PT409';
  end if;
  update public.superagent_instances set unshared_at = coalesce(unshared_at, now()), updated_at = now()
   where id = s.id returning * into s;
  delete from public.superagent_reads where instance_id = s.id;
  update public.superagent_commands set state = 'refused', result = 'Its host owner stopped sharing it.', body = null, finished_at = now()
   where instance_id = s.id and state = 'queued';
  return private.superagent_view(s, uid);
end;
$$;

-- ----------------------------------------------------------- teammate RPCs

-- The instances of a workspace that you can see.
create function public.superagent_directory(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := private.human();
begin
  if not private.is_member(p_workspace) then
    raise exception 'no such workspace' using errcode = 'PT404';
  end if;
  return coalesce((
    select jsonb_agg(private.superagent_view(s, uid) order by s.title, s.id)
    from public.superagent_instances s
    where s.workspace_id = p_workspace and private.superagent_can_read(s, uid)
  ), '[]'::jsonb);
end;
$$;

-- Ask the host for a page of the chat (`kind` chat, `p_request` the cursor)
-- or of its view (`kind` view, `p_request` {tab}). `p_key`: this browser's
-- ephemeral public key for this read only.
create function public.superagent_read_request(p_id uuid, p_instance uuid, p_kind text, p_request jsonb, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  s public.superagent_instances;
begin
  select * into s from public.superagent_instances where id = p_instance;
  if not found or not private.superagent_can_read(s, uid) then
    raise exception 'no such shared superagent' using errcode = 'PT404';
  end if;
  if not private.superagent_host_ok(s) then
    raise exception 'its host is not connected' using errcode = 'PT409';
  end if;
  if p_kind is null or p_kind not in ('chat', 'view') then
    raise exception 'kind is chat or view' using errcode = 'PT400';
  end if;
  perform pg_advisory_xact_lock(hashtext(uid::text || p_instance::text));
  perform private.superagent_relay_cleanup();
  if (select count(*) from public.superagent_reads q where q.user_id = uid and q.instance_id = s.id) >= 3 then
    raise exception 'three reads of it are open: wait for one to end' using errcode = 'PT429';
  end if;
  insert into public.superagent_reads (id, workspace_id, instance_id, user_id, installation_id, kind, request, client_key)
  values (p_id, s.workspace_id, s.id, uid, s.host_installation_id, p_kind, coalesce(p_request, '{}'::jsonb), p_key);
end;
$$;

-- The host's ephemeral key for your read, while you can still see the
-- instance and its host is still the one you asked. Null until it answers.
create function public.superagent_read_key(p_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  q public.superagent_reads;
  s public.superagent_instances;
begin
  select * into q from public.superagent_reads where id = p_id and user_id = uid and expires_at > now();
  if not found then
    raise exception 'no such read' using errcode = 'PT404';
  end if;
  select * into s from public.superagent_instances where id = q.instance_id;
  if not private.superagent_can_read(s, uid) or s.host_installation_id <> q.installation_id or not private.superagent_host_ok(s) then
    raise exception 'this read is no longer allowed' using errcode = 'PT403';
  end if;
  return q.host_key;
end;
$$;

create function public.superagent_read_done(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.superagent_reads where id = p_id and user_id = private.human();
$$;

create function private.superagent_command_view(c public.superagent_commands, uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'instance_id', c.instance_id, 'kind', c.kind, 'state', c.state, 'result', c.result,
    'expected_session', c.expected_session, 'created_at', c.created_at, 'finished_at', c.finished_at,
    -- The host's key opens a sealed answer, for the sender while they can still see the instance.
    'host_key', case when private.superagent_can_read(s, uid) then c.host_key else null end
  ) from public.superagent_instances s where s.id = c.instance_id;
$$;

create function private.superagent_command(
  p_id uuid, p_instance uuid, p_kind text, p_body jsonb, p_expected text, p_key text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  s public.superagent_instances;
  c public.superagent_commands;
  fp text := private.sha256_hex(jsonb_build_array(p_instance, p_kind, p_body, p_expected)::text);
begin
  select * into s from public.superagent_instances where id = p_instance;
  if not found or not private.superagent_can_read(s, uid) then
    raise exception 'no such shared superagent' using errcode = 'PT404';
  end if;
  if not private.superagent_host_ok(s) then
    raise exception 'its host is not connected' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtext(uid::text || 'superagent-commands'));
  perform private.superagent_relay_cleanup();
  insert into public.superagent_commands (id, workspace_id, instance_id, user_id, installation_id, kind, body, fingerprint, expected_session, client_key)
  values (p_id, s.workspace_id, s.id, uid, s.host_installation_id, p_kind, p_body, fp, p_expected, p_key)
  on conflict (id) do nothing returning * into c;
  if c.id is null then
    select * into c from public.superagent_commands where id = p_id;
    if c.user_id <> uid or c.fingerprint <> fp then
      raise exception 'that request id was already used for something else' using errcode = 'PT409';
    end if;
  elsif (select count(*) from public.superagent_commands x where x.user_id = uid and x.created_at > now() - interval '1 minute') > 30 then
    raise exception 'more than 30 requests in a minute: wait a little' using errcode = 'PT429';
  end if;
  return private.superagent_command_view(c, uid);
end;
$$;

-- Guidance to its main conversation, delivered only into `p_expected_session`
-- (the conversation you saw): a newer one gets nothing.
create function public.superagent_guide(p_id uuid, p_instance uuid, p_text text, p_expected_session text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_text is null or char_length(trim(p_text)) not between 1 and 24000 then
    raise exception 'guidance is 1 to 24000 characters' using errcode = 'PT400';
  end if;
  if p_expected_session is null or p_expected_session !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'name the conversation you saw' using errcode = 'PT400';
  end if;
  return private.superagent_command(p_id, p_instance, 'guide', jsonb_build_object('text', p_text), p_expected_session, null);
end;
$$;

-- An action on its page. `p_key`: this browser's ephemeral key, for the answer.
create function public.superagent_act(p_id uuid, p_instance uuid, p_action text, p_values jsonb, p_tab text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_action is null or p_action !~ '^[A-Za-z0-9_.:-]{1,100}$' then
    raise exception 'an action id is 1 to 100 letters, digits and . _ : -' using errcode = 'PT400';
  end if;
  if p_values is not null and jsonb_typeof(p_values) <> 'object' then
    raise exception 'values is an object' using errcode = 'PT400';
  end if;
  if p_tab is not null and char_length(p_tab) > 100 then
    raise exception 'a tab id is at most 100 characters' using errcode = 'PT400';
  end if;
  return private.superagent_command(p_id, p_instance, 'action',
    jsonb_build_object('action', p_action, 'values', coalesce(p_values, '{}'::jsonb), 'tab', p_tab), null, p_key);
end;
$$;

create function public.superagent_command_receipt(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  c public.superagent_commands;
begin
  select * into c from public.superagent_commands where id = p_id and user_id = uid;
  if not found or not private.is_member(c.workspace_id) then
    raise exception 'no such request' using errcode = 'PT404';
  end if;
  return private.superagent_command_view(c, uid);
end;
$$;

-- Your own choice to be contacted by superagents' GitHub App: in a workspace,
-- for one repo or all ('*'), for one instance or all (null). Saying yes needs
-- the GitHub identity you verified; saying no never does.
create function public.contact_preference(p_workspace uuid, p_repo text, p_instance uuid, p_allowed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.human();
  gh bigint;
  pref public.contact_preferences;
  r text := lower(coalesce(nullif(trim(p_repo), ''), '*'));
begin
  if not private.is_member(p_workspace) then
    raise exception 'no such workspace' using errcode = 'PT404';
  end if;
  if p_allowed is null then
    raise exception 'allowed is true or false' using errcode = 'PT400';
  end if;
  if p_instance is not null and not exists (select 1 from public.superagent_instances s where s.id = p_instance and s.workspace_id = p_workspace) then
    raise exception 'no such shared superagent' using errcode = 'PT404';
  end if;
  gh := private.verified_github_id(uid);
  if gh is null and p_allowed then
    raise exception 'link your own GitHub account first: a typed login is not proof of who you are' using errcode = 'PT403';
  end if;
  insert into public.contact_preferences (workspace_id, user_id, repo, instance_id, allowed, github_user_id)
  values (p_workspace, uid, r, p_instance, p_allowed, gh)
  on conflict (workspace_id, user_id, repo, (coalesce(instance_id, '00000000-0000-0000-0000-000000000000'::uuid))) do update
    set allowed = excluded.allowed, github_user_id = excluded.github_user_id, updated_at = now()
  returning * into pref;
  return to_jsonb(pref);
end;
$$;

-- The numeric GitHub id a person verified: their linked GitHub OAuth identity,
-- or the id the github-session function wrote after GitHub confirmed a token
-- (app_metadata, which only the project's secret key can write). Null for neither.
create function private.verified_github_id(uid uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when ident.provider_id ~ '^[0-9]{1,19}$' then ident.provider_id::bigint end
       from auth.identities ident where ident.user_id = uid and ident.provider = 'github'
       order by ident.created_at limit 1),
    (select case when (u.raw_app_meta_data ->> 'github_id') ~ '^[0-9]{1,19}$' then (u.raw_app_meta_data ->> 'github_id')::bigint end
       from auth.users u where u.id = uid)
  );
$$;

-- ------------------------------------------------------- installation RPCs

-- The superagents this machine shares now.
create function public.inst_superagent_instances(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'superagents:host');
begin
  return coalesce((
    select jsonb_agg(private.superagent_view(s, null) order by s.name)
    from public.superagent_instances s
    where s.host_installation_id = i.id and s.unshared_at is null
  ), '[]'::jsonb);
end;
$$;

-- What teammates asked of this machine: reads not yet answered and commands
-- not yet run, without command bodies (claim one to get its body).
create function public.inst_superagent_pending(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'superagents:host');
begin
  perform private.superagent_relay_cleanup();
  return jsonb_build_object(
    'reads', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'instance_id', q.instance_id, 'name', s.name, 'kind', q.kind,
        'request', q.request, 'client_key', q.client_key) order by q.created_at)
      from (select * from public.superagent_reads where installation_id = i.id and host_key is null and expires_at > now()
            order by created_at limit 20) q
      join public.superagent_instances s on s.id = q.instance_id and s.host_installation_id = i.id
    ), '[]'::jsonb),
    'commands', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'instance_id', c.instance_id, 'name', s.name, 'kind', c.kind,
        'state', c.state, 'expected_session', c.expected_session) order by c.created_at)
      from (select * from public.superagent_commands where installation_id = i.id and state in ('queued', 'attempting')
            order by created_at limit 20) c
      join public.superagent_instances s on s.id = c.instance_id and s.host_installation_id = i.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Give this machine's ephemeral key to a read, checking again that the
-- reader can still see the instance. Called again before each chunk.
create function public.inst_superagent_read_offer(p_secret text, p_id uuid, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q public.superagent_reads;
  s public.superagent_instances;
begin
  select * into q from public.superagent_reads where id = p_id for update;
  if not found then
    raise exception 'no such read' using errcode = 'PT404';
  end if;
  s := private.superagent_hosted(p_secret, q.instance_id, true);
  if q.installation_id <> s.host_installation_id or q.expires_at <= now() or not private.superagent_can_read(s, q.user_id) then
    raise exception 'this read is no longer allowed' using errcode = 'PT403';
  end if;
  if p_key is null or char_length(p_key) not between 80 and 200 or (q.host_key is not null and q.host_key <> p_key) then
    raise exception 'that is not the key this read was answered with' using errcode = 'PT409';
  end if;
  update public.superagent_reads set host_key = p_key where id = q.id;
end;
$$;

create function private.superagent_command_for_host(p_secret text, p_id uuid) returns public.superagent_commands
language plpgsql security definer set search_path = '' as $$
declare
  c public.superagent_commands;
  s public.superagent_instances;
begin
  select * into c from public.superagent_commands where id = p_id for update;
  if not found then
    raise exception 'no such request' using errcode = 'PT404';
  end if;
  s := private.superagent_hosted(p_secret, c.instance_id, true);
  if c.installation_id <> s.host_installation_id then
    raise exception 'that request is for another machine' using errcode = 'PT403';
  end if;
  if not private.superagent_can_read(s, c.user_id) then
    raise exception 'its sender can no longer see this superagent' using errcode = 'PT403';
  end if;
  if c.expires_at <= now() and c.state = 'queued' then
    raise exception 'it expired before its host ran it' using errcode = 'PT409';
  end if;
  return c;
end;
$$;

-- Take a queued command to run it: the body, who sent it, and `p_key`
-- recorded as this machine's key for a sealed answer. Every permission is
-- checked again here. A command already attempting is never handed out
-- again: its host reconciles it from its own receipt.
create function public.inst_superagent_command_claim(p_secret text, p_id uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.superagent_commands := private.superagent_command_for_host(p_secret, p_id);
begin
  if c.state <> 'queued' then
    raise exception 'it is % already', c.state using errcode = 'PT409';
  end if;
  if p_key is not null and char_length(p_key) not between 80 and 200 then
    raise exception 'that is not a key' using errcode = 'PT400';
  end if;
  update public.superagent_commands set state = 'attempting', host_key = p_key where id = c.id returning * into c;
  return jsonb_build_object('id', c.id, 'instance_id', c.instance_id, 'kind', c.kind, 'body', c.body,
    'expected_session', c.expected_session, 'client_key', c.client_key, 'sender', private.person(c.user_id));
end;
$$;

-- The same checks again, right before the host types or acts: a member
-- removed, a visibility narrowed or an unshare since the claim stops it.
create function public.inst_superagent_command_check(p_secret text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.superagent_commands := private.superagent_command_for_host(p_secret, p_id);
begin
  if c.state <> 'attempting' then
    raise exception 'it is %, not being run', c.state using errcode = 'PT409';
  end if;
end;
$$;

-- What happened. The body is deleted here.
create function public.inst_superagent_command_result(p_secret text, p_id uuid, p_state text, p_result text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
  c public.superagent_commands;
begin
  select * into c from public.superagent_commands where id = p_id for update;
  if not found or c.installation_id <> i.id then
    raise exception 'no such request for this machine' using errcode = 'PT404';
  end if;
  if p_state is null or p_state not in ('sent', 'refused', 'failed', 'uncertain') then
    raise exception 'a result is sent, refused, failed or uncertain' using errcode = 'PT400';
  end if;
  update public.superagent_commands set state = p_state, result = left(coalesce(p_result, ''), 1000), body = null, finished_at = now()
   where id = c.id and state in ('queued', 'attempting');
end;
$$;

-- ---------------------------------------------------------------- claims

-- The key the claims service would give a GitHub issue or an environment, so
-- a raw call cannot make a second claim by spelling it another way. Null for
-- any other source: its key is the client's canonical form.
create function private.claim_key(p_source text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  m text[];
begin
  m := regexp_match(p_source, '^env:([^:\s]+):(\S+)$', 'i');
  if m is not null then return 'env:' || lower(m[1]) || ':' || lower(m[2]); end if;
  m := regexp_match(p_source, '^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$');
  if m is not null then return 'github:' || lower(m[1]) || '#' || m[2]; end if;
  m := regexp_match(p_source, '^https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/(issues|pull)/([1-9][0-9]*)/?([?#].*)?$', 'i');
  if m is not null then return 'github:' || lower(m[1] || '/' || m[2]) || '#' || m[4]; end if;
  return null;
end;
$$;

create function private.claim_view(c public.superagent_claims) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'key', c.key, 'source', c.source, 'scope', c.scope, 'fence', c.fence,
    'lease_until', (extract(epoch from c.lease_until) * 1000)::bigint,
    -- Read as uncertain the moment its lease ends, before a renewal writes it.
    'state', case when c.state = 'active' and c.lease_until < now() then 'uncertain' else c.state end,
    'instance_id', c.instance_id, 'instance_name', s.name,
    'host_installation_id', s.host_installation_id,
    'host_name', (select i.name from public.installations i where i.id = s.host_installation_id),
    'session', c.session, 'note', c.note
  ) from public.superagent_instances s where s.id = c.instance_id;
$$;

create function private.claim_event(c public.superagent_claims, p_kind text) returns void
language sql security definer set search_path = '' as $$
  insert into public.superagent_claim_events (workspace_id, scope, key, kind, fence, instance_id, session, note)
  values (c.workspace_id, c.scope, c.key, p_kind, c.fence, c.instance_id, c.session, c.note);
$$;

-- The claim as it is now, held by `s` at `p_fence`; else the refusal the
-- local claims service gives (404 nobody holds it, 409 a stale fence, 403
-- another holder). Locked for the change that follows.
create function private.claim_current(s public.superagent_instances, p_scope text, p_key text, p_fence int) returns public.superagent_claims
language plpgsql security definer set search_path = '' as $$
declare
  c public.superagent_claims;
begin
  select * into c from public.superagent_claims where workspace_id = s.workspace_id and scope = p_scope and key = p_key for update;
  if not found or c.state = 'released' then
    raise exception 'nobody holds %', p_key using errcode = 'PT404';
  end if;
  if c.instance_id <> s.id then
    raise exception 'only the holder of % changes it', p_key using errcode = 'PT403', detail = private.claim_view(c)::text;
  end if;
  if c.fence <> p_fence then
    raise exception 'stale fence for %: %, and it is % now; its holder changed', p_key, p_fence, c.fence
      using errcode = 'PT409', detail = private.claim_view(c)::text;
  end if;
  return c;
end;
$$;

-- Claim every item or none: `p_items` is [{key, source}]. A held key is
-- refused whoever holds it, this instance too.
create function public.inst_superagent_claim_acquire(
  p_secret text, p_instance uuid, p_scope text, p_items jsonb, p_session text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.superagent_instances := private.superagent_hosted(p_secret, p_instance, true);
  item jsonb;
  k text;
  src text;
  canon text;
  c public.superagent_claims;
  out jsonb := '[]'::jsonb;
begin
  if p_scope is null or p_scope not in ('work', 'env') then
    raise exception 'scope is work or env' using errcode = 'PT400';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'give 1 to 50 sources' using errcode = 'PT400';
  end if;
  if p_session is not null and p_session !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'that is not a session id' using errcode = 'PT400';
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    k := item ->> 'key';
    src := item ->> 'source';
    if k is null or src is null or char_length(k) not between 1 and 2048 or char_length(src) not between 1 and 2048 then
      raise exception 'each item is {key, source}' using errcode = 'PT400';
    end if;
    -- An environment is claimed in scope env, and anything else in scope
    -- work: one key never has two holders, one in each scope.
    if (p_scope = 'env') <> (k like 'env:%') then
      raise exception '% is claimed in scope %', k, case when k like 'env:%' then 'env' else 'work' end using errcode = 'PT400';
    end if;
    canon := private.claim_key(src);
    if (canon is not null and canon <> k) or (canon is null and (k like 'github:%' or k like 'env:%')) then
      raise exception '% is not the key of %', k, src using errcode = 'PT400';
    end if;
    insert into public.superagent_claims as x (workspace_id, scope, key, source, fence, state, instance_id, session, note, lease_until)
    values (s.workspace_id, p_scope, k, src, 1, 'active', s.id, p_session, left(p_note, 2000), now() + interval '90 seconds')
    on conflict (workspace_id, scope, key) do update set
      source = excluded.source, fence = x.fence + 1, state = 'active', instance_id = excluded.instance_id,
      session = excluded.session, note = excluded.note, lease_until = excluded.lease_until,
      claimed_at = now(), updated_at = now()
    where x.state = 'released'
    returning * into c;
    if c.key is null then
      select * into c from public.superagent_claims where workspace_id = s.workspace_id and scope = p_scope and key = k;
      raise exception '% is held, %', k, (private.claim_view(c) ->> 'state')
        using errcode = 'PT409', detail = private.claim_view(c)::text;
    end if;
    perform private.claim_event(c, 'claim');
    out := out || jsonb_build_array(private.claim_view(c));
    c := null;
  end loop;
  return out;
end;
$$;

-- The session doing the work: fence + 1, the lease from now.
create function public.inst_superagent_claim_attach(p_secret text, p_instance uuid, p_scope text, p_key text, p_fence int, p_session text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.superagent_instances := private.superagent_hosted(p_secret, p_instance, true);
  c public.superagent_claims := private.claim_current(s, p_scope, p_key, p_fence);
begin
  if p_session is null or p_session !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'that is not a session id' using errcode = 'PT400';
  end if;
  if c.state = 'takeover_requested' then
    raise exception '% is being taken over', p_key using errcode = 'PT409', detail = private.claim_view(c)::text;
  end if;
  update public.superagent_claims set fence = fence + 1, session = p_session, state = 'active',
    lease_until = now() + interval '90 seconds', updated_at = now()
  where workspace_id = c.workspace_id and scope = c.scope and key = c.key returning * into c;
  perform private.claim_event(c, 'attach');
  return private.claim_view(c);
end;
$$;

-- Give it back. Allowed after an unshare too: giving work back is always safe.
create function public.inst_superagent_claim_release(p_secret text, p_instance uuid, p_scope text, p_key text, p_fence int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.superagent_instances := private.superagent_hosted(p_secret, p_instance, false);
  c public.superagent_claims := private.claim_current(s, p_scope, p_key, p_fence);
begin
  update public.superagent_claims set state = 'released', updated_at = now()
  where workspace_id = c.workspace_id and scope = c.scope and key = c.key returning * into c;
  perform private.claim_event(c, 'release');
  return private.claim_view(c);
end;
$$;

-- Mark it takeover_requested; the holder and the fence stay, and it still excludes.
create function public.inst_superagent_claim_takeover_request(p_secret text, p_instance uuid, p_scope text, p_key text, p_fence int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.superagent_instances := private.superagent_hosted(p_secret, p_instance, true);
  c public.superagent_claims := private.claim_current(s, p_scope, p_key, p_fence);
begin
  if c.state <> 'takeover_requested' then
    update public.superagent_claims set state = 'takeover_requested', updated_at = now()
    where workspace_id = c.workspace_id and scope = c.scope and key = c.key returning * into c;
    perform private.claim_event(c, 'takeover_requested');
  end if;
  return private.claim_view(c);
end;
$$;

-- After the host proved the old session stopped (no process, no pane): the
-- new session, fence + 1. Only the host of the holding instance completes it.
create function public.inst_superagent_claim_takeover_complete(p_secret text, p_instance uuid, p_scope text, p_key text, p_fence int, p_session text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.superagent_instances := private.superagent_hosted(p_secret, p_instance, true);
  c public.superagent_claims := private.claim_current(s, p_scope, p_key, p_fence);
begin
  if c.state <> 'takeover_requested' then
    raise exception 'no takeover of % was requested', p_key using errcode = 'PT409';
  end if;
  if p_session is not null and p_session !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'that is not a session id' using errcode = 'PT400';
  end if;
  update public.superagent_claims set fence = fence + 1, state = 'active', session = p_session,
    lease_until = now() + interval '90 seconds', updated_at = now()
  where workspace_id = c.workspace_id and scope = c.scope and key = c.key returning * into c;
  perform private.claim_event(c, 'takeover');
  return private.claim_view(c);
end;
$$;

-- The leases of this machine's claims whose session runs (`p_live`) run on;
-- any other active lease past its end turns uncertain, and still excludes.
create function public.inst_superagent_claim_renew(p_secret text, p_live text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
  c public.superagent_claims;
  n int := 0;
begin
  for c in
    select x.* from public.superagent_claims x
    join public.superagent_instances s on s.id = x.instance_id and s.host_installation_id = i.id
    where x.workspace_id = i.workspace_id and x.state in ('active', 'uncertain')
    for update of x
  loop
    if c.session is not null and c.session = any (coalesce(p_live, '{}')) then
      update public.superagent_claims set state = 'active', lease_until = now() + interval '90 seconds'
      where workspace_id = c.workspace_id and scope = c.scope and key = c.key;
      if c.state = 'uncertain' then perform private.claim_event(c, 'active'); end if;
      n := n + 1;
    elsif c.state = 'active' and c.lease_until < now() then
      update public.superagent_claims set state = 'uncertain', updated_at = now()
      where workspace_id = c.workspace_id and scope = c.scope and key = c.key;
      perform private.claim_event(c, 'uncertain');
    end if;
  end loop;
  return n;
end;
$$;

-- What session `p_from` holds through this machine's instances goes to `p_to`, each with fence + 1.
create function public.inst_superagent_claim_handover(p_secret text, p_from text, p_to text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
  c public.superagent_claims;
  n int := 0;
begin
  if p_to is null or p_to !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'that is not a session id' using errcode = 'PT400';
  end if;
  for c in
    select x.* from public.superagent_claims x
    join public.superagent_instances s on s.id = x.instance_id and s.host_installation_id = i.id
    where x.workspace_id = i.workspace_id and x.session = p_from and x.state <> 'released'
    for update of x
  loop
    update public.superagent_claims set fence = fence + 1, session = p_to,
      state = case when state = 'takeover_requested' then 'active' else state end,
      lease_until = now() + interval '90 seconds', updated_at = now()
    where workspace_id = c.workspace_id and scope = c.scope and key = c.key returning * into c;
    perform private.claim_event(c, 'handover');
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- The workspace's claims, any instance's: who holds what is not a secret
-- between the machines of one workspace.
create function public.inst_superagent_claims(
  p_secret text, p_instance uuid default null, p_session text default null, p_key text default null,
  p_scope text default null, p_released boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, null);
begin
  return coalesce((
    select jsonb_agg(private.claim_view(c) order by c.claimed_at, c.key)
    from public.superagent_claims c
    where c.workspace_id = i.workspace_id
      and (p_released or c.state <> 'released')
      and (p_instance is null or c.instance_id = p_instance)
      and (p_session is null or c.session = p_session)
      and (p_key is null or c.key = p_key)
      and (p_scope is null or c.scope = p_scope)
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- consent

-- For each numeric GitHub id: may the GitHub App contact this person about
-- `p_repo` for `p_instance` (null: a superagent that is not shared)? Only a
-- member who verified that GitHub id and said yes for a scope that covers
-- this one, with no row that says no. Unknown, unlinked or silent: no.
-- Only a host (`superagents:host`) asks: another machine of the workspace
-- learns nothing of who said yes.
create function public.inst_superagent_contact_check(p_secret text, p_instance uuid, p_repo text, p_github_ids bigint[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.installations := private.inst(p_secret, 'superagents:host');
  gid bigint;
  person uuid;
  permits boolean;
  answer jsonb := '[]'::jsonb;
  r text := lower(coalesce(p_repo, ''));
begin
  if p_github_ids is null or cardinality(p_github_ids) > 100 then
    raise exception 'give at most 100 GitHub ids' using errcode = 'PT400';
  end if;
  if r !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' then
    raise exception 'repo is owner/name' using errcode = 'PT400';
  end if;
  if p_instance is not null and not exists (
    select 1 from public.superagent_instances s where s.id = p_instance and s.host_installation_id = i.id
  ) then
    raise exception 'this installation does not host that superagent' using errcode = 'PT403';
  end if;
  foreach gid in array p_github_ids loop
    permits := false;
    select m.user_id into person from public.workspace_members m
     where m.workspace_id = i.workspace_id and private.verified_github_id(m.user_id) = gid
     limit 1;
    if person is not null then
      -- A yes counts only for the GitHub id it was given with; a no counts
      -- whatever id it was given with, or none (said before linking GitHub).
      select coalesce(bool_or(c.allowed and c.github_user_id = gid), false) and not coalesce(bool_or(not c.allowed), false)
        into permits from public.contact_preferences c
       where c.workspace_id = i.workspace_id and c.user_id = person
         and (c.repo = '*' or c.repo = r)
         and (c.instance_id is null or c.instance_id = p_instance);
    end if;
    answer := answer || jsonb_build_array(jsonb_build_object('id', gid, 'allowed', permits));
    person := null;
  end loop;
  return answer;
end;
$$;

-- ------------------------------------------------------------------- RLS

alter table public.superagent_instances enable row level security;
alter table public.superagent_reads enable row level security;
alter table public.superagent_commands enable row level security;
alter table public.superagent_claims enable row level security;
alter table public.superagent_claim_events enable row level security;
alter table public.contact_preferences enable row level security;

create policy "instances you can see" on public.superagent_instances for select to authenticated
  using (private.superagent_can_read(superagent_instances, (select auth.uid())));
-- A claim's note, source and session are its instance's: only a member who
-- can see that instance reads them.
create policy "who sees the instance sees its claims" on public.superagent_claims for select to authenticated
  using (private.superagent_claims_visible(instance_id, (select auth.uid())));
create policy "who sees the instance sees its claim events" on public.superagent_claim_events for select to authenticated
  using (private.superagent_claims_visible(instance_id, (select auth.uid())));
create policy "your own contact preferences" on public.contact_preferences for select to authenticated
  using (user_id = (select auth.uid()));
-- superagent_reads and superagent_commands: no policy, no grant. Only the RPCs touch them.

-- ---------------------------------------------------------------- grants

revoke all on public.superagent_instances, public.superagent_reads, public.superagent_commands,
  public.superagent_claims, public.superagent_claim_events, public.contact_preferences from public, anon, authenticated;
grant select on public.superagent_instances, public.superagent_claims, public.superagent_claim_events,
  public.contact_preferences to authenticated;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname as ns, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'private' and (p.proname like 'superagent\_%' or p.proname like 'claim\_%'
             or p.proname in ('valid_superagent_source', 'verified_github_id', 'check_scopes')))
       or (n.nspname = 'public' and (p.proname like 'superagent\_%' or p.proname like 'inst\_superagent\_%'
             or p.proname = 'contact_preference'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.ns = 'public' then
      if f.proname like 'inst\_%' then
        -- An installation calls with the publishable key and no user session.
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      else
        execute format('grant execute on function %s to authenticated', f.sig);
      end if;
    end if;
  end loop;
end;
$$;
-- The RLS policies call these helpers as the reader.
grant execute on function private.superagent_can_read(public.superagent_instances, uuid) to authenticated;
grant execute on function private.superagent_claims_visible(uuid, uuid) to authenticated;
