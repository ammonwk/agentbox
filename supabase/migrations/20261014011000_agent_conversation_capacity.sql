-- The single coordinator is not a repository writer or deployment holder.
-- Work-item uniqueness and configured worker capacity remain unchanged.
create or replace function public.inst_agent_claim(p_secret text,p_run uuid) returns public.agent_runs
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
  if w.external_key not like 'conversation:%' and (select count(*) from public.agent_runs x join public.agent_work y on y.id=x.work_id where x.agent_id=a.id and y.external_key not like 'conversation:%' and x.state in ('starting','running','waiting','uncertain')) >= coalesce((a.definition->>'maxConcurrent')::int,1) then raise exception 'agent is at its workload limit' using errcode='PT409'; end if;
  if w.external_key not like 'conversation:%' and a.definition->'release' is not null and a.definition->'release'<>'null'::jsonb then
    resource:=lower(a.definition#>>'{release,repo}')||':'||lower(a.definition#>>'{release,environment}');
    insert into public.agent_resources(workspace_id,resource_key,run_id,artifact) values(a.workspace_id,resource,r.id,a.definition#>>'{release,artifact}') on conflict do nothing;
    if not exists(select 1 from public.agent_resources where workspace_id=a.workspace_id and resource_key=resource and run_id=r.id) then raise exception 'the deployment environment already has an active run' using errcode='PT409'; end if;
  end if;
  update public.agent_runs set state='starting',fence=fence+1,lease_until=now()+interval '90 seconds',heartbeat_at=now(),updated_at=now() where id=r.id returning * into r;
  update public.agent_work set stage='in_progress',revision=revision+1,updated_at=now() where id=w.id;
  perform private.agent_event(a,i.owner_user_id,'claimed','Execution lease acquired',w.id,r.id);
  return r;
end $$;

-- Share the proposal's delivery outcome without making queued guidance bodies
-- or other members' private command receipts readable.
alter table public.agent_proposals add column delivery_request uuid references public.agent_commands(id);
create function public.agent_proposals_list(p_agent uuid) returns setof jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; begin
  select * into a from public.shared_agents where id=p_agent;
  if uid is null or not found or not private.is_member(a.workspace_id) then return; end if;
  return query select to_jsonb(p) || case when c.id is null then '{}'::jsonb else jsonb_build_object('delivery',jsonb_build_object('request',c.id,'state',c.state,'result',c.result)) end
    from public.agent_proposals p left join public.agent_commands c on c.id=p.delivery_request
    where p.agent_id=a.id order by p.created_at desc limit 200;
end $$;
revoke all on function public.agent_proposals_list(uuid) from public,anon,authenticated;
grant execute on function public.agent_proposals_list(uuid) to authenticated;

create or replace function public.inst_agent_action_prepare(p_secret text,p_run uuid,p_fence integer,p_id uuid,p_specification jsonb) returns public.agent_actions
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); a public.agent_actions; begin
  if exists(select 1 from public.agent_work where id=r.work_id and external_key like 'conversation:%') then raise exception 'conversation coordinators must queue a scoped work item before proposing repository actions' using errcode='PT403'; end if;
  if p_specification->>'kind' not in ('open_pr','update_pr','ready_pr','merge_pr','close_issue','comment','request_review') or jsonb_typeof(p_specification->'repo') is distinct from 'string' then raise exception 'unsupported managed action' using errcode='PT400'; end if;
  insert into public.agent_actions(id,workspace_id,run_id,agent_id,config_revision,specification) values(p_id,r.workspace_id,r.id,r.agent_id,r.config_revision,p_specification) on conflict do nothing returning * into a;
  if a.id is null then
    select * into a from public.agent_actions where id=p_id;
    if a.run_id<>r.id or a.specification<>p_specification then raise exception 'action ID already used for different work' using errcode='PT409'; end if;
  end if;
  return a;
end $$;

create or replace function public.agent_proposal_decide(p_id uuid,p_decision text,p_request uuid) returns public.agent_proposals
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); p public.agent_proposals; a public.shared_agents; r public.agent_runs; w public.agent_work; begin
 select * into p from public.agent_proposals where id=p_id;
 select * into a from public.shared_agents where id=p.agent_id for update;
 select * into r from public.agent_runs where id=p.run_id;
 select * into w from public.agent_work where id=r.work_id;
 if not private.is_member(a.workspace_id) or (not private.agent_editor(a,uid) and w.assignee is distinct from uid) then raise exception 'only accountable human or maintainer may approve or dismiss' using errcode='PT403'; end if;
 select * into p from public.agent_proposals where id=p_id for update;
 if p_decision not in ('approved','dismissed') or p_decision is null then raise exception 'invalid decision' using errcode='PT400'; end if;
 if p.state=p_decision then return p; end if;
 if p.state<>'open' or a.revision<>p.config_revision or not a.enabled then raise exception 'proposal changed or already decided' using errcode='PT409'; end if;
 if p.action_id is not null then perform public.agent_action_decide(p.action_id,p_decision='approved'); end if;
 if p_decision='approved' then
  perform public.agent_guide(a.id,r.id,p_request,'Approved proposal '||p.id||': '||p.next_step||'. This authorizes only this proposed next step; other actions and outreach retain their existing policy and consent checks.',p.id);
 end if;
 update public.agent_proposals set state=p_decision,decided_by=uid,decided_at=now(),delivery_request=case when p_decision='approved' then p_request else null end where id=p.id returning * into p;
 return p; end $$;

