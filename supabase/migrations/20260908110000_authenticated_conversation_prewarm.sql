-- A prewarm has no chat run. It therefore has its own account-scoped lease and
-- must be handed to a real run atomically instead of borrowing a fake run id.
alter table public.runtime_config add column prewarm_enabled boolean not null default false;

create table public.hermes_prewarm_leases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lease_token uuid not null unique,
  state text not null check(state in ('PREPARING','READY')),
  preparation_expires_at timestamptz not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  check((state='PREPARING' and expires_at is null and ready_at is null) or
        (state='READY' and expires_at is not null and ready_at is not null))
);
alter table public.hermes_prewarm_leases enable row level security;
revoke all on public.hermes_prewarm_leases from public, anon, authenticated;
grant select, insert, update, delete on public.hermes_prewarm_leases to service_role;

create function public.claim_hermes_prewarm(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; lease public.hermes_prewarm_leases%rowtype; token uuid;
begin
  if p_user_id is null or not coalesce((select runs_enabled and computer_enabled and prewarm_enabled from public.runtime_config where singleton),false) then
    return jsonb_build_object('status','disabled');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,31));
  select * into w from public.hermes_workspaces where user_id=p_user_id for update;
  if not found or w.machine_id is null then return jsonb_build_object('status','unavailable'); end if;
  if w.active_run is not null or w.recovery_token is not null then return jsonb_build_object('status','busy'); end if;
  select * into lease from public.hermes_prewarm_leases where user_id=p_user_id for update;
  if found and ((lease.state='PREPARING' and lease.preparation_expires_at>now()) or
                (lease.state='READY' and lease.expires_at>now())) then
    return jsonb_build_object('status',lower(lease.state),'lease_token',lease.lease_token,'machine_id',w.machine_id);
  end if;
  delete from public.hermes_prewarm_leases where user_id=p_user_id;
  token:=gen_random_uuid();
  insert into public.hermes_prewarm_leases(user_id,lease_token,state,preparation_expires_at)
    values(p_user_id,token,'PREPARING',now()+interval '30 seconds');
  return jsonb_build_object('status','preparing','lease_token',token,'machine_id',w.machine_id);
end $$;

create function public.complete_hermes_prewarm(p_user_id uuid,p_lease_token uuid,p_machine_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if p_user_id is null or p_lease_token is null or p_machine_id is null or length(btrim(p_machine_id)) not between 1 and 200 or p_machine_id~'[[:cntrl:]]' then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,31));
  update public.hermes_prewarm_leases lease set state='READY',ready_at=now(),expires_at=now()+interval '60 seconds'
    where lease.user_id=p_user_id and lease.lease_token=p_lease_token and lease.state='PREPARING'
      and lease.preparation_expires_at>now() and exists(select 1 from public.hermes_workspaces w
        where w.user_id=p_user_id and w.machine_id=p_machine_id and w.active_run is null and w.recovery_token is null);
  get diagnostics changed=row_count;
  if changed=1 then return true; end if;
  -- A late or fenced preparation must not remain reopenable.
  delete from public.hermes_prewarm_leases where user_id=p_user_id and lease_token=p_lease_token and state='PREPARING';
  return false;
end $$;

create function public.abort_hermes_prewarm(p_user_id uuid,p_lease_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  delete from public.hermes_prewarm_leases where user_id=p_user_id and lease_token=p_lease_token and state='PREPARING';
  get diagnostics changed=row_count;
  return changed=1;
end $$;

-- Claiming the real run consumes a valid ready lease in the same transaction.
create or replace function public.claim_hermes_workspace(p_run_id uuid,p_version integer,p_proxy_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; active public.runs%rowtype; w public.hermes_workspaces%rowtype; token uuid;
  pool public.pilot_budgets%rowtype; account_budget public.account_pilot_budgets%rowtype; total_reserved bigint;
begin
  if p_version is null or p_version<=0 or p_proxy_hash is null or p_proxy_hash!~'^[0-9a-f]{64}$' then raise exception 'INVALID_HERMES_CLAIM'; end if;
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.state<>'RUNNING' or r.execution_version<>p_version or r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() then raise exception 'LEASE_LOST'; end if;
  if not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false) then raise exception 'COMPUTER_DISABLED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text,31));
  insert into public.hermes_workspaces(user_id,proxy_hash) values(r.user_id,p_proxy_hash) on conflict(user_id) do nothing;
  select * into w from public.hermes_workspaces where user_id=r.user_id for update;
  if w.active_run is not null then
    if w.recovery_token is not null then raise exception 'COMPUTER_RECOVERY_IN_PROGRESS'; end if;
    select * into active from public.runs where id=w.active_run;
    if active.state='RUNNING' and not active.cancel_requested and active.lease_expires_at is not null and active.lease_expires_at>now() then raise exception 'COMPUTER_BUSY'; end if;
    if w.machine_id is null then raise exception 'COMPUTER_RECOVERY_IN_PROGRESS'; end if;
    token:=gen_random_uuid(); update public.hermes_workspaces set recovery_token=token,recovery_started_at=now() where user_id=r.user_id returning * into w;
    return to_jsonb(w)||jsonb_build_object('status','recovery_required','recovery_action',case when w.remote_start_state='starting' or w.provision_cleanup_required or w.base_url is null or w.api_key is null or w.revision is null then 'destroy' else 'pause' end);
  end if;
  if not exists(select 1 from public.account_pilot_reservations where run_id=r.id and reservation_kind='hermes') then
    insert into public.account_pilot_budgets(user_id) values(r.user_id) on conflict(user_id) do nothing;
    select * into pool from public.pilot_budgets where kind='computer' for update;
    if not found or pool.allocated_micros+250000>pool.limit_micros then raise exception 'COMPUTER_BUDGET_EXHAUSTED'; end if;
    select * into account_budget from public.account_pilot_budgets where user_id=r.user_id for update;
    if account_budget.allocated_micros+250000>account_budget.limit_micros then raise exception 'ACCOUNT_PILOT_BUDGET_EXHAUSTED'; end if;
    insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros) values(r.id,r.user_id,'hermes',250000);
    update public.pilot_budgets set allocated_micros=allocated_micros+250000 where kind='computer';
    update public.account_pilot_budgets set allocated_micros=allocated_micros+250000,updated_at=now() where user_id=r.user_id;
  end if;
  select coalesce(sum(reserved_micros),0) into total_reserved from public.account_pilot_reservations where run_id=r.id and user_id=r.user_id;
  if total_reserved<=0 then raise exception 'RESERVATION_MISMATCH'; end if;
  insert into public.hermes_usage_intents(run_id,execution_version,user_id,reserved_micros) values(r.id,p_version,r.user_id,total_reserved) on conflict do nothing;
  update public.hermes_workspaces set proxy_hash=p_proxy_hash,active_run=r.id,active_execution_version=p_version,remote_run=null,remote_start_state='idle',recovery_token=null,recovery_started_at=null where user_id=r.user_id returning * into w;
  delete from public.hermes_prewarm_leases where user_id=r.user_id and state='READY' and expires_at>now();
  return to_jsonb(w)||jsonb_build_object('status','claimed');
end $$;

revoke all on function public.claim_hermes_prewarm(uuid),public.complete_hermes_prewarm(uuid,uuid,text),public.abort_hermes_prewarm(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_hermes_prewarm(uuid),public.complete_hermes_prewarm(uuid,uuid,text),public.abort_hermes_prewarm(uuid,uuid) to service_role;
