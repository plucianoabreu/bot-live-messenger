-- Provider-neutral computer, watch and artifact foundation.
-- Computer execution remains disabled until the operator validates credentials,
-- the non-admin template and the network policy outside the guest.
alter type public.computer_state add value if not exists 'PAUSING';
alter type public.computer_state add value if not exists 'UNAVAILABLE';
alter type public.computer_state add value if not exists 'DESTROYING';
alter type public.computer_state add value if not exists 'DESTROYED';

alter table public.runtime_config add column computer_enabled boolean not null default false;
alter table public.runtime_config add column watch_enabled boolean not null default false;

-- Hosted Supabase only: create fixed private buckets and add restrictive client
-- policies. Local PGlite probes have no storage schema and skip this block.
do $$
declare bucket_public boolean;
begin
  if to_regclass('storage.buckets') is not null then
    execute 'select public from storage.buckets where id=$1' into bucket_public using 'bot-messenger-artifacts';
    if bucket_public then raise exception 'ARTIFACT_BUCKET_MUST_BE_PRIVATE'; end if;
    execute 'select public from storage.buckets where id=$1' into bucket_public using 'bot-messenger-watch-frames';
    if bucket_public then raise exception 'WATCH_BUCKET_MUST_BE_PRIVATE'; end if;
    execute $sql$insert into storage.buckets(id,name,public,file_size_limit) values
      ('bot-messenger-artifacts','bot-messenger-artifacts',false,10485760),
      ('bot-messenger-watch-frames','bot-messenger-watch-frames',false,2097152)
      on conflict(id) do nothing$sql$;
    execute 'grant select on storage.buckets to service_role';
    execute 'grant select,insert,update,delete on storage.objects to service_role';
    begin
      execute $policy$create policy bot_messenger_private_objects on storage.objects as restrictive
        for all to anon,authenticated
        using(bucket_id not in ('bot-messenger-artifacts','bot-messenger-watch-frames'))
        with check(bucket_id not in ('bot-messenger-artifacts','bot-messenger-watch-frames'))$policy$;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