-- Any current member can open Chat on an enabled, authorized agent. This
-- creates only the non-publishing coordinator, never a repository work run.
create or replace function public.agent_conversation_start(p_agent uuid,p_request uuid) returns public.agent_runs
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; r public.agent_runs; w public.agent_work; begin
  select * into a from public.shared_agents where id=p_agent for update;
  if not found or not private.is_member(a.workspace_id) then raise exception 'current workspace membership required' using errcode='PT403'; end if;
  if not a.enabled or a.execution_installation_id is null or not exists(select 1 from public.agent_executor_grants where agent_id=a.id and installation_id=a.execution_installation_id) then raise exception 'configure and enable the execution host first' using errcode='PT409'; end if;
  select x.* into r from public.agent_runs x join public.agent_work y on y.id=x.work_id where x.agent_id=a.id and y.external_key='conversation:'||a.id and x.state in ('queued','starting','running','waiting','uncertain') order by x.created_at desc limit 1;
  if found then
    if r.state='uncertain' or r.config_revision<>a.revision then raise exception 'maintainer must reconcile the previous conversation first' using errcode='PT409'; end if;
    return r;
  end if;
  insert into public.agent_work(workspace_id,agent_id,external_key,source_url,title,acceptance,created_by,assignee)
  values(a.workspace_id,a.id,'conversation:'||a.id,'agentbox:conversation:'||a.id,'Ongoing conversation','Keep context, answer workspace guidance and curate evidence-backed recommendations. Stay available between turns.',uid,uid) on conflict(workspace_id,external_key) do nothing;
  select * into w from public.agent_work where workspace_id=a.workspace_id and external_key='conversation:'||a.id for update;
  if w.control<>'agent' or not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=w.assignee) then raise exception 'maintainer must restore conversation control and accountability first' using errcode='PT409'; end if;
  select * into r from public.agent_runs where id=p_request;
  if found then
    if r.work_id<>w.id or r.requested_by<>uid then raise exception 'request ID belongs to another action' using errcode='PT409'; end if;
    return r;
  end if;
  update public.agent_work set revision=revision+1,updated_at=now() where id=w.id;
  insert into public.agent_runs(id,workspace_id,agent_id,work_id,requested_by,installation_id,config_revision)
    values(p_request,a.workspace_id,a.id,w.id,uid,a.execution_installation_id,a.revision) returning * into r;
  perform private.agent_event(a,uid,'run_requested','Chat queued for the configured execution host',w.id,r.id);
  return r;
end $$;

create or replace function public.inst_agent_command_claim(p_secret text,p_id uuid) returns public.agent_commands language plpgsql security definer set search_path='' as $$
declare c public.agent_commands; r public.agent_runs; begin
 select * into c from public.agent_commands where id=p_id for update;
 select * into r from public.agent_runs where id=c.run_id;
 r:=private.agent_action_run(p_secret,r.id,r.fence);
 if not exists(select 1 from public.workspace_members where workspace_id=c.workspace_id and user_id=c.user_id) or c.expires_at<=now() then raise exception 'sender permission or request expired' using errcode='PT403'; end if;
 if c.state not in ('queued','attempting') then raise exception 'command already completed' using errcode='PT409'; end if;
 if c.state='attempting' and (c.session_id is distinct from r.session_id or c.fence is distinct from r.fence) then raise exception 'delivery target changed; reconcile receipt' using errcode='PT409'; end if;
 update public.agent_commands set state='attempting',session_id=r.session_id,fence=r.fence where id=c.id returning * into c; return c; end $$;

create or replace function public.agent_read_done(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); begin delete from public.agent_reads where id=p_id and user_id=uid; end $$;
