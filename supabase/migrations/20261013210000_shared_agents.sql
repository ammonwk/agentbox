-- Stable shared agents, durable work and fenced execution. No transcripts or credentials.
create extension if not exists pg_jsonschema with schema extensions;

create function private.valid_agent_definition(d jsonb) returns boolean
language sql immutable set search_path = '' as $fn$
  select pg_column_size(d) <= 49152 and extensions.jsonb_matches_schema($schema${"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"role":{"type":"string","minLength":1,"maxLength":120},"instructions":{"type":"string","maxLength":24000},"skills":{"default":[],"maxItems":30,"type":"array","items":{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64},"revision":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["name","revision"],"additionalProperties":false}},"expertise":{"default":[],"maxItems":30,"type":"array","items":{"type":"string","minLength":1,"maxLength":80}},"repos":{"maxItems":30,"type":"array","items":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"}},"sources":{"maxItems":20,"type":"array","items":{"type":"object","properties":{"kind":{"type":"string","enum":["github_issues","manual","observability"]},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"label":{"type":"string","maxLength":80},"reference":{"type":"string","maxLength":500}},"required":["kind"],"additionalProperties":false}},"activation":{"default":{"mode":"manual","when":""},"type":"object","properties":{"mode":{"type":"string","enum":["manual","schedule","event"]},"when":{"default":"","type":"string","maxLength":120}},"required":["mode"],"additionalProperties":false},"actions":{"default":["investigate","edit","open_pr"],"maxItems":5,"type":"array","items":{"type":"string","enum":["investigate","edit","open_pr","merge","close_issue"]}},"approval":{"default":"prepare","type":"string","enum":["prepare","automatic"]},"mergePolicy":{"default":{"requiredChecks":[],"minApprovals":1,"resolution":"verified_resolved"},"type":"object","properties":{"requiredChecks":{"default":[],"maxItems":40,"type":"array","items":{"type":"string","minLength":1,"maxLength":160}},"minApprovals":{"default":1,"type":"integer","minimum":1,"maximum":10},"resolution":{"default":"verified_resolved","type":"string","enum":["merged","deployed","verified_resolved"]}},"additionalProperties":false},"escalation":{"default":"Ask the assigned human through Review when scope, authority or evidence is missing.","type":"string","maxLength":2000},"maxConcurrent":{"default":1,"type":"integer","minimum":1,"maximum":4},"github":{"default":{"kind":"human","login":"","appId":"","installationId":""},"type":"object","properties":{"kind":{"type":"string","enum":["human","app"]},"login":{"default":"","type":"string","maxLength":100},"appId":{"default":"","type":"string","maxLength":80},"installationId":{"default":"","type":"string","maxLength":80}},"required":["kind"],"additionalProperties":false},"release":{"anyOf":[{"type":"object","properties":{"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"environment":{"type":"string","minLength":1,"maxLength":100},"artifact":{"type":"string","minLength":1,"maxLength":200}},"required":["repo","environment","artifact"],"additionalProperties":false},{"type":"null"}]}},"required":["role","instructions"],"additionalProperties":false}$schema$::json, d);
$fn$;

alter table public.installations drop constraint installations_scopes_check;
alter table public.installations add constraint installations_scopes_check check
  (scopes <@ array['messages:send','messages:receive','artifacts:read','artifacts:publish','agents:execute']::text[]);
create or replace function private.check_scopes(p_scopes text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
begin
  if p_scopes is null or not (p_scopes <@ array['messages:send','messages:receive','artifacts:read','artifacts:publish','agents:execute']::text[]) then
    raise exception 'unknown installation scope' using errcode = 'PT400';
  end if;
  return (select coalesce(array_agg(distinct s order by s), '{}') from unnest(p_scopes) s);
end;
$$;

create table public.shared_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  maintainers uuid[] not null check (cardinality(maintainers) between 1 and 30),
  name text not null check (char_length(trim(name)) between 1 and 80),
  team boolean not null default false,
  enabled boolean not null default false,
  revision integer not null default 1,
  definition jsonb not null check (private.valid_agent_definition(definition)),
  execution_installation_id uuid references public.installations(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index shared_agents_workspace on public.shared_agents(workspace_id);
create table public.agent_revisions (
  agent_id uuid not null references public.shared_agents(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  revision integer not null, name text not null, definition jsonb not null,
  changed_by uuid not null, created_at timestamptz not null default now(),
  primary key(agent_id, revision)
);
create table public.agent_executor_grants (
  agent_id uuid not null references public.shared_agents(id) on delete cascade,
  installation_id uuid not null references public.installations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  granted_by uuid not null, granted_at timestamptz not null default now(),
  primary key(agent_id, installation_id)
);
create table public.agent_expertise (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  areas text[] not null default '{}', github_login text not null default '',
  git_emails text[] not null default '{}', paths text[] not null default '{}',
  updated_at timestamptz not null default now(), primary key(workspace_id,user_id),
  check (cardinality(areas)<=30 and cardinality(git_emails)<=10 and cardinality(paths)<=40),
  check (char_length(github_login)<=100 and octet_length(areas::text || git_emails::text || paths::text)<=12000)
);
create table public.agent_work (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.shared_agents(id), external_key text not null,
  source_url text not null check(char_length(source_url)<=2000),
  title text not null check(char_length(title) between 1 and 200),
  acceptance text not null default '' check(char_length(acceptance)<=8000),
  assignee uuid references auth.users(id),
  stage text not null default 'triage' check(stage in ('triage','assigned','in_progress','awaiting_review','pr_opened','merged','deployed','verified_resolved','blocked')),
  control text not null default 'agent' check(control in ('agent','takeover_requested','human')),
  revision integer not null default 1, evidence jsonb not null default '[]',
  outcome text not null default '' check(char_length(outcome)<=4000), next_action text not null default '' check(char_length(next_action)<=1000),
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,external_key)
);
create index agent_work_agent on public.agent_work(agent_id,created_at);
create table public.agent_runs (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.shared_agents(id), work_id uuid not null references public.agent_work(id),
  requested_by uuid not null, installation_id uuid not null references public.installations(id), config_revision integer not null,
  state text not null default 'queued' check(state in ('queued','starting','running','waiting','uncertain','stopped','finished','failed')),
  session_id text check(session_id ~ '^[a-zA-Z0-9_-]{1,64}$'), previous_session_id text,
  fence integer not null default 0, lease_until timestamptz, heartbeat_at timestamptz,
  next_action text not null default '' check(char_length(next_action)<=1000),
  pending_decision text not null default '' check(char_length(pending_decision)<=1000), error text not null default '' check(char_length(error)<=2000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(agent_id,config_revision) references public.agent_revisions(agent_id,revision)
);
-- Uncertainty continues to exclude a second writer. A timeout never frees work.
create unique index agent_work_one_run on public.agent_runs(work_id) where state in ('queued','starting','running','waiting','uncertain');
create index agent_runs_executor on public.agent_runs(installation_id,state);
create table public.agent_resources (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  resource_key text not null, run_id uuid not null references public.agent_runs(id),
  artifact text not null, primary key(workspace_id,resource_key)
);
create table public.agent_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.shared_agents(id), work_id uuid references public.agent_work(id), run_id uuid references public.agent_runs(id),
  kind text not null, actor uuid not null, detail text not null default '' check(char_length(detail)<=2000), at timestamptz not null default now()
);
create index agent_events_workspace on public.agent_events(workspace_id,id desc);

-- Humans can inspect operational data in their workspace. Writes are RPC-only.
do $$ declare t text; begin
  foreach t in array array['shared_agents','agent_revisions','agent_executor_grants','agent_expertise','agent_work','agent_runs','agent_resources','agent_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy workspace_read on public.%I for select to authenticated using (private.is_member(workspace_id))',t);
  end loop;
end $$;

create function private.agent_editor(a public.shared_agents, uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(uid = any(a.maintainers) and exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=uid), false);
$$;
create function private.agent_event(a public.shared_agents, uid uuid, kind text, detail text, work uuid default null, run uuid default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.agent_events(workspace_id,agent_id,actor,kind,detail,work_id,run_id) values(a.workspace_id,a.id,uid,kind,detail,work,run);
$$;

create function public.agent_save(p_workspace uuid, p_id uuid, p_base integer, p_name text, p_team boolean, p_definition jsonb, p_maintainers uuid[], p_enabled boolean, p_executor uuid) returns public.shared_agents
language plpgsql security definer set search_path = '' as $$
declare uid uuid := private.human(); a public.shared_agents; begin
  if not private.is_member(p_workspace) then raise exception 'workspace not found' using errcode='PT404'; end if;
  if not private.valid_agent_definition(p_definition) then raise exception 'invalid agent definition' using errcode='PT400'; end if;
  if p_id is null then
    if p_enabled or p_executor is not null or p_base<>0 then raise exception 'create disabled; configure an executor before enabling' using errcode='PT400'; end if;
    if p_maintainers is distinct from array[uid] then raise exception 'create with yourself as maintainer; add colleagues explicitly later' using errcode='PT403'; end if;
    insert into public.shared_agents(workspace_id,created_by,maintainers,name,team,definition) values(p_workspace,uid,array[uid],p_name,p_team,p_definition) returning * into a;
  else
    select * into a from public.shared_agents where id=p_id and workspace_id=p_workspace for update;
    if not found or not private.agent_editor(a,uid) then raise exception 'only an agent maintainer may edit it' using errcode='PT403'; end if;
    if a.revision is distinct from p_base then raise exception 'configuration changed; reload before saving' using errcode='PT409'; end if;
    if not uid=any(p_maintainers) or exists(select 1 from unnest(p_maintainers) x where not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=x)) then
      raise exception 'maintainers must include you and be workspace members' using errcode='PT400';
    end if;
    if not p_team and cardinality(p_maintainers)<>1 then raise exception 'personal agents have one maintainer' using errcode='PT400'; end if;
    if p_executor is not null and not exists(select 1 from public.agent_executor_grants g join public.installations i on i.id=g.installation_id where g.agent_id=a.id and i.id=p_executor and i.workspace_id=a.workspace_id and i.revoked_at is null and 'agents:execute'=any(i.scopes)) then
      raise exception 'the execution host owner must grant this agent access and enable agents:execute' using errcode='PT403';
    end if;
    if p_enabled and p_executor is null then raise exception 'choose an authorized execution host' using errcode='PT400'; end if;
    if p_executor is distinct from a.execution_installation_id and exists(select 1 from public.agent_runs where agent_id=a.id and state in ('queued','starting','running','waiting','uncertain')) then
      raise exception 'stop and reconcile active work before moving its execution host' using errcode='PT409';
    end if;
    update public.shared_agents set name=p_name,team=p_team,definition=p_definition,maintainers=p_maintainers,enabled=p_enabled,execution_installation_id=p_executor,revision=revision+1,updated_at=now() where id=a.id returning * into a;
  end if;
  insert into public.agent_revisions(agent_id,workspace_id,revision,name,definition,changed_by) values(a.id,a.workspace_id,a.revision,a.name,a.definition,uid);
  perform private.agent_event(a,uid,'configuration','Revision '||a.revision);
  return a;
end $$;

create function public.agent_authorize_executor(p_agent uuid,p_installation uuid,p_allow boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.human(); a public.shared_agents; i public.installations; begin
  select * into a from public.shared_agents where id=p_agent for update;
  if not found or not private.is_member(a.workspace_id) then raise exception 'agent not found' using errcode='PT404'; end if;
  select * into i from public.installations where id=p_installation and workspace_id=a.workspace_id and owner_user_id=uid and revoked_at is null;
  if not found then raise exception 'only the execution host owner may grant its use' using errcode='PT403'; end if;
  if p_allow then
    if not 'agents:execute'=any(i.scopes) then raise exception 'enable agents:execute on this installation first' using errcode='PT403'; end if;
    insert into public.agent_executor_grants(agent_id,installation_id,workspace_id,granted_by) values(a.id,i.id,a.workspace_id,uid) on conflict do nothing;
  else delete from public.agent_executor_grants where agent_id=a.id and installation_id=i.id; end if;
  perform private.agent_event(a,uid,'executor',case when p_allow then 'Execution authorized on ' else 'Execution revoked on ' end || i.name);
end $$;

create function public.agent_set_expertise(p_workspace uuid,p_areas text[],p_login text,p_emails text[],p_paths text[]) returns public.agent_expertise
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.human(); e public.agent_expertise; begin
  if not private.is_member(p_workspace) then raise exception 'workspace not found' using errcode='PT404'; end if;
  insert into public.agent_expertise(workspace_id,user_id,areas,github_login,git_emails,paths) values(p_workspace,uid,p_areas,p_login,p_emails,p_paths)
  on conflict(workspace_id,user_id) do update set areas=excluded.areas,github_login=excluded.github_login,git_emails=excluded.git_emails,paths=excluded.paths,updated_at=now() returning * into e;
  return e;
end $$;

-- Canonicalized here as well as in the client: a raw RPC cannot create a
-- second GitHub claim by changing case, URL fragment or issues/pull spelling.
create function private.agent_source_key(source text) returns text
language plpgsql immutable set search_path = '' as $$
declare m text[]; begin
  if source !~ '^https?://' or source ~ '^https?://[^/]*@' or char_length(source)>2000 then raise exception 'use an http(s) source URL without credentials' using errcode='PT400'; end if;
  m:=regexp_match(source,'^https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/(issues|pull)/([1-9][0-9]*)/?([?#].*)?$','i');
  if m is not null then return 'github:'||lower(m[1]||'/'||m[2])||'#'||m[4]; end if;
  return split_part(source,'#',1);
end $$;
create function private.agent_intake(a public.shared_agents,uid uuid,p_source text,p_title text,p_acceptance text) returns public.agent_work
language plpgsql security definer set search_path = '' as $$
declare w public.agent_work; k text:=private.agent_source_key(p_source); begin
  insert into public.agent_work(workspace_id,agent_id,external_key,source_url,title,acceptance,created_by)
    values(a.workspace_id,a.id,k,p_source,p_title,p_acceptance,uid) on conflict(workspace_id,external_key) do nothing returning * into w;
  if w.id is null then select * into w from public.agent_work where workspace_id=a.workspace_id and external_key=k;
  else perform private.agent_event(a,uid,'intake','Work queued',w.id); end if;
  return w;
end $$;
create function public.agent_intake(p_agent uuid,p_source text,p_title text,p_acceptance text) returns public.agent_work
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.human(); a public.shared_agents; begin
  select * into a from public.shared_agents where id=p_agent;
  if not found or not private.agent_editor(a,uid) then raise exception 'only an agent maintainer may add work' using errcode='PT403'; end if;
  return private.agent_intake(a,uid,p_source,p_title,p_acceptance);
end $$;

create function public.agent_assign(p_work uuid,p_base integer,p_assignee uuid,p_agent uuid) returns public.agent_work
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.human(); a public.shared_agents; target public.shared_agents; w public.agent_work; begin
  select * into w from public.agent_work where id=p_work;
  select * into a from public.shared_agents where id=w.agent_id for update;
  if not private.agent_editor(a,uid) and not (w.assignee is not distinct from uid and private.is_member(w.workspace_id)) then raise exception 'only the assignee or agent maintainer may hand off work' using errcode='PT403'; end if;
  select * into w from public.agent_work where id=p_work for update;
  if w.revision is distinct from p_base then raise exception 'work changed; reload before handoff' using errcode='PT409'; end if;
  if exists(select 1 from public.agent_runs where work_id=w.id and state in ('starting','running','waiting','uncertain')) then raise exception 'stop and reconcile the writer before handoff' using errcode='PT409'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=w.workspace_id and user_id=p_assignee) then raise exception 'assignee must be a workspace member' using errcode='PT400'; end if;
  select * into target from public.shared_agents where id=p_agent and workspace_id=w.workspace_id;
  if not found or not private.agent_editor(target,uid) then raise exception 'the destination agent needs its maintainer to accept the handoff' using errcode='PT403'; end if;
  update public.agent_runs set state='stopped',error='Handed off before execution',updated_at=now() where work_id=w.id and state='queued';
  update public.agent_work set agent_id=p_agent,assignee=p_assignee,stage='assigned',revision=revision+1,updated_at=now() where id=w.id returning * into w;
  perform private.agent_event(a,uid,'handoff','Assigned to '||p_assignee||' through agent '||p_agent,w.id);
  return w;
end $$;

create function public.agent_request_run(p_work uuid,p_request uuid,p_base integer) returns public.agent_runs
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.human(); a public.shared_agents; w public.agent_work; r public.agent_runs; begin
  select * into w from public.agent_work where id=p_work;
  select * into a from public.shared_agents where id=w.agent_id for update;
  if not private.agent_editor(a,uid) then raise exception 'only an agent maintainer may request execution' using errcode='PT403'; end if;
  select * into w from public.agent_work where id=p_work for update;
  select * into r from public.agent_runs where id=p_request;
  if found then
    if r.work_id<>w.id or r.requested_by<>uid then raise exception 'request ID belongs to another action' using errcode='PT409'; end if;
    return r;
  end if;
  if w.revision is distinct from p_base then raise exception 'work changed; reload before running' using errcode='PT409'; end if;
  if not a.enabled or a.execution_installation_id is null then raise exception 'configure and enable the agent first' using errcode='PT409'; end if;
  if w.control='takeover_requested' then raise exception 'wait for the execution host to confirm it stopped' using errcode='PT409'; end if;
  if exists(select 1 from public.agent_runs where work_id=w.id and state in ('queued','starting','running','waiting','uncertain')) then raise exception 'this work already has a run; reconcile it first' using errcode='PT409'; end if;
  if w.assignee is null then
    update public.agent_work set assignee=uid where id=w.id;
  elsif not exists(select 1 from public.workspace_members where workspace_id=w.workspace_id and user_id=w.assignee) then raise exception 'assign an accountable workspace member first' using errcode='PT409'; end if;
  update public.agent_work set control='agent',revision=revision+1,updated_at=now() where id=w.id;
  insert into public.agent_runs(id,workspace_id,agent_id,work_id,requested_by,installation_id,config_revision)
    values(p_request,a.workspace_id,a.id,w.id,uid,a.execution_installation_id,a.revision) returning * into r;
  perform private.agent_event(a,uid,'run_requested','Queued for the configured execution host',w.id,r.id);
  return r;
end $$;

create function public.agent_takeover(p_work uuid,p_base integer) returns public.agent_work
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.human(); a public.shared_agents; w public.agent_work; begin
  select * into w from public.agent_work where id=p_work;
  select * into a from public.shared_agents where id=w.agent_id for update;
  if not private.agent_editor(a,uid) and not (w.assignee is not distinct from uid and private.is_member(w.workspace_id)) then raise exception 'only the assignee or maintainer may take over' using errcode='PT403'; end if;
  select * into w from public.agent_work where id=p_work for update;
  if w.revision is distinct from p_base then raise exception 'work changed; reload before takeover' using errcode='PT409'; end if;
  update public.agent_runs set state='stopped',error='Cancelled before execution',updated_at=now() where work_id=w.id and state='queued';
  update public.agent_work set control=case when exists(select 1 from public.agent_runs where work_id=w.id and state in ('starting','running','waiting','uncertain')) then 'takeover_requested' else 'human' end,revision=revision+1,updated_at=now() where id=w.id returning * into w;
  perform private.agent_event(a,uid,'takeover',w.control,w.id);
  return w;
end $$;

-- The installation must have a separate execution grant, even if its owner
-- can edit the agent. Workspace visibility never authorizes machine control.
create function private.agent_executor(p_secret text,p_agent uuid) returns public.installations
language plpgsql security definer set search_path = '' as $$
declare i public.installations:=private.inst(p_secret,'agents:execute'); a public.shared_agents; begin
  select * into a from public.shared_agents where id=p_agent;
  if not found or a.workspace_id<>i.workspace_id or a.execution_installation_id is distinct from i.id or not exists(select 1 from public.agent_executor_grants where agent_id=a.id and installation_id=i.id) then
    raise exception 'this installation is not authorized to execute the agent' using errcode='PT403';
  end if;
  return i;
end $$;
create function public.inst_agent_intake(p_secret text,p_agent uuid,p_source text,p_title text,p_acceptance text) returns public.agent_work
language plpgsql security definer set search_path = '' as $$
declare i public.installations:=private.agent_executor(p_secret,p_agent); a public.shared_agents; begin
  select * into a from public.shared_agents where id=p_agent;
  if not a.enabled then raise exception 'agent is paused; leave intake pending locally' using errcode='PT409'; end if;
  return private.agent_intake(a,i.owner_user_id,p_source,p_title,p_acceptance);
end $$;

create function public.inst_agent_claim(p_secret text,p_run uuid) returns public.agent_runs
language plpgsql security definer set search_path = '' as $$
declare i public.installations; a public.shared_agents; w public.agent_work; r public.agent_runs; resource text; begin
  select * into r from public.agent_runs where id=p_run;
  i:=private.agent_executor(p_secret,r.agent_id);
  select * into a from public.shared_agents where id=r.agent_id for update;
  select * into w from public.agent_work where id=r.work_id for update;
  select * into r from public.agent_runs where id=p_run for update;
  if r.installation_id<>i.id or r.state<>'queued' or not a.enabled or w.control<>'agent' then raise exception 'run is no longer available' using errcode='PT409'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=w.assignee) then raise exception 'work needs a current human assignee' using errcode='PT409'; end if;
  if r.config_revision<>a.revision then raise exception 'configuration changed; cancel this request and run again' using errcode='PT409'; end if;
  if (select count(*) from public.agent_runs where agent_id=a.id and state in ('starting','running','waiting','uncertain')) >= coalesce((a.definition->>'maxConcurrent')::int,1) then raise exception 'agent is at its workload limit' using errcode='PT409'; end if;
  if a.definition->'release' is not null and a.definition->'release'<>'null'::jsonb then
    resource:=lower(a.definition#>>'{release,repo}')||':'||lower(a.definition#>>'{release,environment}');
    insert into public.agent_resources(workspace_id,resource_key,run_id,artifact) values(a.workspace_id,resource,r.id,a.definition#>>'{release,artifact}') on conflict do nothing;
    if not exists(select 1 from public.agent_resources where workspace_id=a.workspace_id and resource_key=resource and run_id=r.id) then raise exception 'the deployment environment already has an active run' using errcode='PT409'; end if;
  end if;
  update public.agent_runs set state='starting',fence=fence+1,lease_until=now()+interval '90 seconds',heartbeat_at=now(),updated_at=now() where id=r.id returning * into r;
  update public.agent_work set stage='in_progress',revision=revision+1,updated_at=now() where id=w.id;
  perform private.agent_event(a,i.owner_user_id,'claimed','Execution lease acquired',w.id,r.id);
  return r;
end $$;

create function public.inst_agent_report(p_secret text,p_run uuid,p_fence integer,p_state text,p_session text,p_next text,p_decision text,p_error text) returns public.agent_runs
language plpgsql security definer set search_path = '' as $$
declare i public.installations:=private.inst(p_secret,null); a public.shared_agents; w public.agent_work; r public.agent_runs; oldstate text; begin
  select * into r from public.agent_runs where id=p_run;
  if not found or r.installation_id<>i.id or r.workspace_id<>i.workspace_id then raise exception 'run not found' using errcode='PT404'; end if;
  select * into a from public.shared_agents where id=r.agent_id for update;
  select * into w from public.agent_work where id=r.work_id for update;
  select * into r from public.agent_runs where id=p_run for update;
  if r.fence is distinct from p_fence or r.state not in ('starting','running','waiting','uncertain') then raise exception 'stale execution lease' using errcode='PT409'; end if;
  -- A revoked executor may still acknowledge that its writer was stopped.
  if p_state not in ('stopped','failed') then
    perform private.agent_executor(p_secret,r.agent_id);
    if r.lease_until<=now() or r.state='uncertain' then raise exception 'expired lease: stop the old session before reconciliation' using errcode='PT409'; end if;
    if not a.enabled or r.config_revision<>a.revision then raise exception 'agent paused or configuration changed; stop and request a new run' using errcode='PT409'; end if;
    if w.control<>'agent' then raise exception 'human takeover requested: stop the session first' using errcode='PT409'; end if;
  end if;
  if p_state not in ('running','waiting','stopped','finished','failed') then raise exception 'invalid execution state' using errcode='PT400'; end if;
  if r.session_id is not null and p_session is distinct from r.session_id then raise exception 'use the rotation operation to replace a session' using errcode='PT409'; end if;
  if p_state in ('running','waiting') and p_session is null then raise exception 'a running agent must name its session' using errcode='PT400'; end if;
  oldstate:=r.state;
  update public.agent_runs set state=p_state,session_id=p_session,heartbeat_at=now(),lease_until=case when p_state in ('running','waiting') then now()+interval '90 seconds' else null end,next_action=p_next,pending_decision=p_decision,error=p_error,updated_at=now() where id=r.id returning * into r;
  if p_state in ('stopped','finished','failed') then
    delete from public.agent_resources where run_id=r.id;
    update public.agent_work set control=case when control='takeover_requested' then 'human' else control end,revision=revision+1,updated_at=now() where id=w.id;
  end if;
  if oldstate<>p_state then perform private.agent_event(a,i.owner_user_id,'execution',p_state,w.id,r.id); end if;
  return r;
end $$;

-- A replacement is attached only after the old process has stopped. The
-- runtime proves that locally and transfers waits/cards/PR claims with Fleet.
create function public.inst_agent_rotate(p_secret text,p_run uuid,p_fence integer,p_previous text,p_session text) returns public.agent_runs
language plpgsql security definer set search_path = '' as $$
declare i public.installations; r public.agent_runs; a public.shared_agents; w public.agent_work; begin
  select * into r from public.agent_runs where id=p_run;
  i:=private.agent_executor(p_secret,r.agent_id);
  select * into a from public.shared_agents where id=r.agent_id for update;
  select * into w from public.agent_work where id=r.work_id for update;
  select * into r from public.agent_runs where id=p_run for update;
  if not a.enabled or r.config_revision<>a.revision or w.control<>'agent' or p_session is null or p_session is not distinct from p_previous or r.installation_id<>i.id or r.fence is distinct from p_fence or r.session_id is distinct from p_previous or r.state not in ('running','waiting') or r.lease_until<=now() then raise exception 'stale session rotation' using errcode='PT409'; end if;
  update public.agent_runs set previous_session_id=session_id,session_id=p_session,fence=fence+1,updated_at=now() where id=r.id returning * into r;
  perform private.agent_event(a,i.owner_user_id,'rotation',p_previous||' → '||p_session,w.id,r.id);
  return r;
end $$;

create function private.agent_board(ws uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'agents',coalesce((select jsonb_agg(a order by a.created_at) from public.shared_agents a where a.workspace_id=ws),'[]'),
    'work',coalesce((select jsonb_agg(w order by w.created_at desc) from (select * from public.agent_work where workspace_id=ws and (stage<>'verified_resolved' or id in(select work_id from public.agent_runs where workspace_id=ws and state in ('queued','starting','running','waiting','uncertain')) or id in(select id from public.agent_work where workspace_id=ws order by created_at desc limit 500)) order by created_at desc) w),'[]'),
    'runs',coalesce((select jsonb_agg(r order by r.created_at desc) from (select * from public.agent_runs where workspace_id=ws and (state in ('queued','starting','running','waiting','uncertain') or id in(select id from public.agent_runs where workspace_id=ws order by created_at desc limit 500)) order by created_at desc) r),'[]'),
    'expertise',coalesce((select jsonb_agg(e) from public.agent_expertise e join public.workspace_members m using(workspace_id,user_id) where e.workspace_id=ws),'[]'),
    'events',coalesce((select jsonb_agg(e order by e.id desc) from (select * from public.agent_events where workspace_id=ws order by id desc limit 100) e),'[]')
  );
$$;
create function public.agents_board(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.human();
  if not private.is_member(p_workspace) then raise exception 'workspace not found' using errcode='PT404'; end if;
  return private.agent_board(p_workspace);
end $$;
create function public.inst_agents_board(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.installations:=private.inst(p_secret,'agents:execute'); begin
  update public.agent_runs set state='uncertain',error='Heartbeat expired; reconcile the previous writer before taking over',updated_at=now()
    where workspace_id=i.workspace_id and state in ('starting','running','waiting') and lease_until<=now();
  return private.agent_board(i.workspace_id);
end $$;

-- No default privilege can expose a helper or a new mutator.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig,n.nspname ns,p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
    (n.nspname='private' and (p.proname like 'agent_%' or p.proname='valid_agent_definition')) or
    (n.nspname='public' and (p.proname like 'agent_%' or p.proname='agents_board' or p.proname like 'inst_agent%')) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.ns='public' then
      if f.name like 'inst_%' then execute format('grant execute on function %s to anon,authenticated',f.sig);
      else execute format('grant execute on function %s to authenticated',f.sig); end if;
    end if;
  end loop;
end $$;
