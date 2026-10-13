-- Contact consent is a human's affirmative choice, bound to their OAuth
-- identity. Expertise and membership confer no right to contact anyone.
create table public.agent_contact_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null default '*' check(repo='*' or repo ~ '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$'),
  agent_id uuid references public.shared_agents(id) on delete cascade,
  allowed boolean not null default false,
  github_user_id text not null, github_login text not null,
  updated_at timestamptz not null default now()
);
create unique index agent_contact_scope on public.agent_contact_preferences(workspace_id,user_id,repo,coalesce(agent_id,'00000000-0000-0000-0000-000000000000'::uuid));
alter table public.agent_contact_preferences enable row level security;
revoke all on public.agent_contact_preferences from public,anon,authenticated;
grant select on public.agent_contact_preferences to authenticated;
create policy contact_workspace_read on public.agent_contact_preferences for select to authenticated using(private.is_member(workspace_id));

create function public.agent_contact_preference(p_workspace uuid,p_repo text,p_agent uuid,p_allowed boolean) returns public.agent_contact_preferences
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); identity auth.identities; pref public.agent_contact_preferences; begin
  if not private.is_member(p_workspace) then raise exception 'workspace not found' using errcode='PT404'; end if;
  if p_agent is not null and not exists(select 1 from public.shared_agents where id=p_agent and workspace_id=p_workspace) then raise exception 'agent not found' using errcode='PT404'; end if;
  select * into identity from auth.identities where user_id=uid and provider='github' limit 1;
  if not found or coalesce(identity.identity_data->>'user_name','')='' then
    -- Removing permission is always possible, even after unlinking GitHub.
    if not p_allowed then
      update public.agent_contact_preferences set allowed=false,updated_at=now() where workspace_id=p_workspace and user_id=uid and repo=lower(p_repo) and agent_id is not distinct from p_agent returning * into pref;
      if pref.id is not null then return pref; end if;
    end if;
    raise exception 'link your own GitHub identity before opting in; an editable profile name is not verification' using errcode='PT403';
  end if;
  insert into public.agent_contact_preferences(workspace_id,user_id,repo,agent_id,allowed,github_user_id,github_login)
    values(p_workspace,uid,lower(p_repo),p_agent,p_allowed,identity.provider_id,lower(identity.identity_data->>'user_name'))
  on conflict(workspace_id,user_id,repo,(coalesce(agent_id,'00000000-0000-0000-0000-000000000000'::uuid))) do update
    set allowed=excluded.allowed,github_user_id=excluded.github_user_id,github_login=excluded.github_login,updated_at=now() returning * into pref;
  return pref;
end $$;

create function public.inst_agent_contact_check(p_secret text,p_agent uuid,p_repo text,p_logins text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.installations:=private.agent_executor(p_secret,p_agent); login text; person uuid; gid text; permits boolean; answer jsonb:='[]'::jsonb; begin
  if cardinality(p_logins)>100 then raise exception 'too many contact recipients' using errcode='PT400'; end if;
  foreach login in array p_logins loop
    person:=null; gid:=null; permits:=false;
    -- Identity must still be linked; an unlink or membership removal revokes
    -- contact immediately. Only OAuth-managed identity data is trusted.
    select m.user_id,ident.provider_id into person,gid from public.workspace_members m join auth.identities ident on ident.user_id=m.user_id and ident.provider='github'
      where m.workspace_id=i.workspace_id and lower(ident.identity_data->>'user_name')=lower(login) limit 1;
    if person is not null then
      select coalesce(bool_and(c.allowed),false) into permits from public.agent_contact_preferences c
      where c.workspace_id=i.workspace_id and c.user_id=person and c.github_user_id=gid and lower(c.github_login)=lower(login)
        and (c.repo='*' or c.repo=lower(p_repo)) and (c.agent_id is null or c.agent_id=p_agent);
    end if;
    answer:=answer||jsonb_build_array(jsonb_build_object('login',login,'user_id',person,'github_user_id',gid,'allowed',permits,
      'reason',case when permits then 'Verified GitHub identity opted in for this scope' else 'No current affirmative consent for this scope; ask through Agentbox' end));
  end loop;
  return answer;
end $$;

create function private.agent_progress(p_work uuid,p_stage text,p_next text,p_outcome text,p_evidence jsonb) returns public.agent_work
language plpgsql security definer set search_path='' as $$
declare w public.agent_work; e jsonb; begin
  if jsonb_typeof(p_evidence) is distinct from 'array' or jsonb_array_length(p_evidence)>30 or pg_column_size(p_evidence)>20000 then raise exception 'evidence must be at most 30 links' using errcode='PT400'; end if;
  for e in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'url') is distinct from 'string' or e->>'url' !~ '^https?://' or char_length(e->>'url')>2000 or jsonb_typeof(e->'label') is distinct from 'string' or char_length(e->>'label') not between 1 and 160 or exists(select 1 from jsonb_object_keys(e) k where k not in ('url','label')) then raise exception 'evidence is a labeled http(s) link, never a transcript or log dump' using errcode='PT400'; end if;
  end loop;
  if p_stage in ('pr_opened','merged','deployed','verified_resolved') and jsonb_array_length(p_evidence)=0 then raise exception 'this outcome needs evidence' using errcode='PT400'; end if;
  if p_stage='verified_resolved' and trim(p_outcome)='' then raise exception 'say how resolution was verified' using errcode='PT400'; end if;
  select * into w from public.agent_work where id=p_work for update;
  -- Progress adds evidence; an omitted array must never erase earlier proof.
  select coalesce(jsonb_agg(link order by ord),'[]') into p_evidence from (
    select distinct on (link->>'url') link,ord
    from jsonb_array_elements(w.evidence || p_evidence) with ordinality as links(link,ord)
    order by link->>'url',ord desc
  ) unique_links;
  if jsonb_array_length(p_evidence)>30 or pg_column_size(p_evidence)>20000 then raise exception 'work evidence exceeds the 30-link limit' using errcode='PT400'; end if;
  update public.agent_work set stage=p_stage,next_action=p_next,outcome=p_outcome,evidence=p_evidence,revision=revision+1,updated_at=now() where id=p_work returning * into w;
  return w;
