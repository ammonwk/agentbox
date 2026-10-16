-- A configured schedule/event queues work durably, independently of whether
-- an execution slot is free. The creator oversees unassigned intake; explicit
-- per-item assignments always win. It never assigns an inferred expert.
create function public.inst_agent_enqueue(p_secret text,p_work uuid) returns public.agent_runs
language plpgsql security definer set search_path='' as $$
declare i public.installations; a public.shared_agents; w public.agent_work; r public.agent_runs; begin
  select * into w from public.agent_work where id=p_work;
  i:=private.agent_executor(p_secret,w.agent_id);
  select * into a from public.shared_agents where id=w.agent_id for update;
  select * into w from public.agent_work where id=p_work for update;
  if not a.enabled or coalesce(a.definition#>>'{activation,mode}','manual')='manual' then raise exception 'automatic intake execution is not enabled' using errcode='PT409'; end if;
  select * into r from public.agent_runs where work_id=w.id and state in ('queued','starting','running','waiting','uncertain');
  if found then return r; end if;
  -- Completed/handed-over work is never reopened by a repeated source scan.
  if w.control<>'agent' or w.stage not in ('triage','assigned') then raise exception 'intake already processed; a human must request further work' using errcode='PT409'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=coalesce(w.assignee,a.created_by)) then raise exception 'assign a current human overseer before running' using errcode='PT409'; end if;
  update public.agent_work set assignee=coalesce(assignee,a.created_by),revision=revision+1,updated_at=now() where id=w.id returning * into w;
  insert into public.agent_runs(id,workspace_id,agent_id,work_id,requested_by,installation_id,config_revision)
    values(gen_random_uuid(),a.workspace_id,a.id,w.id,w.assignee,i.id,a.revision) returning * into r;
  perform private.agent_event(a,i.owner_user_id,'scheduled','Work queued; assigned human retained',w.id,r.id);
  return r;
end $$;
revoke all on function public.inst_agent_enqueue(text,uuid) from public,anon,authenticated;
grant execute on function public.inst_agent_enqueue(text,uuid) to anon,authenticated;