alter table public.artifacts add column checksum_sha256 text check(checksum_sha256 ~ '^[0-9a-f]{64}$');
alter table public.artifacts add column final_output_key text;
alter table public.artifacts add column delivered_at timestamptz;
alter table public.artifacts add constraint artifact_delivery_complete check (
  (delivered_at is null and checksum_sha256 is null and final_output_key is null) or
  (delivered_at is not null and checksum_sha256 is not null and final_output_key is not null)
);
alter table public.artifacts add constraint artifact_name_safe check(name!~'[[:cntrl:]]');
alter table public.artifacts add constraint artifact_mime_safe check(mime_type ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$');
create unique index artifacts_final_output on public.artifacts(run_id,final_output_key) where delivered_at is not null;

create table public.artifact_upload_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  run_execution_version integer not null check(run_execution_version>0),
  resource_key text not null,
  fencing_token bigint not null,
  final_output_key text not null check(length(final_output_key) between 1 and 120),
  name text not null check(length(name) between 1 and 180 and name!~'[[:cntrl:]]'),
  object_path text not null unique,
  mime_type text not null check(mime_type ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$'),
  size_bytes bigint not null check(size_bytes between 1 and 10485760),
  checksum_sha256 text not null check(checksum_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'PENDING' check(state in ('PENDING','UPLOADED','CLEANUP_REQUIRED','FINALIZED','REJECTED')),
  expires_at timestamptz not null default now()+interval '10 minutes',
  cleanup_token uuid,
  cleanup_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade,
  unique(run_id,final_output_key)
);
create index artifact_upload_cleanup on public.artifact_upload_intents(state,expires_at);
alter table public.artifact_upload_intents enable row level security;
revoke all on public.artifact_upload_intents from public,anon,authenticated;

-- Do not expose private object keys to browser JWTs. Browser reads are limited
-- to delivered metadata and the download route rechecks ownership server-side.
revoke select on public.artifacts from authenticated;
grant select(id,user_id,run_id,name,mime_type,size_bytes,checksum_sha256,created_at,delivered_at) on public.artifacts to authenticated;
grant select on public.artifacts to service_role;
create policy service_role_artifact_private_read on public.artifacts for select to service_role using(true);

create sequence public.resource_fencing_token_seq;
create table public.computer_resource_leases (
  user_id uuid not null references auth.users(id) on delete cascade,
  resource_key text not null check(length(resource_key) between 1 and 600 and
    (resource_key='desktop' or
      (resource_key like 'file:/workspace/%' and resource_key not like '%//%' and resource_key!~'(^|/)\.\.?($|/)' and resource_key!~'[[:cntrl:]\\]'))),
  run_id uuid not null,
  run_execution_version integer not null check(run_execution_version>0),
  holder_id uuid not null,
  fencing_token bigint not null default nextval('public.resource_fencing_token_seq'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(user_id,resource_key),
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade
);
create index computer_resource_leases_expiry on public.computer_resource_leases(expires_at);
alter table public.computer_resource_leases enable row level security;
revoke all on public.computer_resource_leases from public,anon,authenticated;

create table public.computer_run_usage (
  run_id uuid primary key references public.runs(id) on delete cascade,
  execution_version integer not null check(execution_version>0),
  action_count integer not null default 0 check(action_count between 0 and 60),
  updated_at timestamptz not null default now()
);
alter table public.computer_run_usage enable row level security;
revoke all on public.computer_run_usage from public,anon,authenticated;

create table public.computer_operations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  run_execution_version integer not null check(run_execution_version>0),
  resource_key text not null,
  fencing_token bigint not null,
  kind text not null check(kind in ('action','export')),
  state text not null default 'IN_FLIGHT' check(state in ('IN_FLIGHT','UNCERTAIN','SUCCEEDED','FAILED')),
  deadline_at timestamptz not null,
  reconciliation_evidence text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade
);
create index computer_operations_unresolved on public.computer_operations(user_id,resource_key,deadline_at)
  where state in ('IN_FLIGHT','UNCERTAIN');
alter table public.computer_operations enable row level security;
revoke all on public.computer_operations from public,anon,authenticated;

create table public.watch_leases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  id uuid not null unique default gen_random_uuid(),
  run_id uuid not null,
  expires_at timestamptz not null,
  closed_at timestamptz,
  cleanup_token uuid,
  cleanup_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(id,user_id),
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade
);
create index watch_leases_expiry on public.watch_leases(expires_at) where closed_at is null;
alter table public.watch_leases enable row level security;
revoke all on public.watch_leases from public,anon,authenticated;

create table public.watch_frames (
  lease_id uuid not null,
  user_id uuid not null,
  slot smallint not null check(slot in (0,1)),
  object_path text not null unique,
  content_type text not null check(content_type in ('image/png','image/jpeg')),
  size_bytes integer not null check(size_bytes between 1 and 2097152),
  checksum_sha256 text not null check(checksum_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null,
  primary key(lease_id,slot),
  foreign key(lease_id,user_id) references public.watch_leases(id,user_id) on delete cascade
);
alter table public.watch_frames enable row level security;
revoke all on public.watch_frames from public,anon,authenticated;
grant select on public.watch_frames to service_role;
create policy service_role_watch_frame_private_read on public.watch_frames for select to service_role using(true);

create or replace function public.acquire_computer_resource(
  p_run_id uuid,p_run_version integer,p_holder_id uuid,p_resource_key text,p_ttl_seconds integer default 30
) returns bigint language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; current_lease public.computer_resource_leases%rowtype; result bigint;
begin
  if p_holder_id is null or p_resource_key is null or length(p_resource_key) not between 1 and 600 or
    p_ttl_seconds not between 1 and 30 then raise exception 'INVALID_RESOURCE_LEASE'; end if;
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.kind<>'computer' or r.state<>'RUNNING' or r.execution_version<>p_run_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false)
    then raise exception 'LEASE_LOST'; end if;
  if not (p_resource_key='desktop' or
    (p_resource_key like 'file:/workspace/%' and p_resource_key not like '%//%' and
      p_resource_key!~'(^|/)\.\.?($|/)' and p_resource_key!~'[[:cntrl:]\\]')) then raise exception 'INVALID_RESOURCE_LEASE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text||':'||p_resource_key,1));
  select * into current_lease from public.computer_resource_leases
    where user_id=r.user_id and resource_key=p_resource_key for update;
  if exists(select 1 from public.computer_operations o where o.user_id=r.user_id and o.resource_key=p_resource_key and
    o.state in ('IN_FLIGHT','UNCERTAIN')) then raise exception 'RESOURCE_RECONCILIATION_REQUIRED'; end if;
  if found and current_lease.expires_at>now() then
    if current_lease.run_id<>r.id or current_lease.run_execution_version<>p_run_version or current_lease.holder_id<>p_holder_id then
      raise exception 'RESOURCE_BUSY';
    end if;
    update public.computer_resource_leases set expires_at=now()+make_interval(secs=>p_ttl_seconds)
      where user_id=r.user_id and resource_key=p_resource_key returning fencing_token into result;
    return result;
  end if;
  if found then
    update public.computer_resource_leases set run_id=r.id,run_execution_version=p_run_version,holder_id=p_holder_id,
      fencing_token=nextval('public.resource_fencing_token_seq'),expires_at=now()+make_interval(secs=>p_ttl_seconds),created_at=now()
      where user_id=r.user_id and resource_key=p_resource_key returning fencing_token into result;
  else
    insert into public.computer_resource_leases(user_id,resource_key,run_id,run_execution_version,holder_id,expires_at)
      values(r.user_id,p_resource_key,r.id,p_run_version,p_holder_id,now()+make_interval(secs=>p_ttl_seconds))
      returning fencing_token into result;
  end if;
  return result;
end $$;

create function public.release_computer_resource(
  p_run_id uuid,p_run_version integer,p_resource_key text,p_fencing_token bigint
) returns boolean language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  delete from public.computer_resource_leases where run_id=p_run_id and run_execution_version=p_run_version and
    resource_key=p_resource_key and fencing_token=p_fencing_token and not exists(
      select 1 from public.computer_operations o where o.run_id=p_run_id and o.resource_key=p_resource_key and
      o.fencing_token=p_fencing_token and o.state in ('IN_FLIGHT','UNCERTAIN'));
  get diagnostics removed=row_count;
  return removed=1;
end $$;

create function public.current_computer_resource(p_user_id uuid,p_resource_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lease public.computer_resource_leases%rowtype;
begin
  select * into lease from public.computer_resource_leases where user_id=p_user_id and resource_key=p_resource_key;
  if not found then return null; end if;
  return jsonb_build_object('owner_id',lease.user_id,'run_id',lease.run_id,'execution_version',lease.run_execution_version,
    'holder_id',lease.holder_id,'resource_key',lease.resource_key,'fencing_token',lease.fencing_token,'expires_at',lease.expires_at);
end $$;

create function public.authorize_computer_operation(
  p_run_id uuid,p_run_version integer,p_resource_key text,p_fencing_token bigint,p_kind text,
  p_operation_id uuid,p_deadline_seconds integer default 30
) returns timestamptz language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; action_number integer; deadline timestamptz; existing public.computer_operations%rowtype;
begin
  if p_operation_id is null or p_deadline_seconds not between 1 and 30 then raise exception 'INVALID_OPERATION'; end if;
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.kind<>'computer' or r.state<>'RUNNING' or r.execution_version<>p_run_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false) or
    not exists(select 1 from public.computer_resource_leases l where l.user_id=r.user_id and l.run_id=r.id and
      l.run_execution_version=p_run_version and l.resource_key=p_resource_key and l.fencing_token=p_fencing_token and l.expires_at>now())
    then raise exception 'LEASE_LOST'; end if;
  if (p_kind='action' and p_resource_key<>'desktop') or
    (p_kind='export' and p_resource_key not like 'file:/workspace/%') or p_kind not in ('action','export')
    then raise exception 'INVALID_OPERATION'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text||':'||p_resource_key,1));
  select * into existing from public.computer_operations where id=p_operation_id;
  if found then
    if (existing.run_id,existing.run_execution_version,existing.resource_key,existing.fencing_token,existing.kind) is distinct from
      (p_run_id,p_run_version,p_resource_key,p_fencing_token,p_kind) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return existing.deadline_at;
  end if;
  if exists(select 1 from public.computer_operations o where o.user_id=r.user_id and o.resource_key=p_resource_key and
    o.state in ('IN_FLIGHT','UNCERTAIN')) then raise exception 'RESOURCE_BUSY'; end if;
  insert into public.computer_run_usage(run_id,execution_version,action_count)
    values(r.id,p_run_version,1)
    on conflict(run_id) do update set action_count=public.computer_run_usage.action_count+1,updated_at=now()
      where public.computer_run_usage.execution_version=excluded.execution_version and public.computer_run_usage.action_count<60
    returning action_count into action_number;
  if action_number is null then raise exception 'ACTION_LIMIT'; end if;
  deadline:=least(r.lease_expires_at,now()+make_interval(secs=>p_deadline_seconds));
  insert into public.computer_operations(id,user_id,run_id,run_execution_version,resource_key,fencing_token,kind,deadline_at)
    values(p_operation_id,r.user_id,r.id,p_run_version,p_resource_key,p_fencing_token,p_kind,deadline);
  return deadline;
