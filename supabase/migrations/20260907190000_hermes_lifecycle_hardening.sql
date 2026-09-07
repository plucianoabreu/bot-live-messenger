-- Migration: hermes-lifecycle-hardening
-- Created: 2026-09-07
-- Description: Enforce account pilot budgets, fence provider pauses, close artifact gaps, and make account cleanup retry-safe.
-- Affected tables: public.hermes_workspaces, public.runs, public.account_pilot_budgets, public.account_pilot_reservations, public.account_deletion_requests, public.account_deletion_computer_receipts
-- Breaking change: no

-- ============================================================
-- UP MIGRATION
-- ============================================================

-- The existing welcome quota permits five chat runs and one computer run. Any
-- chat run may use Hermes, so the maximum current account scope is:
-- 5 * (20,000 chat + 250,000 Hermes) + 1 * 250,000 computer = 1,600,000 micros.
create table public.account_pilot_budgets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  limit_micros bigint not null default 1600000 check(limit_micros=1600000),
  allocated_micros bigint not null default 0 check(allocated_micros between 0 and limit_micros),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.account_pilot_reservations (
  run_id uuid not null,
  user_id uuid not null,
  reservation_kind text not null check(reservation_kind in ('run','hermes')),
  reserved_micros bigint not null check(reserved_micros>0),
  created_at timestamptz not null default now(),
  primary key(run_id,reservation_kind),
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade
);
alter table public.account_pilot_budgets enable row level security;
alter table public.account_pilot_reservations enable row level security;
revoke all on public.account_pilot_budgets,public.account_pilot_reservations from public,anon,authenticated;
grant select on public.account_pilot_budgets,public.account_pilot_reservations to service_role;

-- A provider ID captured before launch credentials were durably written is a
-- cleanup target, not a reusable workspace. The explicit bit also lets the
-- recovery worker choose destroy without interpreting nullable credentials.
alter table public.hermes_workspaces
  add column provision_cleanup_required boolean not null default false;

-- Backfill reservations that can be proven from durable state. An active Hermes
-- binding proves its compute reservation; released historical bindings cannot
-- be reconstructed and their welcome quota already prevents new run admission.
insert into public.account_pilot_budgets(user_id)
  select id from auth.users on conflict(user_id) do nothing;
insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros)
  select id,user_id,'run',reserved_cost_micros from public.runs;
insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros)
  select w.active_run,w.user_id,'hermes',250000 from public.hermes_workspaces w where w.active_run is not null;
update public.account_pilot_budgets budget set allocated_micros=coalesce((
  select sum(reservation.reserved_micros) from public.account_pilot_reservations reservation
    where reservation.user_id=budget.user_id
),0),updated_at=now();

