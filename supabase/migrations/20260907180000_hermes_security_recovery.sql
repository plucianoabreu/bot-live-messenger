-- Rotate model-gateway credentials per run/version and require an explicit
-- provider pause acknowledgement before an abandoned account fence is cleared.
alter table public.hermes_workspaces
  add column active_execution_version integer check(active_execution_version>0),
  add column recovery_token uuid,
  add column recovery_started_at timestamptz;

update public.hermes_workspaces w set active_execution_version=r.execution_version
from public.runs r where w.active_run=r.id;

alter table public.hermes_workspaces
  add constraint hermes_active_execution_pair
  check((active_run is null)=(active_execution_version is null)),
  add constraint hermes_proxy_hash_format
  check(proxy_hash ~ '^[0-9a-f]{64}$'),
  add constraint hermes_recovery_pair
  check((recovery_token is null)=(recovery_started_at is null));

create or replace function public.claim_hermes_workspace(p_run_id uuid,p_version integer,p_proxy_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  r public.runs%rowtype;
  active public.runs%rowtype;
  w public.hermes_workspaces%rowtype;
  token uuid;
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
    -- An ambiguous/abandoned pause must be reconciled with the provider using
    -- the existing durable token. Time alone never replaces the recovery owner.
    if w.recovery_token is not null then raise exception 'COMPUTER_RECOVERY_IN_PROGRESS'; end if;
    select * into active from public.runs where id=w.active_run;
    if active.state='RUNNING' and not active.cancel_requested and active.lease_expires_at is not null and active.lease_expires_at>now() then
      raise exception 'COMPUTER_BUSY';
    end if;
    token:=gen_random_uuid();
    update public.hermes_workspaces set recovery_token=token,recovery_started_at=now()
      where user_id=r.user_id returning * into w;
    return to_jsonb(w)||jsonb_build_object('status','recovery_required');
  end if;

  -- Reserve only after the workspace is known to be claimable. Recovery retries
  -- cannot multiply the computer reservation before the previous VM is paused.
  update public.pilot_budgets set allocated_micros=allocated_micros+250000
    where kind='computer' and allocated_micros+250000<=limit_micros;
  if not found then raise exception 'COMPUTER_BUDGET_EXHAUSTED'; end if;
  update public.hermes_workspaces set proxy_hash=p_proxy_hash,active_run=r.id,
    active_execution_version=p_version,remote_run=null,recovery_token=null,recovery_started_at=null
    where user_id=r.user_id returning * into w;
  return to_jsonb(w)||jsonb_build_object('status','claimed');
end $$;

create function public.release_hermes_workspace(p_run_id uuid,p_version integer,p_proxy_hash text) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update public.hermes_workspaces set active_run=null,active_execution_version=null,remote_run=null,
    recovery_token=null,recovery_started_at=null
    where active_run=p_run_id and active_execution_version=p_version and proxy_hash=p_proxy_hash;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create function public.complete_hermes_recovery(
  p_user_id uuid,p_active_run uuid,p_active_version integer,p_recovery_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; active public.runs%rowtype; changed integer;
begin
  select * into w from public.hermes_workspaces where user_id=p_user_id for update;
  if not found or w.machine_id is null or w.active_run is distinct from p_active_run or
    w.active_execution_version is distinct from p_active_version or w.recovery_token is distinct from p_recovery_token then
    return false;
  end if;
  select * into active from public.runs where id=w.active_run;
  if found and active.state='RUNNING' and not active.cancel_requested and active.lease_expires_at is not null and active.lease_expires_at>now() then
    return false;
  end if;
  update public.hermes_workspaces set active_run=null,active_execution_version=null,remote_run=null,
    recovery_token=null,recovery_started_at=null where user_id=p_user_id and recovery_token=p_recovery_token;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create or replace function public.authorize_hermes_model(p_proxy_hash text,p_cost bigint) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; w public.hermes_workspaces%rowtype; allocated bigint;
begin
  select * into w from public.hermes_workspaces where proxy_hash=p_proxy_hash for update;
  if not found or w.active_run is null or w.active_execution_version is null then raise exception 'UNAUTHORIZED'; end if;
  select * into r from public.runs where id=w.active_run for update;
  if not found or r.state<>'RUNNING' or r.execution_version<>w.active_execution_version or
    r.cancel_requested or r.lease_expires_at is null or r.lease_expires_at<=now() then raise exception 'LEASE_LOST'; end if;
  if not coalesce((select runs_enabled and computer_enabled from public.runtime_config where singleton),false) then
    raise exception 'COMPUTER_DISABLED';
  end if;
  if exists(select 1 from public.model_calls where run_id=r.id and execution_version<>w.active_execution_version) then
    raise exception 'LEASE_LOST';
  end if;
  select coalesce(sum(reserved_micros),0) into allocated from public.model_calls where run_id=r.id;
  if p_cost is null or p_cost<=0 or allocated+p_cost>r.reserved_cost_micros then raise exception 'BUDGET_EXCEEDED'; end if;
  insert into public.model_calls(run_id,execution_version,reserved_micros)
    values(r.id,w.active_execution_version,p_cost)
    on conflict(run_id) do update set reserved_micros=public.model_calls.reserved_micros+excluded.reserved_micros;
end $$;

revoke all on function public.release_hermes_workspace(uuid,integer,text),
  public.complete_hermes_recovery(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.release_hermes_workspace(uuid,integer,text),
  public.complete_hermes_recovery(uuid,uuid,integer,uuid) to service_role;
