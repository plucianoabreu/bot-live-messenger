-- Durable Hermes artifact delivery and account-cleanup integration.
-- The worker must export files before releasing hermes_workspaces.active_run.

alter table public.artifact_upload_intents
  add column source_kind text not null default 'computer'
  check(source_kind in ('computer','hermes'));

alter table public.hermes_workspaces
  drop constraint hermes_workspaces_user_id_fkey,
  add constraint hermes_workspaces_user_id_fkey foreign key(user_id) references auth.users(id) on delete cascade,
  drop constraint hermes_workspaces_active_run_fkey,
  add constraint hermes_workspaces_active_run_fkey foreign key(active_run) references public.runs(id) on delete set null;

create function public.authorize_hermes_artifact_export(
  p_user_id uuid,p_run_id uuid,p_run_version integer,p_export_path text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; w public.hermes_workspaces%rowtype;
begin
  select * into r from public.runs where id=p_run_id and user_id=p_user_id;
  select * into w from public.hermes_workspaces where user_id=p_user_id;
  if r.id is null or w.user_id is null or r.state<>'RUNNING' or r.execution_version<>p_run_version or r.cancel_requested or
    r.lease_expires_at is null or r.lease_expires_at<=now() or w.active_run is distinct from r.id or w.machine_id is null or
    not coalesce((select runs_enabled from public.runtime_config where singleton),false) then raise exception 'LEASE_LOST'; end if;
  if p_export_path is null or length(p_export_path) not between 20 and 519 or
    p_export_path not like '/workspace/exports/%' or p_export_path like '%//%' or
    p_export_path~'(^|/)\.\.?($|/)' or p_export_path~'[[:cntrl:]\\]' then raise exception 'INVALID_EXPORT_PATH'; end if;
  return jsonb_build_object('machine_id',w.machine_id);
end $$;

create function public.reserve_hermes_artifact_upload(
  p_run_id uuid,p_run_version integer,p_export_path text,p_final_output_key text,p_name text,
  p_object_path text,p_mime_type text,p_size_bytes bigint,p_checksum_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; existing public.artifact_upload_intents%rowtype; result uuid;
begin
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.state<>'RUNNING' or r.execution_version<>p_run_version or r.cancel_requested or
    r.lease_expires_at is null or r.lease_expires_at<=now() or
    not exists(select 1 from public.hermes_workspaces w where w.user_id=r.user_id and w.active_run=r.id and w.machine_id is not null) or
    not coalesce((select runs_enabled from public.runtime_config where singleton),false) then raise exception 'LEASE_LOST'; end if;
  if p_export_path is null or length(p_export_path) not between 20 and 519 or
    p_export_path not like '/workspace/exports/%' or p_export_path like '%//%' or
    p_export_path~'(^|/)\.\.?($|/)' or p_export_path~'[[:cntrl:]\\]' then raise exception 'INVALID_EXPORT_PATH'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text,2));
  if p_final_output_key is null or length(p_final_output_key) not between 1 and 120 or
    p_name is null or length(p_name) not between 1 and 180 or p_name~'[[:cntrl:]]' or
    p_object_path is null or length(p_object_path)>500 or p_object_path not like r.user_id::text||'/'||r.id::text||'/%' or
    p_mime_type is null or length(p_mime_type)>120 or p_mime_type!~'^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$' or
    p_size_bytes not between 1 and 10485760 or p_checksum_sha256!~'^[0-9a-f]{64}$' then raise exception 'INVALID_ARTIFACT'; end if;
  select * into existing from public.artifact_upload_intents where run_id=r.id and final_output_key=p_final_output_key;
  if found then
    if existing.source_kind<>'hermes' or
      (existing.name,existing.object_path,existing.mime_type,existing.size_bytes,existing.checksum_sha256,existing.resource_key) is distinct from
      (p_name,p_object_path,p_mime_type,p_size_bytes,p_checksum_sha256,'file:'||p_export_path) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return existing.id;
  end if;
  if coalesce((select sum(size_bytes) from public.artifacts where user_id=r.user_id and delivered_at is not null),0)+
    coalesce((select sum(size_bytes) from public.artifact_upload_intents where user_id=r.user_id and state in ('PENDING','UPLOADED','CLEANUP_REQUIRED')),0)+p_size_bytes>104857600
    then raise exception 'ARTIFACT_STORAGE_LIMIT'; end if;
  insert into public.artifact_upload_intents(user_id,run_id,run_execution_version,resource_key,fencing_token,
    final_output_key,name,object_path,mime_type,size_bytes,checksum_sha256,source_kind)
    values(r.user_id,r.id,p_run_version,'file:'||p_export_path,0,p_final_output_key,p_name,p_object_path,p_mime_type,p_size_bytes,p_checksum_sha256,'hermes')
    returning id into result;
  return result;