create or replace function public.enqueue_message(
  p_bot_id uuid,p_content text,p_idempotency_key uuid,p_kind text default 'chat'
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid();
  existing uuid;
  result uuid;
  original text;
  allocation bigint;
  pool public.pilot_budgets%rowtype;
  account_budget public.account_pilot_budgets%rowtype;
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_kind is null or p_kind not in ('chat','computer') then raise exception 'INVALID_RUN_KIND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if not exists(select 1 from public.bots where id=p_bot_id and user_id=uid and enabled) then raise exception 'BOT_NOT_FOUND'; end if;
  if p_idempotency_key is null or p_content is null or length(trim(p_content)) not between 1 and 8000 then raise exception 'INVALID_MESSAGE'; end if;
  select id into existing from public.runs where user_id=uid and idempotency_key=p_idempotency_key;
  if existing is not null then
    select content into original from public.messages where run_id=existing and role='user';
    if original<>trim(p_content) or not exists(select 1 from public.runs where id=existing and bot_id=p_bot_id and kind=p_kind)
      then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return existing;
  end if;
  if not coalesce((select runs_enabled from public.runtime_config where singleton),false) then raise exception 'RUNTIME_DISABLED'; end if;
  if exists(select 1 from public.runs where bot_id=p_bot_id and state in ('QUEUED','RUNNING','WAITING_FOR_USER'))
    then raise exception 'RUN_ALREADY_OPEN'; end if;
  if (select count(*) from public.runs where user_id=uid and state in ('QUEUED','RUNNING','WAITING_FOR_USER'))>=3
    then raise exception 'USER_CONCURRENCY'; end if;
  if (select count(*) from public.runs where user_id=uid and kind=p_kind)>=(case when p_kind='chat' then 5 else 1 end)
    then raise exception 'WELCOME_QUOTA'; end if;

  allocation:=case when p_kind='chat' then 20000 else 250000 end;
  insert into public.account_pilot_budgets(user_id) values(uid) on conflict(user_id) do nothing;
  select * into pool from public.pilot_budgets where kind=p_kind for update;
  if not found or pool.allocated_micros+allocation>pool.limit_micros then raise exception 'PILOT_BUDGET_EXHAUSTED'; end if;
  select * into account_budget from public.account_pilot_budgets where user_id=uid for update;
  if account_budget.allocated_micros+allocation>account_budget.limit_micros then
    raise exception 'ACCOUNT_PILOT_BUDGET_EXHAUSTED';
  end if;

  insert into public.runs(user_id,bot_id,idempotency_key,kind,reserved_cost_micros,max_seconds,instructions_version,instructions_snapshot)
    select uid,p_bot_id,p_idempotency_key,p_kind,allocation,120,b.instructions_version,b.instructions
      from public.bots b where b.id=p_bot_id returning id into result;
  insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros)
    values(result,uid,'run',allocation);
  update public.pilot_budgets set allocated_micros=allocated_micros+allocation where kind=p_kind;
  update public.account_pilot_budgets set allocated_micros=allocated_micros+allocation,updated_at=now() where user_id=uid;
  insert into public.messages(user_id,bot_id,run_id,role,content) values(uid,p_bot_id,result,'user',trim(p_content));
  insert into public.run_events(user_id,run_id,kind,summary) values(uid,result,'queued','Tarefa na fila.');
  return result;
end $$;

create or replace function public.claim_hermes_workspace(p_run_id uuid,p_version integer,p_proxy_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  r public.runs%rowtype;
  active public.runs%rowtype;
  w public.hermes_workspaces%rowtype;
  token uuid;
  pool public.pilot_budgets%rowtype;
  account_budget public.account_pilot_budgets%rowtype;
begin
  if p_version is null or p_version<=0 or p_proxy_hash is null or p_proxy_hash!~'^[0-9a-f]{64}$' then
    raise exception 'INVALID_HERMES_CLAIM';
  end if;
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.state<>'RUNNING' or r.execution_version<>p_version or r.cancel_requested or
    r.lease_expires_at is null or r.lease_expires_at<=now() then raise exception 'LEASE_LOST'; end if;
  if not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false) then
    raise exception 'COMPUTER_DISABLED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text,31));
  insert into public.hermes_workspaces(user_id,proxy_hash) values(r.user_id,p_proxy_hash)
    on conflict(user_id) do nothing;
  select * into w from public.hermes_workspaces where user_id=r.user_id for update;
  if w.active_run is not null then
    if w.recovery_token is not null then raise exception 'COMPUTER_RECOVERY_IN_PROGRESS'; end if;
    select * into active from public.runs where id=w.active_run;
    if active.state='RUNNING' and not active.cancel_requested and active.lease_expires_at is not null and active.lease_expires_at>now() then
      raise exception 'COMPUTER_BUSY';
    end if;
    -- There is no provider identifier to reconcile inline. Leave the fence
    -- untouched for the metadata-scoped maintenance scan after its grace.
    if w.machine_id is null then raise exception 'COMPUTER_RECOVERY_IN_PROGRESS'; end if;
    token:=gen_random_uuid();
    update public.hermes_workspaces set recovery_token=token,recovery_started_at=now()
      where user_id=r.user_id returning * into w;
    return to_jsonb(w)||jsonb_build_object(
      'status','recovery_required',
      'recovery_action',case when w.provision_cleanup_required or w.base_url is null or
        w.api_key is null or w.revision is null then 'destroy' else 'pause' end
    );
  end if;

  if not exists(select 1 from public.account_pilot_reservations
      where run_id=r.id and reservation_kind='hermes') then
    insert into public.account_pilot_budgets(user_id) values(r.user_id) on conflict(user_id) do nothing;
    select * into pool from public.pilot_budgets where kind='computer' for update;
    if not found or pool.allocated_micros+250000>pool.limit_micros then raise exception 'COMPUTER_BUDGET_EXHAUSTED'; end if;
    select * into account_budget from public.account_pilot_budgets where user_id=r.user_id for update;
    if account_budget.allocated_micros+250000>account_budget.limit_micros then
      raise exception 'ACCOUNT_PILOT_BUDGET_EXHAUSTED';
    end if;
    insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros)
      values(r.id,r.user_id,'hermes',250000);
    update public.pilot_budgets set allocated_micros=allocated_micros+250000 where kind='computer';
    update public.account_pilot_budgets set allocated_micros=allocated_micros+250000,updated_at=now()
      where user_id=r.user_id;
  end if;
  update public.hermes_workspaces set proxy_hash=p_proxy_hash,active_run=r.id,
    active_execution_version=p_version,remote_run=null,recovery_token=null,recovery_started_at=null
    where user_id=r.user_id returning * into w;
  return to_jsonb(w)||jsonb_build_object('status','claimed');
