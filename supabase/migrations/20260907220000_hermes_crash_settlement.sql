-- Close the two remaining Hermes crash windows:
-- 1. mark a remote start before the provider request so an ambiguous outcome
--    can only be recovered by destroying the machine;
-- 2. create a durable usage intent with every workspace claim and require a
--    known/unknown settlement before any normal fence release.

alter table public.hermes_workspaces
  add column remote_start_state text not null default 'idle'
    check(remote_start_state in ('idle','starting','started'));

update public.hermes_workspaces
set remote_start_state=case
  when active_run is null then 'idle'
  when remote_run is not null then 'started'
  else 'starting'
end;

create table public.hermes_usage_intents (
  run_id uuid not null,
  execution_version integer not null check(execution_version>0),
  user_id uuid not null,
  reserved_micros bigint not null check(reserved_micros>0),
  started_at timestamptz not null default now(),
  rate_card_id text check(rate_card_id~'^[A-Za-z0-9._-]{1,80}$'),
  vcpu_count integer check(vcpu_count>0),
  memory_mib integer check(memory_mib>0),
  settled_at timestamptz,
  primary key(run_id,execution_version),
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade
);
alter table public.hermes_usage_intents enable row level security;
revoke all on public.hermes_usage_intents from public,anon,authenticated;
grant select on public.hermes_usage_intents to service_role;

insert into public.hermes_usage_intents(run_id,execution_version,user_id,reserved_micros,started_at)
select workspace.active_run,workspace.active_execution_version,workspace.user_id,
  sum(reservation.reserved_micros),
  coalesce(run.heartbeat_at,run.created_at,workspace.created_at)
from public.hermes_workspaces workspace
join public.runs run on run.id=workspace.active_run and run.user_id=workspace.user_id
join public.account_pilot_reservations reservation
  on reservation.run_id=workspace.active_run and reservation.user_id=workspace.user_id
where workspace.active_run is not null and workspace.active_execution_version is not null
group by workspace.active_run,workspace.active_execution_version,workspace.user_id,
  run.heartbeat_at,run.created_at,workspace.created_at
on conflict do nothing;

alter table public.hermes_usage_settlements
  alter column rate_card_id drop not null,
  alter column duration_ms drop not null,
  alter column vcpu_count drop not null,
  alter column memory_mib drop not null;

