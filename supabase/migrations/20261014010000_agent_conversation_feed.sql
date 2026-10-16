-- Durable recommendations and delivery receipts, never a second transcript.
create table public.agent_proposals (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id), agent_id uuid not null references public.shared_agents(id),
 run_id uuid not null references public.agent_runs(id), config_revision integer not null,
 title text not null check(length(title) between 1 and 200), finding text not null check(length(finding) between 1 and 4000),
 reason text not null check(length(reason)<=2000), next_step text not null check(length(next_step) between 1 and 2000),
 evidence jsonb not null default '[]' check(jsonb_typeof(evidence)='array' and jsonb_array_length(evidence)<=20 and pg_column_size(evidence)<=16000),
 action_id uuid unique references public.agent_actions(id), state text not null default 'open' check(state in ('open','approved','dismissed')),
 decided_by uuid, decided_at timestamptz, created_at timestamptz not null default now()
);
alter table public.agent_proposals enable row level security;
revoke all on public.agent_proposals from public,anon,authenticated;
grant select on public.agent_proposals to authenticated;
create policy agent_proposals_read on public.agent_proposals for select to authenticated using(private.is_member(workspace_id));
create table public.agent_commands (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id), agent_id uuid not null references public.shared_agents(id),
 run_id uuid not null references public.agent_runs(id), user_id uuid not null, proposal_id uuid references public.agent_proposals(id),
 body text, fingerprint text not null, state text not null default 'queued' check(state in ('queued','attempting','sent','refused','uncertain')),
 session_id text, fence integer, result text not null default '', created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '1 day'
);
alter table public.agent_commands enable row level security;
revoke all on public.agent_commands from public,anon,authenticated;
-- Bodies are transport, never queryable as a conversation history.
create function public.agent_command_receipt(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); c public.agent_commands; begin
 select * into c from public.agent_commands where id=p_id and user_id=uid;
 if not found or not private.is_member(c.workspace_id) then raise exception 'receipt not found' using errcode='PT404'; end if;
 return to_jsonb(c)-'body'-'fingerprint'; end $$;
create function public.inst_agent_propose(p_secret text,p_run uuid,p_fence integer,p_id uuid,p_proposal jsonb) returns public.agent_proposals
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); p public.agent_proposals; linked uuid:=(p_proposal->>'action')::uuid; begin
 if linked is not null and not exists(select 1 from public.agent_actions where id=linked and run_id=r.id and config_revision=r.config_revision) then raise exception 'action must belong to this run and revision' using errcode='PT403'; end if;
 insert into public.agent_proposals(id,workspace_id,agent_id,run_id,config_revision,title,finding,reason,next_step,evidence,action_id)
 values(p_id,r.workspace_id,r.agent_id,r.id,r.config_revision,p_proposal->>'title',p_proposal->>'finding',coalesce(p_proposal->>'reason',''),p_proposal->>'next',coalesce(p_proposal->'evidence','[]'),linked) on conflict do nothing returning * into p;
 if p.id is null then
  select * into p from public.agent_proposals where id=p_id;
  if p.run_id<>r.id or p.title is distinct from p_proposal->>'title' or p.finding is distinct from p_proposal->>'finding' or p.reason is distinct from coalesce(p_proposal->>'reason','') or p.next_step is distinct from p_proposal->>'next' or p.evidence is distinct from coalesce(p_proposal->'evidence','[]') or p.action_id is distinct from linked then raise exception 'proposal ID already names another immutable recommendation' using errcode='PT409'; end if;
 end if; return p; end $$;