end $$;

-- A normal finalizer establishes its pause token before the provider call. A
-- recovery token is owned exclusively by the recovery worker, so a stale normal
-- finalizer cannot join a recovery already in progress and pause a later run.
create function public.begin_hermes_pause(
  p_run_id uuid,p_version integer,p_proxy_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; token uuid;
begin
  select * into w from public.hermes_workspaces
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
    for update;
  if not found or w.machine_id is null or w.recovery_token is not null then return null; end if;
  token:=gen_random_uuid();
  update public.hermes_workspaces
    set recovery_token=token,recovery_started_at=now()
    where user_id=w.user_id;
  return jsonb_build_object('pause_token',token,'machine_id',w.machine_id);
end $$;

create function public.complete_hermes_pause(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_pause_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,
      recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and recovery_token=p_pause_token and machine_id is not null;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

-- A provisioner may release an unbound fence only after it has confirmed that
-- provider cleanup succeeded. If cleanup is uncertain, persist the provider ID
-- so the normal recovery pause protocol can reconcile it later.
create function public.release_failed_hermes_provision(
  p_run_id uuid,p_version integer,p_proxy_hash text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,
      recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and machine_id is null;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create function public.record_failed_hermes_provision(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_machine_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if p_machine_id is null or length(btrim(p_machine_id)) not between 1 and 200 or p_machine_id~'[[:cntrl:]]' then
    return false;
  end if;
  update public.hermes_workspaces set machine_id=p_machine_id,
      base_url=null,api_key=null,revision=null,remote_run=null,
      provision_cleanup_required=true
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and (machine_id is null or machine_id=p_machine_id);
  get diagnostics changed=row_count;
  return changed=1;
end $$;

-- A crashed finalizer or recovery worker may not own an account forever. Only
-- service workers can reclaim an abandoned fence, and the replacement token is
-- written under the same row lock that returns the provider action.
create function public.claim_stale_hermes_recovery() returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; active public.runs%rowtype; token uuid:=gen_random_uuid(); action text;
begin
  select workspace.* into w from public.hermes_workspaces workspace
    left join public.runs run on run.id=workspace.active_run
    where workspace.active_run is not null and workspace.active_execution_version is not null and
      (run.id is null or run.state<>'RUNNING' or run.cancel_requested or
        run.lease_expires_at is null or run.lease_expires_at<=now()) and
      (workspace.recovery_token is null or workspace.recovery_started_at<=now()-interval '5 minutes') and
      (workspace.machine_id is not null or
        coalesce(run.finished_at,run.lease_expires_at,workspace.recovery_started_at,workspace.created_at)
          <=now()-interval '5 minutes') and
      (workspace.machine_id is null or not exists(select 1 from public.account_deletion_requests deletion
        where deletion.user_id=workspace.user_id and deletion.completed_at is null))
    order by coalesce(workspace.recovery_started_at,workspace.created_at),workspace.user_id
    for update of workspace skip locked limit 1;
  if not found then return null; end if;
  action:=case when w.machine_id is null then 'reconcile'
    when w.provision_cleanup_required or w.base_url is null or
    w.api_key is null or w.revision is null then 'destroy' else 'pause' end;
  update public.hermes_workspaces set recovery_token=token,recovery_started_at=now()
    where user_id=w.user_id;
  return jsonb_build_object(
    'owner_id',w.user_id,'active_run_id',w.active_run,
    'active_execution_version',w.active_execution_version,'machine_id',w.machine_id,
    'recovery_token',token,'recovery_action',action,
    'orphan_started_before',now()-interval '5 minutes'
  );
end $$;

create or replace function public.complete_hermes_recovery(
  p_user_id uuid,p_active_run uuid,p_active_version integer,p_recovery_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; active public.runs%rowtype; changed integer;
begin
  select * into w from public.hermes_workspaces where user_id=p_user_id for update;
  if not found or w.active_run is distinct from p_active_run or
    w.active_execution_version is distinct from p_active_version or w.recovery_token is distinct from p_recovery_token then
    return false;
  end if;
  select * into active from public.runs where id=w.active_run;
  if found and active.state='RUNNING' and not active.cancel_requested and active.lease_expires_at is not null and active.lease_expires_at>now() then
    return false;
  end if;
  if w.machine_id is null or w.provision_cleanup_required or w.base_url is null or w.api_key is null or w.revision is null then
    update public.hermes_workspaces set active_run=null,active_execution_version=null,remote_run=null,
      recovery_token=null,recovery_started_at=null,machine_id=null,base_url=null,api_key=null,revision=null,
      provision_cleanup_required=false
      where user_id=p_user_id and recovery_token=p_recovery_token;
  else
    update public.hermes_workspaces set active_run=null,active_execution_version=null,remote_run=null,
      recovery_token=null,recovery_started_at=null
      where user_id=p_user_id and recovery_token=p_recovery_token;
  end if;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

-- Keep the legacy RPC safe during an application rollout. It may never clear a
-- fence once any worker has begun the tokenized provider-pause protocol.
create or replace function public.release_hermes_workspace(
  p_run_id uuid,p_version integer,p_proxy_hash text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,
      recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and recovery_token is null;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.authorize_hermes_artifact_export(
  p_user_id uuid,p_run_id uuid,p_run_version integer,p_export_path text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; w public.hermes_workspaces%rowtype;
begin
  select * into r from public.runs where id=p_run_id and user_id=p_user_id;
  select * into w from public.hermes_workspaces where user_id=p_user_id;
  if r.id is null or w.user_id is null or r.state<>'RUNNING' or r.execution_version<>p_run_version or r.cancel_requested or
    r.lease_expires_at is null or r.lease_expires_at<=now() or w.active_run is distinct from r.id or
    w.active_execution_version is distinct from p_run_version or w.machine_id is null or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false)
    then raise exception 'LEASE_LOST'; end if;
  if p_export_path is null or length(p_export_path) not between 20 and 519 or
    p_export_path not like '/workspace/exports/%' or p_export_path like '%//%' or
    p_export_path~'(^|/)\.\.?($|/)' or p_export_path~'[[:cntrl:]\\]' then raise exception 'INVALID_EXPORT_PATH'; end if;
  return jsonb_build_object('machine_id',w.machine_id);
end $$;

create or replace function public.reserve_hermes_artifact_upload(
  p_run_id uuid,p_run_version integer,p_export_path text,p_final_output_key text,p_name text,
  p_object_path text,p_mime_type text,p_size_bytes bigint,p_checksum_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; existing public.artifact_upload_intents%rowtype; result uuid;
begin
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.state<>'RUNNING' or r.execution_version<>p_run_version or r.cancel_requested or
    r.lease_expires_at is null or r.lease_expires_at<=now() or
    not exists(select 1 from public.hermes_workspaces w where w.user_id=r.user_id and w.active_run=r.id and
      w.active_execution_version=p_run_version and w.machine_id is not null) or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false)
    then raise exception 'LEASE_LOST'; end if;
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
    source_current:=exists(select 1 from public.hermes_workspaces w where w.user_id=intent.user_id and
      w.active_run=intent.run_id and w.active_execution_version=intent.run_execution_version and w.machine_id is not null);
  else
    source_current:=exists(select 1 from public.computer_resource_leases l where l.user_id=intent.user_id and l.run_id=intent.run_id and
      l.run_execution_version=intent.run_execution_version and l.resource_key=intent.resource_key and
      l.fencing_token=intent.fencing_token and l.expires_at>now());
  end if;
  if intent.state<>'UPLOADED' or not found or r.state<>'RUNNING' or r.execution_version<>intent.run_execution_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() or not source_current or
    not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false)
    then raise exception 'LEASE_LOST'; end if;
  insert into public.artifacts(user_id,run_id,name,object_path,mime_type,size_bytes,checksum_sha256,final_output_key,delivered_at)
    values(intent.user_id,intent.run_id,intent.name,intent.object_path,intent.mime_type,intent.size_bytes,intent.checksum_sha256,intent.final_output_key,now())
    returning * into artifact;
  update public.artifact_upload_intents set state='FINALIZED',finished_at=now() where id=intent.id;
  return to_jsonb(artifact)-'object_path';
end $$;

-- Account cleanup must not remove provider or storage records while their
-- corresponding side effects are unresolved. New work is already fenced by
-- request_account_deletion; these predicates drain work admitted beforehand.
create table public.account_deletion_computer_receipts (
  request_id uuid not null references public.account_deletion_requests(id) on delete cascade,
  provider_id text not null check(length(provider_id) between 1 and 200 and provider_id!~'[[:cntrl:]]'),
  destroyed_at timestamptz not null default now(),
  primary key(request_id,provider_id)
);
alter table public.account_deletion_computer_receipts enable row level security;
revoke all on public.account_deletion_computer_receipts from public,anon,authenticated;
grant select on public.account_deletion_computer_receipts to service_role;

create or replace function public.claim_account_deletion() returns jsonb
language plpgsql security definer set search_path='' as $$
declare request public.account_deletion_requests%rowtype; token uuid:=gen_random_uuid(); artifact_paths jsonb; frame_paths jsonb; providers jsonb;
begin
  select * into request from public.account_deletion_requests d
    where d.completed_at is null and ((d.state in ('PENDING','FAILED') and d.next_attempt_at<=now()) or
      (d.state='CLEANING' and d.lease_expires_at<=now())) and
      (not exists(select 1 from public.computer_operations o where o.user_id=d.user_id and o.state in ('IN_FLIGHT','UNCERTAIN')) or
        exists(select 1 from public.workspace_computers c where c.user_id=d.user_id and c.provider_id is not null) or
        exists(select 1 from public.hermes_workspaces h where h.user_id=d.user_id and h.machine_id is not null)) and
      not exists(select 1 from public.hermes_workspaces h where h.user_id=d.user_id and
        h.active_run is not null and h.machine_id is null) and
      not exists(select 1 from public.artifact_upload_intents i where i.user_id=d.user_id and
        (i.state in ('PENDING','UPLOADED','CLEANUP_REQUIRED') or
          (i.state='REJECTED' and (i.finished_at is null or i.finished_at>now()-interval '3 minutes'))))
    order by d.next_attempt_at,d.requested_at for update skip locked limit 1;
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
  select coalesce(jsonb_agg(targets.provider_id order by targets.provider_id),'[]'::jsonb) into providers from (
    select provider_id from public.workspace_computers where user_id=request.user_id and provider_id is not null
    union select machine_id as provider_id from public.hermes_workspaces where user_id=request.user_id and machine_id is not null
  ) targets where not exists(select 1 from public.account_deletion_computer_receipts receipt
    where receipt.request_id=request.id and receipt.provider_id=targets.provider_id);
  return jsonb_build_object('request_id',request.id,'user_id',request.user_id,'claim_token',token,
    'artifact_paths',artifact_paths,'watch_paths',frame_paths,'computer_provider_ids',providers,
    'computer_provider_id',providers->>0,
    'artifacts_deleted',request.artifacts_deleted_at is not null,'watch_deleted',request.watch_deleted_at is not null,
    'computer_destroyed',request.computer_destroyed_at is not null,'auth_deleted',request.auth_deleted_at is not null);
end $$;

create function public.record_account_deletion_computer_receipt(
  p_claim_token uuid,p_provider_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare request public.account_deletion_requests%rowtype;
begin
  if p_provider_id is null or length(p_provider_id) not between 1 and 200 or p_provider_id~'[[:cntrl:]]' then
    return false;
  end if;
  select * into request from public.account_deletion_requests
    where claim_token=p_claim_token and state='CLEANING' and lease_expires_at>now() for update;
  if not found or not exists(
    select 1 from (
      select provider_id from public.workspace_computers where user_id=request.user_id and provider_id is not null
      union select machine_id as provider_id from public.hermes_workspaces where user_id=request.user_id and machine_id is not null
    ) targets where targets.provider_id=p_provider_id
  ) then return false; end if;
  insert into public.account_deletion_computer_receipts(request_id,provider_id)
    values(request.id,p_provider_id) on conflict(request_id,provider_id) do nothing;
  return true;
end $$;

create or replace function public.record_account_deletion_stage(p_claim_token uuid,p_stage text) returns boolean
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
  elsif p_stage='COMPUTER_DESTROYED' and request.artifacts_deleted_at is not null and request.watch_deleted_at is not null and
    not exists(
      select 1 from (
        select provider_id from public.workspace_computers where user_id=request.user_id and provider_id is not null
        union select machine_id as provider_id from public.hermes_workspaces where user_id=request.user_id and machine_id is not null
      ) targets where not exists(
        select 1 from public.account_deletion_computer_receipts receipt
          where receipt.request_id=request.id and receipt.provider_id=targets.provider_id
      )
    ) then
    -- All known provider machines are now destroyed. This is the durable
    -- reconciliation evidence that makes late operation completion fail closed.
    update public.computer_operations set state='FAILED',finished_at=now(),
      reconciliation_evidence='ACCOUNT_DELETION_PROVIDER_DESTROYED'
      where user_id=request.user_id and state in ('IN_FLIGHT','UNCERTAIN');
    update public.account_deletion_requests set computer_destroyed_at=coalesce(computer_destroyed_at,now()) where id=request.id;
  elsif p_stage='AUTH_DELETED' and request.artifacts_deleted_at is not null and request.watch_deleted_at is not null and
    request.computer_destroyed_at is not null and not exists(select 1 from auth.users where id=request.user_id) then
    update public.account_deletion_requests set auth_deleted_at=coalesce(auth_deleted_at,now()) where id=request.id;
  else
    return false;
  end if;
  return true;
end $$;

revoke all on function public.begin_hermes_pause(uuid,integer,text),
  public.complete_hermes_pause(uuid,integer,text,uuid),
  public.release_failed_hermes_provision(uuid,integer,text),
  public.record_failed_hermes_provision(uuid,integer,text,text),
  public.claim_stale_hermes_recovery(),
  public.record_account_deletion_computer_receipt(uuid,text) from public,anon,authenticated;
grant execute on function public.begin_hermes_pause(uuid,integer,text),
  public.complete_hermes_pause(uuid,integer,text,uuid),
  public.release_failed_hermes_provision(uuid,integer,text),
  public.record_failed_hermes_provision(uuid,integer,text,text),
  public.claim_stale_hermes_recovery(),
  public.record_account_deletion_computer_receipt(uuid,text) to service_role;

-- ============================================================
-- RLS POLICIES
-- ============================================================

-- No browser policy changes. The new receipt table and RPCs are service-only;
-- hermes_workspaces remains protected by RLS and explicit revokes.

-- ============================================================
-- INDEXES AND CONSTRAINTS
-- ============================================================

-- The active-run FK is replaced below after the data-preserving deletion
-- behavior is selected. The old ON DELETE SET NULL action can clear active_run
-- alone and violate hermes_active_execution_pair.
alter table public.hermes_workspaces
  drop constraint hermes_workspaces_active_run_fkey,
  add constraint hermes_workspaces_active_run_fkey
    foreign key(active_run) references public.runs(id)
    on delete no action deferrable initially deferred;

-- ============================================================
-- DOWN MIGRATION (rollback)
-- ============================================================

-- Rollback requires restoring enqueue_message, claim_hermes_workspace, the
-- Hermes artifact and account-cleanup RPCs; dropping the new RPCs, pilot ledgers
-- and receipt table; and restoring hermes_workspaces_active_run_fkey. Keep
-- rollback manual because restoring the race-prone release protocol is unsafe
-- while new workers may still be running.
