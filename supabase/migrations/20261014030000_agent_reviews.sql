-- One cumulative review budget per logical work item, independent of sessions
-- and execution hosts. Only scoped host RPCs write operational verdicts.
create table public.agent_review_journals (
 work_id uuid primary key references public.agent_work(id),
 workspace_id uuid not null references public.workspaces(id),
 revision integer not null default 0,
 body jsonb not null default '{"state":"working","rounds":[]}'::jsonb
);
alter table public.agent_review_journals enable row level security;
revoke all on public.agent_review_journals from public,anon,authenticated;
grant select on public.agent_review_journals to authenticated;
create policy review_workspace_read on public.agent_review_journals for select to authenticated using(private.is_member(workspace_id));
create function public.inst_agent_review_load(p_secret text,p_run uuid,p_fence integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); w public.agent_work; j public.agent_review_journals; n text; begin
 select * into w from public.agent_work where id=r.work_id;
 if w.external_key like 'conversation:%' or not exists(select 1 from public.workspace_members where workspace_id=w.workspace_id and user_id=w.assignee) then raise exception 'review requires repository work and a current accountable human' using errcode='PT403'; end if;
 select display_name into n from public.profiles where user_id=w.assignee;
 if coalesce(btrim(n),'')='' then raise exception 'accountable human must set their display name before publication' using errcode='PT409'; end if;
 select * into j from public.agent_review_journals where work_id=w.id;
 return jsonb_build_object('revision',coalesce(j.revision,0),'human',jsonb_build_object('id',w.assignee,'name',n),'body',coalesce(j.body,'{"state":"working","rounds":[]}'::jsonb));
end $$;
create function public.inst_agent_review_save(p_secret text,p_run uuid,p_fence integer,p_revision integer,p_body jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); j public.agent_review_journals; oldn integer; newn integer; k integer; x jsonb; y jsonb; begin
 perform public.inst_agent_review_load(p_secret,p_run,p_fence);
 if p_body is null or pg_column_size(p_body)>524288 or jsonb_typeof(p_body->'rounds') is distinct from 'array' or not coalesce(p_body->>'state' in ('working','quality_failed'),false) then raise exception 'invalid review journal' using errcode='PT400'; end if;
 insert into public.agent_review_journals(work_id,workspace_id) values(r.work_id,r.workspace_id) on conflict do nothing;
 select * into j from public.agent_review_journals where work_id=r.work_id for update;
 if p_revision is distinct from j.revision then raise exception 'review journal changed' using errcode='PT409'; end if;
 if j.body ? 'prepared' and j.body->'prepared' is distinct from p_body->'prepared' then raise exception 'work preparation is immutable' using errcode='PT409'; end if;
 oldn:=jsonb_array_length(j.body->'rounds'); newn:=jsonb_array_length(p_body->'rounds');
 if newn<oldn or newn>oldn+1 or newn>3 or (j.body->>'state'='quality_failed' and p_body<>j.body) then raise exception 'review budget cannot reset or exceed three rounds' using errcode='PT409'; end if;
 for k in 0..oldn-1 loop
  x:=j.body->'rounds'->k; y:=p_body->'rounds'->k;
  if k<newn-1 and x is distinct from y then raise exception 'completed rounds are immutable' using errcode='PT409'; end if;
  if x->'head' is distinct from y->'head' or x->'base' is distinct from y->'base' or x->'context' is distinct from y->'context' or x->'installation' is distinct from y->'installation' then raise exception 'review candidate changed' using errcode='PT409'; end if;
  if exists(select 1 from jsonb_array_elements(x->'reviewers') old where old ? 'verdict' and not exists(select 1 from jsonb_array_elements(y->'reviewers') fresh where fresh->'focus'=old->'focus' and fresh->'session'=old->'session' and fresh->'verdict'=old->'verdict')) then raise exception 'completed verdicts are immutable' using errcode='PT409'; end if;
  if newn>oldn and exists(select 1 from jsonb_array_elements(x->'reviewers') v where not(v ? 'verdict')) then raise exception 'collect existing reviews before another round' using errcode='PT409'; end if;
 end loop;
 if newn>oldn and ((p_body->'rounds'->oldn->>'number')::integer is distinct from newn or p_body->'rounds'->oldn->>'installation' is distinct from r.installation_id::text or jsonb_array_length(p_body->'rounds'->oldn->'reviewers') is distinct from 3) then raise exception 'invalid reserved round' using errcode='PT400'; end if;
 update public.agent_review_journals set body=p_body,revision=revision+1 where work_id=r.work_id returning revision into k;
 return k;
end $$;
revoke all on function public.inst_agent_review_load(text,uuid,integer), public.inst_agent_review_save(text,uuid,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.inst_agent_review_load(text,uuid,integer), public.inst_agent_review_save(text,uuid,integer,integer,jsonb) to anon,authenticated;