create function public.agent_guide(p_agent uuid,p_run uuid,p_id uuid,p_body text,p_proposal uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; r public.agent_runs; c public.agent_commands; fingerprint text; begin
 select * into a from public.shared_agents where id=p_agent;
 if not found or not private.is_member(a.workspace_id) then raise exception 'current workspace membership required' using errcode='PT403'; end if;
 select * into r from public.agent_runs where id=p_run and agent_id=a.id;
 if not found or not a.enabled or r.config_revision<>a.revision or r.state not in ('queued','starting','running','waiting') then raise exception 'no current conversation; start or resume it first' using errcode='PT409'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 24000 then raise exception 'guidance must be 1 to 24000 characters' using errcode='PT400'; end if;
 if p_proposal is not null and not exists(select 1 from public.agent_proposals where id=p_proposal and agent_id=a.id and run_id=r.id) then raise exception 'proposal not in this conversation' using errcode='PT403'; end if;
 fingerprint:=encode(extensions.digest(convert_to(jsonb_build_array(p_agent,p_run,p_body,p_proposal)::text,'UTF8'),'sha256'),'hex');
 insert into public.agent_commands(id,workspace_id,agent_id,run_id,user_id,body,fingerprint,proposal_id) values(p_id,a.workspace_id,a.id,r.id,uid,p_body,fingerprint,p_proposal) on conflict do nothing returning * into c;
 if c.id is null then select * into c from public.agent_commands where id=p_id; if c.user_id<>uid or c.fingerprint<>fingerprint then raise exception 'submission ID already used' using errcode='PT409'; end if; end if;
 return public.agent_command_receipt(c.id); end $$;
create function public.agent_proposal_decide(p_id uuid,p_decision text,p_request uuid) returns public.agent_proposals
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
 update public.agent_proposals set state=p_decision,decided_by=uid,decided_at=now() where id=p.id returning * into p;
 return p; end $$;
create function public.inst_agent_commands(p_secret text) returns setof public.agent_commands language plpgsql security definer set search_path='' as $$
declare i public.installations:=private.inst(p_secret,'agents:execute'); begin
 update public.agent_commands set body=null,state='refused',result='Expired before delivery' where workspace_id=i.workspace_id and state='queued' and expires_at<=now();
 return query select c.* from public.agent_commands c join public.shared_agents a on a.id=c.agent_id where c.workspace_id=i.workspace_id and a.execution_installation_id=i.id and c.state in ('queued','attempting') order by c.created_at limit 50; end $$;
create function public.inst_agent_command_claim(p_secret text,p_id uuid) returns public.agent_commands language plpgsql security definer set search_path='' as $$
declare c public.agent_commands; r public.agent_runs; a public.shared_agents; begin
 select * into c from public.agent_commands where id=p_id for update;
 select * into r from public.agent_runs where id=c.run_id;
 r:=private.agent_action_run(p_secret,r.id,r.fence);
 if not exists(select 1 from public.workspace_members where workspace_id=c.workspace_id and user_id=c.user_id) or c.expires_at<=now() then raise exception 'sender permission or request expired' using errcode='PT403'; end if;
 if c.state not in ('queued','attempting') then raise exception 'command already completed' using errcode='PT409'; end if;
 if c.state='attempting' and (c.session_id is distinct from r.session_id or c.fence is distinct from r.fence) then raise exception 'delivery target changed; reconcile receipt' using errcode='PT409'; end if;
 update public.agent_commands set state='attempting',session_id=r.session_id,fence=r.fence where id=c.id returning * into c; return c; end $$;
create function public.inst_agent_command_result(p_secret text,p_id uuid,p_state text,p_result text) returns void language plpgsql security definer set search_path='' as $$
declare i public.installations:=private.inst(p_secret,null); c public.agent_commands; r public.agent_runs; begin
 select * into c from public.agent_commands where id=p_id for update; select * into r from public.agent_runs where id=c.run_id;
 if r.installation_id is distinct from i.id or c.workspace_id is distinct from i.workspace_id then raise exception 'wrong execution host' using errcode='PT403'; end if;
 if p_state not in ('sent','refused','uncertain') or p_state is null then raise exception 'invalid receipt' using errcode='PT400'; end if;
 update public.agent_commands set state=p_state,result=left(p_result,1000),body=null where id=c.id and state in ('queued','attempting'); end $$;
-- Relay queue contains only read metadata and ephemeral public keys. Ciphertext
-- travels through Realtime's live HTTP/WebSocket broadcast, never a DB row.
create table public.agent_reads (
 id uuid primary key, agent_id uuid not null references public.shared_agents(id), user_id uuid not null, installation_id uuid not null,
 client_key text not null check(length(client_key) between 80 and 200), host_key text, cursor jsonb not null check(pg_column_size(cursor)<=1000),
 expires_at timestamptz not null default now()+interval '45 seconds', created_at timestamptz not null default now()
);
alter table public.agent_reads enable row level security;
revoke all on public.agent_reads from public,anon,authenticated;
create function public.agent_read_request(p_id uuid,p_agent uuid,p_key text,p_cursor jsonb) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; begin
 select * into a from public.shared_agents where id=p_agent;
 if not found or not private.is_member(a.workspace_id) then raise exception 'current workspace membership required' using errcode='PT403'; end if;
 if a.execution_installation_id is null then raise exception 'execution host not connected' using errcode='PT409'; end if;
 perform pg_advisory_xact_lock(hashtext(uid::text||p_agent::text));
 delete from public.agent_reads where expires_at<=now();
 if (select count(*) from public.agent_reads where user_id=uid and agent_id=p_agent)>1 then raise exception 'another read is in progress' using errcode='PT429'; end if;
 insert into public.agent_reads(id,agent_id,user_id,installation_id,client_key,cursor) values(p_id,a.id,uid,a.execution_installation_id,p_key,p_cursor); end $$;
create function public.agent_read_key(p_id uuid) returns text language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); q public.agent_reads; a public.shared_agents; begin
 select * into q from public.agent_reads where id=p_id and user_id=uid and expires_at>now(); select * into a from public.shared_agents where id=q.agent_id;
 if q.id is null or not private.is_member(a.workspace_id) or a.execution_installation_id is distinct from q.installation_id or not exists(select 1 from public.agent_executor_grants where agent_id=a.id and installation_id=q.installation_id) or not exists(select 1 from public.installations where id=q.installation_id and revoked_at is null) then raise exception 'read no longer authorized' using errcode='PT403'; end if;
 return q.host_key; end $$;
