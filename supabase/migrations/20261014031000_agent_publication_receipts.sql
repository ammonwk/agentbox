-- Minimal publication proof travels with the existing immutable shared action.
-- No token, transcript, tree contents or second publication queue is stored.
alter table public.agent_actions add column publication jsonb;
create function public.inst_agent_publication_record(p_secret text,p_run uuid,p_fence integer,p_action uuid,p_mapping jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); x public.agent_actions; begin
 select * into x from public.agent_actions where id=p_action and run_id=r.id for update;
 if x.id is null or x.state<>'attempting' or x.specification->>'kind' not in ('open_pr','update_pr') or p_mapping->>'head' is distinct from x.specification->>'head' then raise exception 'publication receipt requires its current attempted action/head' using errcode='PT409'; end if;
 if p_mapping is null or pg_column_size(p_mapping)>1024 or not coalesce((p_mapping->>'base') ~ '^[0-9a-f]{40}$' and (p_mapping->>'head') ~ '^[0-9a-f]{40}$' and (p_mapping->>'tree') ~ '^[0-9a-f]{40}$' and (p_mapping->>'remoteHead') ~ '^[0-9a-f]{40}$',false) then raise exception 'invalid publication proof' using errcode='PT400'; end if;
 if x.publication is not null and x.publication<>p_mapping then raise exception 'publication proof is immutable' using errcode='PT409'; end if;
 update public.agent_actions set publication=p_mapping where id=x.id;
end $$;
create function public.inst_agent_publication_lookup(p_secret text,p_run uuid,p_fence integer,p_head text,p_number integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs:=private.agent_action_run(p_secret,p_run,p_fence); result jsonb; begin
 select x.publication into result from public.agent_actions x join public.agent_runs old on old.id=x.run_id
 where old.work_id=r.work_id and x.workspace_id=r.workspace_id and x.state='sent' and x.publication->>'remoteHead'=p_head
 and right(x.result,length('/pull/'||p_number::text))='/pull/'||p_number::text
 order by x.created_at desc limit 1;
 return result;
end $$;
revoke all on function public.inst_agent_publication_record(text,uuid,integer,uuid,jsonb), public.inst_agent_publication_lookup(text,uuid,integer,text,integer) from public,anon,authenticated;
grant execute on function public.inst_agent_publication_record(text,uuid,integer,uuid,jsonb), public.inst_agent_publication_lookup(text,uuid,integer,text,integer) to anon,authenticated;
