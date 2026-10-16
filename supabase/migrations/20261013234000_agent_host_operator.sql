-- Machine credentials and session capabilities cannot authorize local host
-- setup. The browser presents its current human JWT for this exact host.
create function public.agent_host_operator(p_installation uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); begin
  if not exists(select 1 from public.installations i where i.id=p_installation
    and i.owner_user_id=uid and i.revoked_at is null and private.is_member(i.workspace_id))
  then raise exception 'only the current human installation owner may configure this host' using errcode='PT403'; end if;
  return uid;
end $$;
revoke all on function public.agent_host_operator(uuid) from public,anon,authenticated;
grant execute on function public.agent_host_operator(uuid) to authenticated;

create function public.inst_agent_read_authorize(p_secret text,p_agent uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare i public.installations:=private.agent_executor(p_secret,p_agent); begin return i.id; end $$;
revoke all on function public.inst_agent_read_authorize(text,uuid) from public,anon,authenticated;
grant execute on function public.inst_agent_read_authorize(text,uuid) to anon,authenticated;
