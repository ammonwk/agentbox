-- Reject null/stale human draft revisions before accepting a creation.
create or replace function public.agent_creation_edit(p_creator uuid,p_id uuid,p_revision integer,p_spec jsonb,p_create boolean) returns public.agent_creation_drafts
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.human(); d public.agent_creation_drafts; a public.shared_agents; r public.agent_runs; made public.shared_agents; definition jsonb; begin
 select * into d from public.agent_creation_drafts where id=p_id for update;
 select * into a from public.shared_agents where id=d.creator for update;
 if d.id is null or d.creator is distinct from p_creator or not private.is_member(d.workspace_id) or not private.agent_editor(a,uid) then raise exception 'only this creator maintainer may author its draft' using errcode='PT403'; end if;
 if private.valid_creation_spec(p_spec) is not true then raise exception 'invalid creation draft' using errcode='PT400'; end if;
 if d.revision is distinct from p_revision or p_create is null or (p_create and d.spec<>p_spec) then raise exception 'draft changed; save edits before creating' using errcode='PT409'; end if;
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