end $$;
create function public.inst_agent_progress(p_secret text,p_run uuid,p_fence integer,p_stage text,p_next text,p_outcome text,p_evidence jsonb) returns public.agent_work
language plpgsql security definer set search_path='' as $$
declare i public.installations; r public.agent_runs; a public.shared_agents; w public.agent_work; begin
  select * into r from public.agent_runs where id=p_run;
  i:=private.agent_executor(p_secret,r.agent_id);
  select * into a from public.shared_agents where id=r.agent_id for update;
  select * into w from public.agent_work where id=r.work_id for update;
  select * into r from public.agent_runs where id=p_run for update;
  if not a.enabled or a.revision<>r.config_revision or r.installation_id<>i.id or r.fence is distinct from p_fence or r.state not in ('running','waiting') or r.lease_until<=now() or w.control<>'agent' then raise exception 'stale writer cannot publish progress' using errcode='PT409'; end if;
  w:=private.agent_progress(w.id,p_stage,p_next,p_outcome,p_evidence);
  perform private.agent_event(a,i.owner_user_id,'progress',p_stage,w.id,r.id);
  return w;
end $$;
create function public.agent_human_progress(p_work uuid,p_base integer,p_stage text,p_next text,p_outcome text,p_evidence jsonb) returns public.agent_work
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; w public.agent_work; begin
  select * into w from public.agent_work where id=p_work;
  select * into a from public.shared_agents where id=w.agent_id for update;
  if not private.agent_editor(a,uid) and not (w.assignee is not distinct from uid and private.is_member(w.workspace_id)) then raise exception 'only the assignee or maintainer may report a human outcome' using errcode='PT403'; end if;
  select * into w from public.agent_work where id=p_work for update;
  if w.revision is distinct from p_base or w.control<>'human' then raise exception 'take over and wait for the writer to stop first' using errcode='PT409'; end if;
  w:=private.agent_progress(w.id,p_stage,p_next,p_outcome,p_evidence);
  perform private.agent_event(a,uid,'human_progress',p_stage,w.id);
  return w;
end $$;

revoke all on function public.agent_contact_preference(uuid,text,uuid,boolean),public.inst_agent_contact_check(text,uuid,text,text[]),private.agent_progress(uuid,text,text,text,jsonb),public.inst_agent_progress(text,uuid,integer,text,text,text,jsonb),public.agent_human_progress(uuid,integer,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.agent_contact_preference(uuid,text,uuid,boolean),public.agent_human_progress(uuid,integer,text,text,text,jsonb) to authenticated;
grant execute on function public.inst_agent_contact_check(text,uuid,text,text[]),public.inst_agent_progress(text,uuid,integer,text,text,text,jsonb) to anon,authenticated;
