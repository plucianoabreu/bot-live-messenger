-- Expiry is independent of browser tabs. A fenced PAUSING state prevents a
-- late provider pause from racing a real-run handoff.
alter table public.hermes_prewarm_leases add column cleanup_token uuid, add column cleanup_started_at timestamptz;
alter table public.hermes_prewarm_leases drop constraint hermes_prewarm_leases_state_check;
alter table public.hermes_prewarm_leases drop constraint hermes_prewarm_leases_check;
alter table public.hermes_prewarm_leases add constraint hermes_prewarm_leases_state_check check(state in ('PREPARING','READY','PAUSING'));
alter table public.hermes_prewarm_leases add constraint hermes_prewarm_leases_shape_check check(
  (state='PREPARING' and expires_at is null and ready_at is null) or
  (state in ('READY','PAUSING') and expires_at is not null and ready_at is not null)
);

create table public.hermes_prewarm_settlements (
  lease_token uuid primary key,
  status text not null check(status in ('known','unknown')),
  compute_cost_micros bigint,
  duration_ms bigint,
  settled_at timestamptz not null default now(),
  check((status='known' and compute_cost_micros is not null and compute_cost_micros>=0 and duration_ms is not null and duration_ms>=0) or
        (status='unknown' and compute_cost_micros is null))
);
alter table public.hermes_prewarm_settlements enable row level security;
revoke all on public.hermes_prewarm_settlements from public, anon, authenticated;
grant select, insert on public.hermes_prewarm_settlements to service_role;

create function public.claim_expired_hermes_prewarm() returns jsonb
language plpgsql security definer set search_path='' as $$
declare lease public.hermes_prewarm_leases%rowtype; w public.hermes_workspaces%rowtype; token uuid:=gen_random_uuid();
begin
  select * into lease from public.hermes_prewarm_leases
    where (state='READY' and expires_at<=now()) or (state='PAUSING' and cleanup_started_at<=now()-interval '5 minutes')
    order by coalesce(expires_at,cleanup_started_at) for update skip locked limit 1;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(lease.user_id::text,31));
  select * into w from public.hermes_workspaces where user_id=lease.user_id for update;
  if not found or w.active_run is not null or w.recovery_token is not null or w.machine_id is null then return null; end if;
  update public.hermes_prewarm_leases set state='PAUSING',cleanup_token=token,cleanup_started_at=now()
    where user_id=lease.user_id and lease_token=lease.lease_token;
  return jsonb_build_object('user_id',lease.user_id,'machine_id',w.machine_id,'lease_token',lease.lease_token,'cleanup_token',token,'ready_at',lease.ready_at);
end $$;

create function public.settle_hermes_prewarm(p_lease_token uuid,p_status text,p_compute_cost_micros bigint,p_duration_ms bigint) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null or p_status not in ('known','unknown') or (p_status='known' and (p_compute_cost_micros is null or p_compute_cost_micros<0 or p_duration_ms is null or p_duration_ms<0)) then return false; end if;
  insert into public.hermes_prewarm_settlements(lease_token,status,compute_cost_micros,duration_ms)
    values(p_lease_token,p_status,case when p_status='known' then p_compute_cost_micros else null end,case when p_status='known' then p_duration_ms else null end)
    on conflict(lease_token) do nothing;
  return exists(select 1 from public.hermes_prewarm_settlements where lease_token=p_lease_token);
end $$;

create function public.complete_expired_hermes_prewarm(p_lease_token uuid,p_cleanup_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  delete from public.hermes_prewarm_leases lease where lease.lease_token=p_lease_token and lease.state='PAUSING'
    and lease.cleanup_token=p_cleanup_token and exists(select 1 from public.hermes_prewarm_settlements settlement where settlement.lease_token=lease.lease_token);
  get diagnostics changed=row_count;
  return changed=1;
end $$;

revoke all on function public.claim_expired_hermes_prewarm(),public.settle_hermes_prewarm(uuid,text,bigint,bigint),public.complete_expired_hermes_prewarm(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_expired_hermes_prewarm(),public.settle_hermes_prewarm(uuid,text,bigint,bigint),public.complete_expired_hermes_prewarm(uuid,uuid) to service_role;
