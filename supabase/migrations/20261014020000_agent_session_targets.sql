-- Bind guidance at enqueue time, including Feed approvals. Rotation cannot
-- silently retarget a queued message. Pre-migration undelivered commands fail
-- closed because they carry no proof of the conversation the human selected.
alter table public.agent_commands add column expected_session text;
alter table public.agent_commands add column expected_fence integer;
create or replace function public.agent_guide(p_agent uuid,p_run uuid,p_id uuid,p_body text,p_proposal uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); a public.shared_agents; r public.agent_runs; c public.agent_commands; fingerprint text; begin
 select * into a from public.shared_agents where id=p_agent;
 if not found or not private.is_member(a.workspace_id) then raise exception 'current workspace membership required' using errcode='PT403'; end if;
 select * into r from public.agent_runs where id=p_run and agent_id=a.id for update;
 if not found or not a.enabled or r.config_revision<>a.revision or r.state not in ('queued','starting','running','waiting') then raise exception 'no current conversation; start or resume it first' using errcode='PT409'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 24000 then raise exception 'guidance must be 1 to 24000 characters' using errcode='PT400'; end if;
 if p_proposal is not null and not exists(select 1 from public.agent_proposals where id=p_proposal and agent_id=a.id and run_id=r.id) then raise exception 'proposal not in this conversation' using errcode='PT403'; end if;
 fingerprint:=encode(extensions.digest(convert_to(jsonb_build_array(p_agent,p_run,p_body,p_proposal)::text,'UTF8'),'sha256'),'hex');
 insert into public.agent_commands(id,workspace_id,agent_id,run_id,user_id,body,fingerprint,proposal_id,expected_session,expected_fence) values(p_id,a.workspace_id,a.id,r.id,uid,p_body,fingerprint,p_proposal,r.session_id,r.fence) on conflict do nothing returning * into c;
 if c.id is null then select * into c from public.agent_commands where id=p_id; if c.user_id<>uid or c.fingerprint<>fingerprint then raise exception 'submission ID already used' using errcode='PT409'; end if; end if;
 return public.agent_command_receipt(c.id); end $$;

create function public.agent_session_guide(p_agent uuid,p_run uuid,p_id uuid,p_body text,p_proposal uuid,p_session text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.shared_agents; r public.agent_runs; begin
 select * into a from public.shared_agents where id=p_agent;
 if not found or not private.is_member(a.workspace_id) then raise exception 'current workspace membership required' using errcode='PT403'; end if;
 select * into r from public.agent_runs where id=p_run and agent_id=a.id for update;
 if not found or r.session_id is distinct from p_session then raise exception 'selected session is no longer current' using errcode='PT409'; end if;
 return public.agent_guide(p_agent,p_run,p_id,p_body,p_proposal);
end $$;
revoke all on function public.agent_session_guide(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.agent_session_guide(uuid,uuid,uuid,text,uuid,text) to authenticated;
create or replace function public.inst_agent_command_claim(p_secret text,p_id uuid) returns public.agent_commands language plpgsql security definer set search_path='' as $$
declare c public.agent_commands; r public.agent_runs; begin
 select * into c from public.agent_commands where id=p_id for update;
 select * into r from public.agent_runs where id=c.run_id;
 r:=private.agent_action_run(p_secret,r.id,r.fence);
 if not exists(select 1 from public.workspace_members where workspace_id=c.workspace_id and user_id=c.user_id) or c.expires_at<=now() then raise exception 'sender permission or request expired' using errcode='PT403'; end if;
 if c.expected_fence is null or (c.expected_session is not null and (c.expected_session is distinct from r.session_id or c.expected_fence is distinct from r.fence)) or (c.expected_session is null and (r.previous_session_id is not null or r.fence not between c.expected_fence and c.expected_fence+1)) then raise exception 'selected conversation was replaced; no delivery to successor' using errcode='PT409'; end if;
 if c.state not in ('queued','attempting') then raise exception 'command already completed' using errcode='PT409'; end if;
 if c.state='attempting' and (c.session_id is distinct from r.session_id or c.fence is distinct from r.fence) then raise exception 'delivery target changed; reconcile receipt' using errcode='PT409'; end if;
 update public.agent_commands set state='attempting',session_id=r.session_id,fence=r.fence where id=c.id returning * into c; return c; end $$;
