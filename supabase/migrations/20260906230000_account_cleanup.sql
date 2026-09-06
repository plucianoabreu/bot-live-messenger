-- Account deletion must not be blocked by provider accounting rows.
alter table public.model_calls
  drop constraint model_calls_run_id_fkey,
  add constraint model_calls_run_id_fkey
    foreign key (run_id) references public.runs(id) on delete cascade;

-- Keep the cleanup ledger after auth.users is removed. The user UUID is erased
-- at completion; the remaining request ID, timestamps and bounded error codes
-- are service-only evidence that async cleanup finished.
create table public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique,
  state text not null default 'PENDING' check(state in ('PENDING','CLEANING','FAILED','COMPLETED')),
  attempts integer not null default 0 check(attempts>=0),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claim_token uuid,
  completed_at timestamptz,
  artifacts_deleted_at timestamptz,
  watch_deleted_at timestamptz,
  computer_destroyed_at timestamptz,
  auth_deleted_at timestamptz,
  last_error_code text check(last_error_code is null or last_error_code in (
    'ARTIFACT_CLEANUP_FAILED','WATCH_CLEANUP_FAILED','COMPUTER_CLEANUP_FAILED',
    'AUTH_DELETE_FAILED','FINALIZATION_FAILED','UNKNOWN_CLEANUP_FAILURE'
  )),
  check((state='COMPLETED' and completed_at is not null and claim_token is null and lease_expires_at is null and user_id is null) or
    (state<>'COMPLETED' and completed_at is null and user_id is not null))
);
create index account_deletion_retry on public.account_deletion_requests(state,next_attempt_at,lease_expires_at);
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public,anon,authenticated;
grant select on public.account_deletion_requests to service_role;

-- A still-valid access token cannot admit fresh work after deletion starts.
create function public.reject_run_for_deleting_account() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.account_deletion_requests d
    where d.user_id=new.user_id and d.state<>'COMPLETED') then
    raise exception 'ACCOUNT_DELETION_PENDING';
  end if;
  return new;
end $$;
create trigger reject_run_for_deleting_account_before_insert before insert on public.runs
for each row execute function public.reject_run_for_deleting_account();

create function public.request_account_deletion(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=p_user_id; request public.account_deletion_requests%rowtype;
begin
  if uid is null then raise exception 'INVALID_ACCOUNT'; end if;
  if not exists(select 1 from auth.users where id=uid) then raise exception 'UNAUTHENTICATED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,21));
  select * into request from public.account_deletion_requests where user_id=uid for update;
  if found then
    return jsonb_build_object('id',request.id,'state',request.state,'requested_at',request.requested_at);
  end if;

  insert into public.account_deletion_requests(user_id) values(uid) returning * into request;

  -- Workers check cancel_requested before each provider action. Marking the
  -- durable run cancelled also prevents a late provider response from being
  -- persisted as success; the cleanup request does not claim the provider
  -- stopped synchronously.
  update public.runs set cancel_requested=true,state='CANCELLED',finished_at=coalesce(finished_at,now()),lease_expires_at=null
    where user_id=uid and state in ('QUEUED','RUNNING','WAITING_FOR_USER');
  delete from public.computer_resource_leases where user_id=uid;
  update public.watch_leases set closed_at=coalesce(closed_at,now()),expires_at=least(expires_at,now()) where user_id=uid;
  update public.workspace_computers set state='DESTROYING',execution_version=execution_version+1
    where user_id=uid and provider_id is not null and state<>'DESTROYED';

  return jsonb_build_object('id',request.id,'state',request.state,'requested_at',request.requested_at);
end $$;

create function public.get_account_deletion_request() returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); request public.account_deletion_requests%rowtype;
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into request from public.account_deletion_requests where user_id=uid;
  if not found then return null; end if;
  return jsonb_build_object('id',request.id,'state',request.state,'requested_at',request.requested_at);
end $$;