create function public.agent_read_done(p_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin delete from public.agent_reads where id=p_id and user_id=private.human(); end $$;
create function public.inst_agent_reads(p_secret text) returns setof public.agent_reads language plpgsql security definer set search_path='' as $$
declare i public.installations:=private.inst(p_secret,'agents:execute'); begin return query select q.* from public.agent_reads q where q.installation_id=i.id and q.expires_at>now() and q.host_key is null order by q.created_at limit 20; end $$;
create function public.inst_agent_read_offer(p_secret text,p_id uuid,p_key text) returns public.agent_reads language plpgsql security definer set search_path='' as $$
declare q public.agent_reads; i public.installations; a public.shared_agents; begin
 select * into q from public.agent_reads where id=p_id for update;
 i:=private.agent_executor(p_secret,q.agent_id); select * into a from public.shared_agents where id=q.agent_id;
 if q.installation_id<>i.id or q.expires_at<=now() or not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=q.user_id) then raise exception 'read no longer authorized' using errcode='PT403'; end if;
 if length(p_key) not between 80 and 200 or (q.host_key is not null and q.host_key<>p_key) then raise exception 'invalid or replaced host key' using errcode='PT409'; end if;
 update public.agent_reads set host_key=p_key where id=q.id returning * into q; return q; end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig,p.proname n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('agent_command_receipt','inst_agent_propose','agent_guide','agent_proposal_decide','inst_agent_commands','inst_agent_command_claim','inst_agent_command_result','agent_read_request','agent_read_key','agent_read_done','inst_agent_reads','inst_agent_read_offer') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);
 if f.n like 'inst_%' then execute format('grant execute on function %s to anon,authenticated',f.sig); else execute format('grant execute on function %s to authenticated',f.sig); end if;
 end loop; end $$;
create function public.agent_conversation_start(p_agent uuid,p_request uuid) returns public.agent_runs language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; r public.agent_runs; w public.agent_work; begin
 select * into a from public.shared_agents where id=p_agent for update;
 if not private.agent_editor(a,uid) then raise exception 'maintainer must start the conversation' using errcode='PT403'; end if;
 select * into r from public.agent_runs where agent_id=a.id and state in ('queued','starting','running','waiting') order by created_at desc limit 1;
 if found then return r; end if;
 insert into public.agent_work(workspace_id,agent_id,external_key,source_url,title,acceptance,created_by,assignee)
 values(a.workspace_id,a.id,'conversation:'||a.id,'agentbox:conversation:'||a.id,'Ongoing conversation','Keep context, answer workspace guidance and curate evidence-backed recommendations. Stay available between turns.',uid,uid) on conflict(workspace_id,external_key) do nothing;
 select * into w from public.agent_work where workspace_id=a.workspace_id and external_key='conversation:'||a.id;
 return public.agent_request_run(w.id,p_request,w.revision); end $$;
revoke all on function public.agent_conversation_start(uuid,uuid) from public,anon,authenticated;
grant execute on function public.agent_conversation_start(uuid,uuid) to authenticated;