create or replace function public.record_hermes_usage_settlement(
  p_run_id uuid,p_version integer,p_idempotency_key text,p_status text,p_reserved_micros bigint,
  p_model_cost_micros bigint,p_compute_cost_micros bigint,p_total_cost_micros bigint,
  p_usage_fingerprint text,p_rate_card_id text,p_duration_ms bigint,p_vcpu_count integer,
  p_memory_mib integer,p_missing_fields jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare
  r public.runs%rowtype;
  existing public.hermes_usage_settlements%rowtype;
  total_reserved bigint;
  hermes_reserved bigint;
begin
  if p_version is null or p_version<=0 or
    p_idempotency_key is distinct from p_run_id::text||':'||p_version::text||':hermes_usage' or
    p_status not in ('known','unknown') or p_reserved_micros is null or p_reserved_micros<=0 or
    p_usage_fingerprint!~'^[0-9a-f]{64}$' or
    (p_rate_card_id is not null and p_rate_card_id!~'^[A-Za-z0-9._-]{1,80}$') or
    (p_duration_ms is not null and p_duration_ms<0) or
    (p_vcpu_count is not null and p_vcpu_count<=0) or
    (p_memory_mib is not null and p_memory_mib<=0) or
    p_missing_fields is null or jsonb_typeof(p_missing_fields)<>'array'
    then raise exception 'INVALID_HERMES_SETTLEMENT';
  end if;

  select * into existing from public.hermes_usage_settlements
    where run_id=p_run_id and execution_version=p_version and settlement_kind='hermes_usage';
  if found then
    if existing.idempotency_key<>p_idempotency_key or existing.usage_fingerprint<>p_usage_fingerprint or
      existing.status<>p_status or
      (existing.reserved_micros,existing.model_cost_micros,existing.compute_cost_micros,existing.total_cost_micros,
        existing.rate_card_id,existing.duration_ms,existing.vcpu_count,existing.memory_mib,existing.missing_fields)
      is distinct from
      (p_reserved_micros,p_model_cost_micros,p_compute_cost_micros,p_total_cost_micros,
        p_rate_card_id,p_duration_ms,p_vcpu_count,p_memory_mib,p_missing_fields)
      then raise exception 'HERMES_SETTLEMENT_CONFLICT'; end if;
    return true;
  end if;

  select * into r from public.runs where id=p_run_id for update;
  if not found or (r.execution_version<>p_version and not exists(
      select 1 from public.hermes_workspaces workspace
      where workspace.active_run=p_run_id and workspace.active_execution_version=p_version
        and workspace.user_id=r.user_id
    )) then raise exception 'LEASE_LOST'; end if;

  select coalesce(sum(reserved_micros),0),
    coalesce(sum(reserved_micros) filter(where reservation_kind='hermes'),0)
    into total_reserved,hermes_reserved
    from public.account_pilot_reservations where run_id=p_run_id and user_id=r.user_id;
  if total_reserved<>p_reserved_micros or hermes_reserved<=0 then raise exception 'RESERVATION_MISMATCH'; end if;

  if p_status='known' then
    if p_rate_card_id is null or p_duration_ms is null or p_vcpu_count is null or p_memory_mib is null or
      p_model_cost_micros is null or p_compute_cost_micros is null or p_total_cost_micros is null or
      p_total_cost_micros<>p_model_cost_micros+p_compute_cost_micros or
      p_model_cost_micros>r.reserved_cost_micros or p_compute_cost_micros>hermes_reserved or
      p_total_cost_micros>total_reserved or jsonb_array_length(p_missing_fields)<>0
      then raise exception 'HERMES_COST_LIMIT_BREACHED'; end if;
  elsif p_model_cost_micros is not null or p_compute_cost_micros is not null or
    p_total_cost_micros is not null or jsonb_array_length(p_missing_fields)=0 then
    raise exception 'INVALID_HERMES_SETTLEMENT';
  end if;

  insert into public.hermes_usage_settlements(run_id,execution_version,user_id,settlement_kind,idempotency_key,
    status,reserved_micros,model_cost_micros,compute_cost_micros,total_cost_micros,usage_fingerprint,
    rate_card_id,duration_ms,vcpu_count,memory_mib,missing_fields)
  values(p_run_id,p_version,r.user_id,'hermes_usage',p_idempotency_key,p_status,p_reserved_micros,
    p_model_cost_micros,p_compute_cost_micros,p_total_cost_micros,p_usage_fingerprint,p_rate_card_id,
    p_duration_ms,p_vcpu_count,p_memory_mib,p_missing_fields);
  update public.hermes_usage_intents set settled_at=now()
    where run_id=p_run_id and execution_version=p_version;
  return true;
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
  total_reserved bigint;
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
    if w.machine_id is null then raise exception 'COMPUTER_RECOVERY_IN_PROGRESS'; end if;
    token:=gen_random_uuid();
    update public.hermes_workspaces set recovery_token=token,recovery_started_at=now()
      where user_id=r.user_id returning * into w;
    return to_jsonb(w)||jsonb_build_object(
      'status','recovery_required',
      'recovery_action',case when w.remote_start_state='starting' or w.provision_cleanup_required or
        w.base_url is null or w.api_key is null or w.revision is null then 'destroy' else 'pause' end
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

  select coalesce(sum(reserved_micros),0) into total_reserved
    from public.account_pilot_reservations where run_id=r.id and user_id=r.user_id;
  if total_reserved<=0 then raise exception 'RESERVATION_MISMATCH'; end if;
  insert into public.hermes_usage_intents(run_id,execution_version,user_id,reserved_micros)
    values(r.id,p_version,r.user_id,total_reserved) on conflict do nothing;
  update public.hermes_workspaces set proxy_hash=p_proxy_hash,active_run=r.id,
    active_execution_version=p_version,remote_run=null,remote_start_state='idle',
    recovery_token=null,recovery_started_at=null
    where user_id=r.user_id returning * into w;
  return to_jsonb(w)||jsonb_build_object('status','claimed');
end $$;

create function public.begin_hermes_remote_start(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_rate_card_id text,p_vcpu_count integer,p_memory_mib integer
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if p_rate_card_id is null or p_rate_card_id!~'^[A-Za-z0-9._-]{1,80}$' or
    p_vcpu_count is null or p_vcpu_count<=0 or p_memory_mib is null or p_memory_mib<=0 then
    raise exception 'INVALID_HERMES_USAGE_INTENT';
  end if;
  update public.hermes_workspaces set remote_start_state='starting',remote_run=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and recovery_token is null and machine_id is not null and remote_start_state='idle';
  get diagnostics changed=row_count;
  if changed<>1 then return false; end if;
  update public.hermes_usage_intents set rate_card_id=p_rate_card_id,
    vcpu_count=p_vcpu_count,memory_mib=p_memory_mib
    where run_id=p_run_id and execution_version=p_version;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'HERMES_USAGE_INTENT_MISSING'; end if;
  return true;
end $$;

create function public.record_hermes_remote_start(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_remote_run text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if p_remote_run is null or length(btrim(p_remote_run)) not between 1 and 200 or p_remote_run~'[[:cntrl:]]' then
    return false;
  end if;
  update public.hermes_workspaces set remote_run=p_remote_run,remote_start_state='started'
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and recovery_token is null and remote_start_state='starting' and remote_run is null;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.complete_hermes_pause(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_pause_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,remote_start_state='idle',
      recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and recovery_token=p_pause_token and machine_id is not null and exists(
        select 1 from public.hermes_usage_settlements settlement
        where settlement.run_id=p_run_id and settlement.execution_version=p_version
          and settlement.settlement_kind='hermes_usage'
      );
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.release_failed_hermes_provision(
  p_run_id uuid,p_version integer,p_proxy_hash text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,remote_start_state='idle',
      recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and machine_id is null and exists(
        select 1 from public.hermes_usage_settlements settlement
        where settlement.run_id=p_run_id and settlement.execution_version=p_version
          and settlement.settlement_kind='hermes_usage'
      );
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.record_failed_hermes_provision(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_machine_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if p_machine_id is null or length(btrim(p_machine_id)) not between 1 and 200 or p_machine_id~'[[:cntrl:]]' then
    return false;
  end if;
  update public.hermes_workspaces set machine_id=p_machine_id,
      base_url=null,api_key=null,revision=null,remote_run=null,remote_start_state='idle',
      provision_cleanup_required=true
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and (machine_id is null or machine_id=p_machine_id);
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create function public.complete_hermes_destroyed_start(
  p_run_id uuid,p_version integer,p_proxy_hash text,p_machine_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,remote_start_state='idle',
      recovery_token=null,recovery_started_at=null,machine_id=null,base_url=null,api_key=null,revision=null,
      provision_cleanup_required=false
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and machine_id=p_machine_id and remote_start_state='starting' and remote_run is null and exists(
        select 1 from public.hermes_usage_settlements settlement
        where settlement.run_id=p_run_id and settlement.execution_version=p_version
          and settlement.settlement_kind='hermes_usage'
      );
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.claim_stale_hermes_recovery() returns jsonb
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
    when w.remote_start_state='starting' or w.provision_cleanup_required or w.base_url is null or
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
declare
  w public.hermes_workspaces%rowtype;
  active public.runs%rowtype;
  intent public.hermes_usage_intents%rowtype;
  changed integer;
  duration bigint;
  missing jsonb:='["inputTokens","outputTokens","workerCrashed"]'::jsonb;
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

  select * into intent from public.hermes_usage_intents
    where run_id=p_active_run and execution_version=p_active_version for update;
  if not found then
    insert into public.hermes_usage_intents(run_id,execution_version,user_id,reserved_micros,started_at)
    select p_active_run,p_active_version,p_user_id,sum(reserved_micros),
      coalesce(active.heartbeat_at,active.created_at,w.created_at)
    from public.account_pilot_reservations
    where run_id=p_active_run and user_id=p_user_id
    group by active.heartbeat_at,active.created_at,w.created_at
    returning * into intent;
  end if;
  if intent.run_id is null then raise exception 'HERMES_USAGE_INTENT_MISSING'; end if;
  duration:=greatest(0,floor(extract(epoch from (now()-intent.started_at))*1000)::bigint);
  if intent.rate_card_id is null then missing:=missing||'["rateCardId"]'::jsonb; end if;
  if intent.vcpu_count is null then missing:=missing||'["vcpuCount"]'::jsonb; end if;
  if intent.memory_mib is null then missing:=missing||'["memoryMib"]'::jsonb; end if;
  if not exists(select 1 from public.hermes_usage_settlements settlement
      where settlement.run_id=p_active_run and settlement.execution_version=p_active_version
        and settlement.settlement_kind='hermes_usage') then
    perform public.record_hermes_usage_settlement(
      p_active_run,p_active_version,p_active_run::text||':'||p_active_version::text||':hermes_usage',
      'unknown',intent.reserved_micros,null,null,null,repeat('0',64),intent.rate_card_id,duration,
      intent.vcpu_count,intent.memory_mib,missing
    );
  end if;

  if w.machine_id is null or w.remote_start_state='starting' or w.provision_cleanup_required or
    w.base_url is null or w.api_key is null or w.revision is null then
    update public.hermes_workspaces set active_run=null,active_execution_version=null,remote_run=null,
      remote_start_state='idle',recovery_token=null,recovery_started_at=null,machine_id=null,
      base_url=null,api_key=null,revision=null,provision_cleanup_required=false
      where user_id=p_user_id and recovery_token=p_recovery_token;
  else
    update public.hermes_workspaces set active_run=null,active_execution_version=null,remote_run=null,
      remote_start_state='idle',recovery_token=null,recovery_started_at=null
      where user_id=p_user_id and recovery_token=p_recovery_token;
  end if;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.release_hermes_workspace(
  p_run_id uuid,p_version integer,p_proxy_hash text
) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces
    set active_run=null,active_execution_version=null,remote_run=null,remote_start_state='idle',
      recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash
      and recovery_token is null and exists(
        select 1 from public.hermes_usage_settlements settlement
        where settlement.run_id=p_run_id and settlement.execution_version=p_version
          and settlement.settlement_kind='hermes_usage'
      );
  get diagnostics changed=row_count;
  return changed=1;
end $$;

revoke all on function public.begin_hermes_remote_start(uuid,integer,text,text,integer,integer),
  public.record_hermes_remote_start(uuid,integer,text,text),
  public.complete_hermes_destroyed_start(uuid,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.begin_hermes_remote_start(uuid,integer,text,text,integer,integer),
  public.record_hermes_remote_start(uuid,integer,text,text),
  public.complete_hermes_destroyed_start(uuid,integer,text,text)
  to service_role;
