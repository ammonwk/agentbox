-- Reviewable outbound artifacts, not provider conversations. Approval is a
-- signed-in accountable human's decision about one immutable action/head.
create function private.valid_agent_action(spec jsonb) returns boolean
language sql immutable set search_path='' as $fn$
  select extensions.jsonb_matches_schema($schema${"$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"ready_pr"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"number":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"head":{"type":"string","pattern":"^[0-9a-f]{40}$"},"base":{"type":"string","pattern":"^[\\w./-]{1,200}$"}},"required":["kind","repo","number","head","base"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"merge_pr"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"number":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"head":{"type":"string","pattern":"^[0-9a-f]{40}$"},"base":{"type":"string","pattern":"^[\\w./-]{1,200}$"},"method":{"type":"string","enum":["merge","squash","rebase"]}},"required":["kind","repo","number","head","base","method"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"close_issue"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"number":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"pullNumber":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"head":{"type":"string","pattern":"^[0-9a-f]{40}$"},"base":{"type":"string","pattern":"^[\\w./-]{1,200}$"},"verification":{"type":"string","minLength":1,"maxLength":2000},"evidence":{"minItems":1,"maxItems":30,"type":"array","items":{"type":"object","properties":{"url":{"type":"string","maxLength":2000,"pattern":"^https?:"},"label":{"type":"string","minLength":1,"maxLength":160}},"required":["url","label"],"additionalProperties":false}}},"required":["kind","repo","number","pullNumber","head","base","verification","evidence"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"open_pr"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"title":{"type":"string","minLength":1,"maxLength":200},"body":{"type":"string","maxLength":24000},"base":{"type":"string","pattern":"^[\\w./-]{1,200}$"},"head":{"type":"string","pattern":"^[0-9a-f]{40}$"}},"required":["kind","repo","title","body","base","head"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"update_pr"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"number":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"title":{"type":"string","minLength":1,"maxLength":200},"body":{"type":"string","maxLength":24000},"base":{"type":"string","pattern":"^[\\w./-]{1,200}$"},"head":{"type":"string","pattern":"^[0-9a-f]{40}$"},"remoteHead":{"type":"string","pattern":"^[0-9a-f]{40}$"}},"required":["kind","repo","number","title","body","base","head","remoteHead"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"comment"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"number":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"body":{"type":"string","minLength":1,"maxLength":24000}},"required":["kind","repo","number","body"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"request_review"},"repo":{"type":"string","pattern":"^[\\w.-]+\\/[\\w.-]+$"},"number":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"reviewers":{"minItems":1,"maxItems":20,"type":"array","items":{"type":"string","pattern":"^[\\w-]{1,39}$"}}},"required":["kind","repo","number","reviewers"],"additionalProperties":false}]}$schema$::json,spec);
$fn$;

create table public.agent_actions (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id),
  run_id uuid not null references public.agent_runs(id), agent_id uuid not null references public.shared_agents(id),
  config_revision integer not null, specification jsonb not null check(pg_column_size(specification)<=32768 and private.valid_agent_action(specification)),
  state text not null default 'prepared' check(state in ('prepared','approved','attempting','pending','sent','refused','uncertain')),
  decided_by uuid, decided_at timestamptz, result text not null default '' check(char_length(result)<=2000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.agent_actions enable row level security;
revoke all on public.agent_actions from public,anon,authenticated;
grant select on public.agent_actions to authenticated;
create policy actions_workspace_read on public.agent_actions for select to authenticated using(private.is_member(workspace_id));

create function private.agent_action_run(p_secret text,p_run uuid,p_fence integer) returns public.agent_runs
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs; a public.shared_agents; w public.agent_work; i public.installations; begin
  select * into r from public.agent_runs where id=p_run;
  i:=private.agent_executor(p_secret,r.agent_id);
  select * into a from public.shared_agents where id=r.agent_id for update;
  select * into w from public.agent_work where id=r.work_id for update;
  select * into r from public.agent_runs where id=p_run for update;
  if not a.enabled or a.revision<>r.config_revision or r.installation_id<>i.id or r.fence is distinct from p_fence or r.state not in ('running','waiting') or r.lease_until<=now() or w.control<>'agent' then raise exception 'action requires a current authorized writer' using errcode='PT409'; end if;
  return r;
end $$;
create function public.inst_agent_action_prepare(p_secret text,p_run uuid,p_fence integer,p_id uuid,p_specification jsonb) returns public.agent_actions
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); a public.agent_actions; begin
  if p_specification->>'kind' not in ('open_pr','update_pr','ready_pr','merge_pr','close_issue','comment','request_review') or jsonb_typeof(p_specification->'repo') is distinct from 'string' then raise exception 'unsupported managed action' using errcode='PT400'; end if;
  insert into public.agent_actions(id,workspace_id,run_id,agent_id,config_revision,specification) values(p_id,r.workspace_id,r.id,r.agent_id,r.config_revision,p_specification) on conflict do nothing returning * into a;
  if a.id is null then
    select * into a from public.agent_actions where id=p_id;
    if a.run_id<>r.id or a.specification<>p_specification then raise exception 'action ID already used for different work' using errcode='PT409'; end if;
  end if;
  return a;
end $$;
create function public.agent_action_decide(p_action uuid,p_approve boolean) returns public.agent_actions
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); x public.agent_actions; a public.shared_agents; w public.agent_work; r public.agent_runs; begin
  select * into x from public.agent_actions where id=p_action;
  select * into a from public.shared_agents where id=x.agent_id for update;
  select * into r from public.agent_runs where id=x.run_id;
  select * into w from public.agent_work where id=r.work_id for update;
  if not private.agent_editor(a,uid) and not (w.assignee is not distinct from uid and private.is_member(w.workspace_id)) then raise exception 'only the accountable human or maintainer may decide this action' using errcode='PT403'; end if;
  select * into x from public.agent_actions where id=p_action for update;
  if x.state not in ('prepared','approved') then raise exception 'action already dispatched or refused' using errcode='PT409'; end if;
  if not a.enabled or a.revision<>x.config_revision or w.control<>'agent' or r.state not in ('running','waiting') then raise exception 'work changed; prepare a new action' using errcode='PT409'; end if;
  update public.agent_actions set state=case when p_approve then 'approved' else 'refused' end,decided_by=uid,decided_at=now(),updated_at=now() where id=x.id returning * into x;
  perform private.agent_event(a,uid,'action_decision',x.state,w.id,r.id);
  return x;
end $$;
create function public.inst_agent_action_dispatch(p_secret text,p_run uuid,p_fence integer,p_action uuid) returns public.agent_actions
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); x public.agent_actions; a public.shared_agents; required text; begin
  select * into a from public.shared_agents where id=r.agent_id;
  select * into x from public.agent_actions where id=p_action and run_id=r.id for update;
  if not found or x.config_revision<>a.revision then raise exception 'action not found at this revision' using errcode='PT409'; end if;
  required:=case x.specification->>'kind' when 'comment' then 'investigate' when 'merge_pr' then 'merge' when 'close_issue' then 'close_issue' else 'open_pr' end;
  if not coalesce(a.definition->'actions' ? required,false) then raise exception 'action is outside allowed policy' using errcode='PT403'; end if;
  if x.state<>'approved' and not (x.state='prepared' and a.definition->>'approval'='automatic') then raise exception 'this concrete action needs human approval or was already dispatched' using errcode='PT409'; end if;
  -- A removed approver cannot leave a queued permission behind.
  if x.state='approved' and not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=x.decided_by) then raise exception 'approver left the workspace; prepare again' using errcode='PT409'; end if;
  update public.agent_actions set state='attempting',updated_at=now() where id=x.id returning * into x;
  return x;
end $$;
create function public.inst_agent_action_result(p_secret text,p_action uuid,p_state text,p_result text) returns public.agent_actions
language plpgsql security definer set search_path='' as $$
declare i public.installations:=private.inst(p_secret,null); x public.agent_actions; r public.agent_runs; begin
  select * into x from public.agent_actions where id=p_action for update;
  select * into r from public.agent_runs where id=x.run_id;
  if not found or r.installation_id<>i.id or r.workspace_id<>i.workspace_id then raise exception 'action not found' using errcode='PT404'; end if;
  if x.state not in ('attempting','pending','uncertain') or p_state not in ('pending','sent','refused','uncertain') then raise exception 'invalid action result' using errcode='PT409'; end if;
  update public.agent_actions set state=p_state,result=p_result,updated_at=now() where id=x.id returning * into x;
  return x;
end $$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig,n.nspname ns,p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like '%agent_action%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.ns='public' then
      if f.name like 'inst_%' then execute format('grant execute on function %s to anon,authenticated',f.sig);
      else execute format('grant execute on function %s to authenticated',f.sig); end if;
    end if;
  end loop;
end $$;
