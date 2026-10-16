-- Creator is an internal capability, never inferred from an editable name.
alter table public.shared_agents add column capability text check(capability='creator');
alter table public.shared_agents add column creation_parent uuid references public.shared_agents(id);
alter table public.shared_agents add column preferred_provider text check(preferred_provider in ('codex','claude','muse'));
create table public.agent_creation_drafts (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id), creator uuid not null references public.shared_agents(id),
 run uuid not null references public.agent_runs(id), config_revision integer not null, session_id text not null,
 revision integer not null default 1, spec jsonb not null, created uuid references public.shared_agents(id)
);
alter table public.agent_creation_drafts enable row level security;
revoke all on public.agent_creation_drafts from public,anon,authenticated;

create function private.valid_creation_spec(s jsonb) returns boolean language sql immutable set search_path='' as $$
 select pg_column_size(s)<=30000 and extensions.jsonb_matches_schema($schema${"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":80},"role":{"type":"string","minLength":1,"maxLength":120},"instructions":{"type":"string","minLength":1,"maxLength":20000},"provider":{"type":"string","enum":["codex","claude","muse"]},"limits":{"default":"Ask before external actions. Outreach requires explicit recipient opt-in.","type":"string","maxLength":2000},"automation":{"default":"","type":"string","maxLength":1000}},"required":["name","role","instructions","provider","limits","automation"],"additionalProperties":false}$schema$::json,s);
$$;

-- Human explicitly chooses Create agent in the scoped selector. Registration
-- never starts a provider or grants another human's execution installation.
create function public.agent_creator(p_workspace uuid,p_repos jsonb,p_host uuid) returns public.shared_agents
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; d jsonb; begin
 if not private.is_member(p_workspace) then raise exception 'current membership required' using errcode='PT403'; end if;
 d:=jsonb_build_object('role','Create agents from your instructions','instructions','Help the human create agents only. Ask necessary questions and publish editable creation drafts. Do not manage, monitor or start other agents. Manual activation only; explain missing setup. Never request secrets.','repos',p_repos,'activation',jsonb_build_object('mode','manual','when',''),'actions','[]'::jsonb,'approval','prepare');
 if not private.valid_agent_definition(d) then raise exception 'invalid repository scope' using errcode='PT400'; end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace::text||uid::text||p_repos::text));
 select * into a from public.shared_agents where workspace_id=p_workspace and created_by=uid and capability='creator' and definition->'repos'=p_repos order by created_at limit 1;
 if found then return a; end if;
 a:=public.agent_save(p_workspace,null,0,'Jupiter',false,d,array[uid],false,null);
 update public.shared_agents set capability='creator',preferred_provider='codex' where id=a.id returning * into a;
 if p_host is not null then
  perform public.agent_authorize_executor(a.id,p_host,true);
  a:=public.agent_save(p_workspace,a.id,a.revision,a.name,a.team,a.definition,a.maintainers,true,p_host);
 end if;
 return a;
end $$;

create function public.inst_agent_creation_draft(p_secret text,p_run uuid,p_fence integer,p_id uuid,p_spec jsonb) returns public.agent_creation_drafts
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); a public.shared_agents; d public.agent_creation_drafts; begin
 select * into a from public.shared_agents where id=r.agent_id;
 if a.capability is distinct from 'creator' then raise exception 'creator capability required' using errcode='PT403'; end if;
 if not private.valid_creation_spec(p_spec) then raise exception 'invalid creation draft' using errcode='PT400'; end if;
 insert into public.agent_creation_drafts(id,workspace_id,creator,run,config_revision,session_id,spec) values(p_id,a.workspace_id,a.id,r.id,a.revision,r.session_id,p_spec) on conflict do nothing returning * into d;
 if d.id is null then select * into d from public.agent_creation_drafts where id=p_id;
  if d.creator<>a.id or d.run<>r.id or d.session_id is distinct from r.session_id or d.spec<>p_spec then raise exception 'draft ID already used or edited' using errcode='PT409'; end if;
 end if;
 return d;
end $$;
create function public.agent_creation_list(p_creator uuid) returns setof public.agent_creation_drafts
language plpgsql security definer set search_path='' as $$
begin return query select d.* from public.agent_creation_drafts d where creator=p_creator and private.is_member(d.workspace_id) order by id limit 100; end $$;

create function public.agent_creation_edit(p_creator uuid,p_id uuid,p_revision integer,p_spec jsonb,p_create boolean) returns public.agent_creation_drafts
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); d public.agent_creation_drafts; a public.shared_agents; r public.agent_runs; made public.shared_agents; definition jsonb; begin
 select * into d from public.agent_creation_drafts where id=p_id for update;
 select * into a from public.shared_agents where id=d.creator for update;
 if d.id is null or d.creator<>p_creator or not private.is_member(d.workspace_id) or not private.agent_editor(a,uid) then raise exception 'only this creator maintainer may author its draft' using errcode='PT403'; end if;
 if not private.valid_creation_spec(p_spec) then raise exception 'invalid creation draft' using errcode='PT400'; end if;
 if d.revision<>p_revision or (p_create and d.spec<>p_spec) then raise exception 'draft changed; save edits before creating' using errcode='PT409'; end if;
 if d.created is not null then if not p_create then raise exception 'already created' using errcode='PT409'; end if; return d; end if;
 select * into r from public.agent_runs where id=d.run;
 if a.capability is distinct from 'creator' or not a.enabled or a.revision<>d.config_revision or r.session_id is distinct from d.session_id or r.state not in ('running','waiting') or r.config_revision<>a.revision then raise exception 'creator conversation changed; request a new draft' using errcode='PT409'; end if;
 if p_create then
  definition:=jsonb_build_object('role',p_spec->>'role','instructions',(p_spec->>'instructions')||E'\n\nLimits: '||(p_spec->>'limits')||case when p_spec->>'automation'<>'' then E'\nRequested automation (not configured): '||(p_spec->>'automation') else '' end,'repos',a.definition->'repos','activation',jsonb_build_object('mode','manual','when',''),'actions',jsonb_build_array('investigate'),'approval','prepare');
  made:=public.agent_save(a.workspace_id,null,0,p_spec->>'name',a.team,definition,array[uid],false,null);
  update public.shared_agents set creation_parent=a.id,preferred_provider=p_spec->>'provider' where id=made.id returning * into made;
  -- A human may reuse their own already-authorized host. Other members get a
  -- real saved definition with honest host setup required, never implicit grants.
  if exists(select 1 from public.installations where id=a.execution_installation_id and owner_user_id=uid and revoked_at is null and 'agents:execute'=any(scopes)) then
   perform public.agent_authorize_executor(made.id,a.execution_installation_id,true);
   made:=public.agent_save(made.workspace_id,made.id,made.revision,made.name,made.team,made.definition,made.maintainers,true,a.execution_installation_id);
  end if;
  update public.agent_creation_drafts set created=made.id where id=d.id returning * into d;
 else update public.agent_creation_drafts set spec=p_spec,revision=revision+1 where id=d.id returning * into d;
 end if;
 return d;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure sig,p.proname n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('agent_creator','inst_agent_creation_draft','agent_creation_list','agent_creation_edit') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);
 if f.n like 'inst_%' then execute format('grant execute on function %s to anon,authenticated',f.sig); else execute format('grant execute on function %s to authenticated',f.sig); end if;
 end loop;
end $$;