create function public.claim_account_deletion() returns jsonb
language plpgsql security definer set search_path='' as $$
declare request public.account_deletion_requests%rowtype; token uuid:=gen_random_uuid(); artifact_paths jsonb; frame_paths jsonb; provider text;
begin
  select * into request from public.account_deletion_requests
    where completed_at is null and (
      (state in ('PENDING','FAILED') and next_attempt_at<=now()) or
      (state='CLEANING' and lease_expires_at<=now())
    )
    order by next_attempt_at,requested_at for update skip locked limit 1;
  if not found then return null; end if;

  update public.account_deletion_requests set state='CLEANING',attempts=attempts+1,
    started_at=coalesce(started_at,now()),claim_token=token,lease_expires_at=now()+interval '5 minutes',last_error_code=null
    where id=request.id;
  select coalesce(jsonb_agg(path order by path),'[]'::jsonb) into artifact_paths from (
    select object_path as path from public.artifacts where user_id=request.user_id
    union
    select object_path as path from public.artifact_upload_intents where user_id=request.user_id
  ) paths;
  select coalesce(jsonb_agg(object_path order by object_path),'[]'::jsonb) into frame_paths
    from public.watch_frames where user_id=request.user_id;
  select provider_id into provider from public.workspace_computers where user_id=request.user_id;
  return jsonb_build_object('request_id',request.id,'user_id',request.user_id,'claim_token',token,
    'artifact_paths',artifact_paths,'watch_paths',frame_paths,'computer_provider_id',provider,
    'artifacts_deleted',request.artifacts_deleted_at is not null,
    'watch_deleted',request.watch_deleted_at is not null,
    'computer_destroyed',request.computer_destroyed_at is not null,
    'auth_deleted',request.auth_deleted_at is not null);
end $$;

create function public.renew_account_deletion_claim(p_claim_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.account_deletion_requests set lease_expires_at=now()+interval '5 minutes'
    where claim_token=p_claim_token and state='CLEANING' and lease_expires_at>now();
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create function public.record_account_deletion_stage(p_claim_token uuid,p_stage text) returns boolean
language plpgsql security definer set search_path='' as $$
declare request public.account_deletion_requests%rowtype;
begin
  select * into request from public.account_deletion_requests
    where claim_token=p_claim_token and state='CLEANING' and lease_expires_at>now() for update;
  if not found then return false; end if;
  if p_stage='ARTIFACTS_DELETED' then
    update public.account_deletion_requests set artifacts_deleted_at=coalesce(artifacts_deleted_at,now()) where id=request.id;
  elsif p_stage='WATCH_DELETED' and request.artifacts_deleted_at is not null then
    update public.account_deletion_requests set watch_deleted_at=coalesce(watch_deleted_at,now()) where id=request.id;
  elsif p_stage='COMPUTER_DESTROYED' and request.artifacts_deleted_at is not null and request.watch_deleted_at is not null then
    update public.account_deletion_requests set computer_destroyed_at=coalesce(computer_destroyed_at,now()) where id=request.id;
  elsif p_stage='AUTH_DELETED' and request.artifacts_deleted_at is not null and request.watch_deleted_at is not null and
    request.computer_destroyed_at is not null and not exists(select 1 from auth.users where id=request.user_id) then
    update public.account_deletion_requests set auth_deleted_at=coalesce(auth_deleted_at,now()) where id=request.id;
  else
    return false;
  end if;
  return true;
end $$;

create function public.finish_account_deletion(p_claim_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.account_deletion_requests d set state='COMPLETED',completed_at=now(),user_id=null,claim_token=null,
    lease_expires_at=null,next_attempt_at=now(),last_error_code=null
    where d.claim_token=p_claim_token and d.state='CLEANING' and d.lease_expires_at>now() and
      d.artifacts_deleted_at is not null and d.watch_deleted_at is not null and
      d.computer_destroyed_at is not null and d.auth_deleted_at is not null and
      not exists(select 1 from auth.users where id=d.user_id);
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create function public.fail_account_deletion(p_claim_token uuid,p_error_code text) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if p_error_code not in ('ARTIFACT_CLEANUP_FAILED','WATCH_CLEANUP_FAILED','COMPUTER_CLEANUP_FAILED',
    'AUTH_DELETE_FAILED','FINALIZATION_FAILED','UNKNOWN_CLEANUP_FAILURE') then raise exception 'INVALID_CLEANUP_ERROR'; end if;
  update public.account_deletion_requests set state='FAILED',last_error_code=p_error_code,
    next_attempt_at=now()+make_interval(secs=>least(3600,greatest(30,attempts*30))),claim_token=null,lease_expires_at=null
    where claim_token=p_claim_token and state='CLEANING';
  get diagnostics changed=row_count;
  return changed=1;
end $$;

revoke all on function public.reject_run_for_deleting_account(),public.request_account_deletion(uuid),
  public.get_account_deletion_request(),public.claim_account_deletion(),
  public.renew_account_deletion_claim(uuid),public.record_account_deletion_stage(uuid,text),
  public.finish_account_deletion(uuid),public.fail_account_deletion(uuid,text) from public,anon,authenticated;
grant execute on function public.get_account_deletion_request() to authenticated;
grant execute on function public.request_account_deletion(uuid) to service_role;
grant execute on function public.claim_account_deletion(),public.renew_account_deletion_claim(uuid),
  public.record_account_deletion_stage(uuid,text),public.finish_account_deletion(uuid),
  public.fail_account_deletion(uuid,text) to service_role;