end $$;

create function public.finish_computer_operation(p_operation_id uuid,p_outcome text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_outcome not in ('SUCCEEDED','FAILED','UNCERTAIN') then raise exception 'INVALID_OPERATION_OUTCOME'; end if;
  update public.computer_operations set state=p_outcome,finished_at=case when p_outcome='UNCERTAIN' then null else now() end
    where id=p_operation_id and state='IN_FLIGHT';
  if not found then raise exception 'OPERATION_NOT_CURRENT'; end if;
end $$;

create function public.reconcile_computer_operation(p_operation_id uuid,p_outcome text,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_outcome not in ('SUCCEEDED','FAILED') or p_evidence is null or length(trim(p_evidence)) not between 1 and 500
    then raise exception 'INVALID_RECONCILIATION'; end if;
  update public.computer_operations set state=p_outcome,reconciliation_evidence=trim(p_evidence),finished_at=now()
    where id=p_operation_id and state in ('IN_FLIGHT','UNCERTAIN');
  if not found then raise exception 'OPERATION_NOT_RECONCILABLE'; end if;
end $$;

create function public.start_watch(p_run_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result uuid:=gen_random_uuid(); current_lease public.watch_leases%rowtype;
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,3));
  if not coalesce((select computer_enabled and watch_enabled from public.runtime_config where singleton),false) then
    raise exception 'INTEGRATION_UNAVAILABLE';
  end if;
  if not exists(select 1 from public.runs r join public.workspace_computers c on c.user_id=r.user_id
    where r.id=p_run_id and r.user_id=uid and r.kind='computer' and r.state='RUNNING' and
    not r.cancel_requested and r.lease_expires_at>now() and c.state='READY') then raise exception 'RUN_NOT_FOUND'; end if;
  select * into current_lease from public.watch_leases where user_id=uid for update;
  if found and current_lease.closed_at is null and current_lease.expires_at>now() and current_lease.run_id=p_run_id then
    update public.watch_leases set expires_at=now()+interval '60 seconds' where user_id=uid returning id into result;
    return result;
  end if;
  if found and exists(select 1 from public.watch_frames where lease_id=current_lease.id) then raise exception 'WATCH_CLEANUP_PENDING'; end if;
  if found then delete from public.watch_leases where user_id=uid; end if;
  insert into public.watch_leases(user_id,id,run_id,expires_at) values(uid,result,p_run_id,now()+interval '60 seconds');
  return result;
end $$;

create function public.renew_watch(p_watch_id uuid) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result timestamptz;
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if not coalesce((select computer_enabled and watch_enabled from public.runtime_config where singleton),false) then
    raise exception 'INTEGRATION_UNAVAILABLE';
  end if;
  update public.watch_leases w set expires_at=now()+interval '60 seconds'
    where w.id=p_watch_id and w.user_id=uid and w.closed_at is null and w.expires_at>now() and
    exists(select 1 from public.runs r join public.workspace_computers c on c.user_id=r.user_id
      where r.id=w.run_id and r.user_id=uid and r.kind='computer' and r.state='RUNNING' and
      not r.cancel_requested and r.lease_expires_at>now() and c.state='READY')
    returning expires_at into result;
  if result is null then raise exception 'WATCH_NOT_FOUND'; end if;
  return result;
end $$;

create function public.stop_watch(p_watch_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.watch_leases set closed_at=coalesce(closed_at,now()),expires_at=least(expires_at,now())
    where id=p_watch_id and user_id=uid;
  if not found then raise exception 'WATCH_NOT_FOUND'; end if;
end $$;

create function public.authorize_watch_frame(p_watch_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result jsonb;
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  select jsonb_build_object('slot',f.slot,'captured_at',f.captured_at,'content_type',f.content_type,
    'size_bytes',f.size_bytes,'checksum_sha256',f.checksum_sha256) into result
  from public.watch_leases w join public.watch_frames f on f.lease_id=w.id and f.user_id=w.user_id
  where w.id=p_watch_id and w.user_id=uid and w.closed_at is null and w.expires_at>now() and
    coalesce((select computer_enabled and watch_enabled from public.runtime_config where singleton),false) and
    exists(select 1 from public.runs r join public.workspace_computers c on c.user_id=r.user_id
      where r.id=w.run_id and r.user_id=uid and r.kind='computer' and r.state='RUNNING' and
      not r.cancel_requested and r.lease_expires_at>now() and c.state='READY')
  order by f.captured_at desc limit 1;
  if result is null then raise exception 'WATCH_NOT_FOUND'; end if;
  return result;
end $$;

create function public.store_watch_frame(
  p_watch_id uuid,p_slot smallint,p_object_path text,p_content_type text,p_size_bytes integer,
  p_checksum_sha256 text,p_captured_at timestamptz
) returns void language plpgsql security definer set search_path='' as $$
declare owner uuid; watched_run uuid;
begin
  select user_id,run_id into owner,watched_run from public.watch_leases where id=p_watch_id and closed_at is null and expires_at>now() for update;
  if owner is null or not coalesce((select computer_enabled and watch_enabled from public.runtime_config where singleton),false) or
    not exists(select 1 from public.runs r join public.workspace_computers c on c.user_id=r.user_id
      where r.id=watched_run and r.user_id=owner and r.kind='computer' and r.state='RUNNING' and
      not r.cancel_requested and r.lease_expires_at>now() and c.state='READY') then raise exception 'WATCH_EXPIRED'; end if;
  if p_slot not in (0,1) or p_object_path is distinct from owner::text||'/'||p_watch_id::text||'/'||p_slot::text or
    p_content_type not in ('image/png','image/jpeg') or
    p_size_bytes not between 1 and 2097152 or p_checksum_sha256!~'^[0-9a-f]{64}$' or p_captured_at is null then
    raise exception 'INVALID_FRAME'; end if;
  insert into public.watch_frames(lease_id,user_id,slot,object_path,content_type,size_bytes,checksum_sha256,captured_at)
    values(p_watch_id,owner,p_slot,p_object_path,p_content_type,p_size_bytes,p_checksum_sha256,p_captured_at)
    on conflict(lease_id,slot) do update set object_path=excluded.object_path,content_type=excluded.content_type,
      size_bytes=excluded.size_bytes,checksum_sha256=excluded.checksum_sha256,captured_at=excluded.captured_at;
end $$;

create function public.authorize_watch_capture(p_user_id uuid,p_watch_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_user_id is null or not coalesce((select runs_enabled and computer_enabled and watch_enabled
      from public.runtime_config where singleton),false) or
    not exists(select 1 from public.watch_leases w join public.runs r on r.id=w.run_id and r.user_id=w.user_id
      join public.workspace_computers c on c.user_id=w.user_id
      where w.id=p_watch_id and w.user_id=p_user_id and w.closed_at is null and w.expires_at>now() and
        r.kind='computer' and r.state='RUNNING' and not r.cancel_requested and r.lease_expires_at>now() and c.state='READY')
    then raise exception 'WATCH_EXPIRED'; end if;
end $$;

create function public.claim_watch_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare lease public.watch_leases%rowtype; token uuid:=gen_random_uuid(); frames jsonb;
begin
  select * into lease from public.watch_leases where (closed_at is not null or expires_at<=now()) and
    (cleanup_claimed_at is null or cleanup_claimed_at<=now()-interval '60 seconds')
    order by coalesce(closed_at,expires_at) for update skip locked limit 1;
  if not found then return null; end if;
  update public.watch_leases set cleanup_token=token,cleanup_claimed_at=now() where user_id=lease.user_id;
  select coalesce(jsonb_agg(object_path order by slot),'[]'::jsonb) into frames from public.watch_frames where lease_id=lease.id;
  return jsonb_build_object('lease_id',lease.id,'user_id',lease.user_id,'cleanup_token',token,'object_paths',frames);
end $$;

create function public.finish_watch_cleanup(p_cleanup_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  delete from public.watch_leases where cleanup_token=p_cleanup_token and (closed_at is not null or expires_at<=now());
  get diagnostics removed=row_count;
  return removed=1;
end $$;

create function public.reserve_artifact_upload(
  p_run_id uuid,p_run_version integer,p_resource_key text,p_fencing_token bigint,
  p_final_output_key text,p_name text,p_object_path text,p_mime_type text,p_size_bytes bigint,p_checksum_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; existing public.artifact_upload_intents%rowtype; result uuid;
begin
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.kind<>'computer' or r.state<>'RUNNING' or r.execution_version<>p_run_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false) or
    not exists(select 1 from public.computer_resource_leases l
      where l.user_id=r.user_id and l.run_id=r.id and l.run_execution_version=p_run_version and
      l.resource_key=p_resource_key and l.fencing_token=p_fencing_token and l.expires_at>now()) then raise exception 'LEASE_LOST'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text,2));
  if p_final_output_key is null or length(p_final_output_key) not between 1 and 120 or
    p_name is null or length(p_name) not between 1 and 180 or p_name~'[[:cntrl:]]' or
    p_object_path is null or length(p_object_path)>500 or p_object_path not like r.user_id::text||'/'||r.id::text||'/%' or
    p_mime_type is null or length(p_mime_type)>120 or p_mime_type!~'^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$' or p_size_bytes not between 1 and 10485760 or
    p_checksum_sha256!~'^[0-9a-f]{64}$' then raise exception 'INVALID_ARTIFACT'; end if;
  select * into existing from public.artifact_upload_intents where run_id=r.id and final_output_key=p_final_output_key;
  if found then
    if (existing.name,existing.object_path,existing.mime_type,existing.size_bytes,existing.checksum_sha256) is distinct from
      (p_name,p_object_path,p_mime_type,p_size_bytes,p_checksum_sha256) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return existing.id;
  end if;
  if coalesce((select sum(size_bytes) from public.artifacts where user_id=r.user_id and delivered_at is not null),0)+
    coalesce((select sum(size_bytes) from public.artifact_upload_intents where user_id=r.user_id and state in ('PENDING','UPLOADED','CLEANUP_REQUIRED')),0)+p_size_bytes>104857600 then
    raise exception 'ARTIFACT_STORAGE_LIMIT'; end if;
  insert into public.artifact_upload_intents(user_id,run_id,run_execution_version,resource_key,fencing_token,
    final_output_key,name,object_path,mime_type,size_bytes,checksum_sha256)
    values(r.user_id,r.id,p_run_version,p_resource_key,p_fencing_token,p_final_output_key,p_name,p_object_path,p_mime_type,p_size_bytes,p_checksum_sha256)
    returning id into result;
  return result;
end $$;

create function public.mark_artifact_uploaded(p_intent_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.artifact_upload_intents set state='UPLOADED' where id=p_intent_id and state='PENDING';
  if not found and not exists(select 1 from public.artifact_upload_intents where id=p_intent_id and state='FINALIZED')
    then raise exception 'ARTIFACT_INTENT_NOT_PENDING'; end if;
end $$;

create function public.finalize_artifact_upload(p_intent_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent public.artifact_upload_intents%rowtype; r public.runs%rowtype; artifact public.artifacts%rowtype;
begin
  select * into intent from public.artifact_upload_intents where id=p_intent_id for update;
  if not found then raise exception 'ARTIFACT_INTENT_NOT_FOUND'; end if;
  if intent.state='FINALIZED' then
    select * into artifact from public.artifacts where run_id=intent.run_id and final_output_key=intent.final_output_key;
    return to_jsonb(artifact)-'object_path';
  end if;
  select * into r from public.runs where id=intent.run_id for update;
  if intent.state<>'UPLOADED' or not found or r.state<>'RUNNING' or r.execution_version<>intent.run_execution_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false) or
    not exists(select 1 from public.computer_resource_leases l where l.user_id=intent.user_id and l.run_id=intent.run_id and
      l.run_execution_version=intent.run_execution_version and l.resource_key=intent.resource_key and
      l.fencing_token=intent.fencing_token and l.expires_at>now()) then raise exception 'LEASE_LOST'; end if;
  insert into public.artifacts(user_id,run_id,name,object_path,mime_type,size_bytes,checksum_sha256,final_output_key,delivered_at)
    values(intent.user_id,intent.run_id,intent.name,intent.object_path,intent.mime_type,intent.size_bytes,intent.checksum_sha256,intent.final_output_key,now())
    returning * into artifact;
  update public.artifact_upload_intents set state='FINALIZED',finished_at=now() where id=intent.id;
  return to_jsonb(artifact)-'object_path';
end $$;

create function public.reject_artifact_upload(p_intent_id uuid,p_uploaded boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_uploaded is null then raise exception 'INVALID_ARTIFACT_REJECTION'; end if;
  update public.artifact_upload_intents set state=case when p_uploaded then 'CLEANUP_REQUIRED' else 'REJECTED' end,
    finished_at=case when p_uploaded then null else now() end
    where id=p_intent_id and state in ('PENDING','UPLOADED');
  -- A retry after successful finalization is harmless.
  if not found and not exists(select 1 from public.artifact_upload_intents where id=p_intent_id and state='FINALIZED')
    then raise exception 'ARTIFACT_INTENT_NOT_REJECTABLE'; end if;
end $$;

create function public.claim_artifact_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent public.artifact_upload_intents%rowtype; token uuid:=gen_random_uuid();
begin
  select * into intent from public.artifact_upload_intents where
    (state='CLEANUP_REQUIRED' or (state in ('PENDING','UPLOADED') and expires_at<=now())) and
    (cleanup_claimed_at is null or cleanup_claimed_at<=now()-interval '60 seconds')
    order by expires_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.artifact_upload_intents set state='CLEANUP_REQUIRED',cleanup_token=token,cleanup_claimed_at=now() where id=intent.id;
  return jsonb_build_object('intent_id',intent.id,'user_id',intent.user_id,'run_id',intent.run_id,
    'cleanup_token',token,'object_path',intent.object_path);
end $$;

create function public.finish_artifact_cleanup(p_cleanup_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.artifact_upload_intents set state='REJECTED',finished_at=now(),cleanup_token=null
    where cleanup_token=p_cleanup_token and state='CLEANUP_REQUIRED';
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create function public.claim_idle_computer(p_idle_seconds integer default 15) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.workspace_computers%rowtype;
begin
  if p_idle_seconds not between 15 and 3600 then raise exception 'INVALID_IDLE_PERIOD'; end if;
  select * into c from public.workspace_computers where state='READY' and provider_id is not null and
    last_used_at<=now()-make_interval(secs=>p_idle_seconds) and
    not exists(select 1 from public.runs r where r.user_id=workspace_computers.user_id and r.kind='computer' and r.state in ('QUEUED','RUNNING','WAITING_FOR_USER')) and
    not exists(select 1 from public.computer_resource_leases l where l.user_id=workspace_computers.user_id and l.expires_at>now()) and
    not exists(select 1 from public.computer_operations o where o.user_id=workspace_computers.user_id and o.state in ('IN_FLIGHT','UNCERTAIN')) and
    not exists(select 1 from public.watch_leases w where w.user_id=workspace_computers.user_id and w.closed_at is null and w.expires_at>now())
    order by last_used_at for update skip locked limit 1;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(c.user_id::text,0));
  select * into c from public.workspace_computers where user_id=c.user_id and state='READY' and provider_id is not null and
    last_used_at<=now()-make_interval(secs=>p_idle_seconds) and
    not exists(select 1 from public.runs r where r.user_id=workspace_computers.user_id and r.kind='computer' and r.state in ('QUEUED','RUNNING','WAITING_FOR_USER')) and
    not exists(select 1 from public.computer_resource_leases l where l.user_id=workspace_computers.user_id and l.expires_at>now()) and
    not exists(select 1 from public.computer_operations o where o.user_id=workspace_computers.user_id and o.state in ('IN_FLIGHT','UNCERTAIN')) and
    not exists(select 1 from public.watch_leases w where w.user_id=workspace_computers.user_id and w.closed_at is null and w.expires_at>now())
    for update;
  if not found then return null; end if;
  update public.workspace_computers set state='PAUSING',execution_version=execution_version+1 where user_id=c.user_id returning * into c;
  return jsonb_build_object('user_id',c.user_id,'provider_id',c.provider_id,'template_version',c.template_version,'version',c.execution_version);
end $$;

create function public.finish_idle_pause(p_user_id uuid,p_version integer,p_paused boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.workspace_computers set state=case when p_paused then 'PAUSED'::public.computer_state else 'READY'::public.computer_state end,
    last_used_at=case when p_paused then last_used_at else now() end
    where user_id=p_user_id and state='PAUSING' and execution_version=p_version;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

revoke all on function public.acquire_computer_resource(uuid,integer,uuid,text,integer),
  public.release_computer_resource(uuid,integer,text,bigint),public.current_computer_resource(uuid,text),
  public.authorize_computer_operation(uuid,integer,text,bigint,text,uuid,integer),
  public.finish_computer_operation(uuid,text),public.reconcile_computer_operation(uuid,text,text),
  public.authorize_watch_capture(uuid,uuid),public.store_watch_frame(uuid,smallint,text,text,integer,text,timestamptz),
  public.claim_watch_cleanup(),public.finish_watch_cleanup(uuid),
  public.reserve_artifact_upload(uuid,integer,text,bigint,text,text,text,text,bigint,text),
  public.mark_artifact_uploaded(uuid),public.finalize_artifact_upload(uuid),public.reject_artifact_upload(uuid,boolean),
  public.claim_artifact_cleanup(),public.finish_artifact_cleanup(uuid),public.claim_idle_computer(integer),
  public.finish_idle_pause(uuid,integer,boolean) from public,anon,authenticated;
grant execute on function public.acquire_computer_resource(uuid,integer,uuid,text,integer),
  public.release_computer_resource(uuid,integer,text,bigint),public.current_computer_resource(uuid,text),
  public.authorize_computer_operation(uuid,integer,text,bigint,text,uuid,integer),
  public.finish_computer_operation(uuid,text),public.reconcile_computer_operation(uuid,text,text),
  public.authorize_watch_capture(uuid,uuid),public.store_watch_frame(uuid,smallint,text,text,integer,text,timestamptz),
  public.claim_watch_cleanup(),public.finish_watch_cleanup(uuid),
  public.reserve_artifact_upload(uuid,integer,text,bigint,text,text,text,text,bigint,text),
  public.mark_artifact_uploaded(uuid),public.finalize_artifact_upload(uuid),public.reject_artifact_upload(uuid,boolean),
  public.claim_artifact_cleanup(),public.finish_artifact_cleanup(uuid),public.claim_idle_computer(integer),
  public.finish_idle_pause(uuid,integer,boolean) to service_role;

revoke all on function public.start_watch(uuid),public.renew_watch(uuid),public.stop_watch(uuid),public.authorize_watch_frame(uuid) from public,anon;
grant execute on function public.start_watch(uuid),public.renew_watch(uuid),public.stop_watch(uuid),public.authorize_watch_frame(uuid) to authenticated;