end $$;

create or replace function public.finalize_artifact_upload(p_intent_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent public.artifact_upload_intents%rowtype; r public.runs%rowtype; artifact public.artifacts%rowtype; source_current boolean;
begin
  select * into intent from public.artifact_upload_intents where id=p_intent_id for update;
  if not found then raise exception 'ARTIFACT_INTENT_NOT_FOUND'; end if;
  if intent.state='FINALIZED' then
    select * into artifact from public.artifacts where run_id=intent.run_id and final_output_key=intent.final_output_key;
    return to_jsonb(artifact)-'object_path';
  end if;
  select * into r from public.runs where id=intent.run_id for update;
  if intent.source_kind='hermes' then
    source_current:=exists(select 1 from public.hermes_workspaces w where w.user_id=intent.user_id and w.active_run=intent.run_id and w.machine_id is not null);
  else
    source_current:=exists(select 1 from public.computer_resource_leases l where l.user_id=intent.user_id and l.run_id=intent.run_id and
      l.run_execution_version=intent.run_execution_version and l.resource_key=intent.resource_key and
      l.fencing_token=intent.fencing_token and l.expires_at>now());
  end if;
  if intent.state<>'UPLOADED' or not found or r.state<>'RUNNING' or r.execution_version<>intent.run_execution_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() or not source_current or
    not coalesce((select runs_enabled from public.runtime_config where singleton),false) then raise exception 'LEASE_LOST'; end if;
  insert into public.artifacts(user_id,run_id,name,object_path,mime_type,size_bytes,checksum_sha256,final_output_key,delivered_at)
    values(intent.user_id,intent.run_id,intent.name,intent.object_path,intent.mime_type,intent.size_bytes,intent.checksum_sha256,intent.final_output_key,now())
    returning * into artifact;
  update public.artifact_upload_intents set state='FINALIZED',finished_at=now() where id=intent.id;
  return to_jsonb(artifact)-'object_path';
end $$;

create or replace function public.claim_account_deletion() returns jsonb
language plpgsql security definer set search_path='' as $$
declare request public.account_deletion_requests%rowtype; token uuid:=gen_random_uuid(); artifact_paths jsonb; frame_paths jsonb; providers jsonb;
begin
  select * into request from public.account_deletion_requests
    where completed_at is null and ((state in ('PENDING','FAILED') and next_attempt_at<=now()) or
      (state='CLEANING' and lease_expires_at<=now()))
    order by next_attempt_at,requested_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.account_deletion_requests set state='CLEANING',attempts=attempts+1,
    started_at=coalesce(started_at,now()),claim_token=token,lease_expires_at=now()+interval '5 minutes',last_error_code=null
    where id=request.id;
  select coalesce(jsonb_agg(path order by path),'[]'::jsonb) into artifact_paths from (
    select object_path as path from public.artifacts where user_id=request.user_id
    union select object_path as path from public.artifact_upload_intents where user_id=request.user_id
  ) paths;
  select coalesce(jsonb_agg(object_path order by object_path),'[]'::jsonb) into frame_paths
    from public.watch_frames where user_id=request.user_id;
  select coalesce(jsonb_agg(provider_id order by provider_id),'[]'::jsonb) into providers from (
    select provider_id from public.workspace_computers where user_id=request.user_id and provider_id is not null
    union select machine_id as provider_id from public.hermes_workspaces where user_id=request.user_id and machine_id is not null
  ) targets;
  return jsonb_build_object('request_id',request.id,'user_id',request.user_id,'claim_token',token,
    'artifact_paths',artifact_paths,'watch_paths',frame_paths,'computer_provider_ids',providers,
    'computer_provider_id',providers->>0,
    'artifacts_deleted',request.artifacts_deleted_at is not null,'watch_deleted',request.watch_deleted_at is not null,
    'computer_destroyed',request.computer_destroyed_at is not null,'auth_deleted',request.auth_deleted_at is not null);
end $$;

revoke all on function public.authorize_hermes_artifact_export(uuid,uuid,integer,text),
  public.reserve_hermes_artifact_upload(uuid,integer,text,text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.authorize_hermes_artifact_export(uuid,uuid,integer,text),
  public.reserve_hermes_artifact_upload(uuid,integer,text,text,text,text,text,bigint,text) to service_role;
