-- Durable, idempotent actual-cost accounting for Hermes runs. Reservations
-- remain non-refundable pilot ceilings; settlement records observed spend.
create table public.hermes_usage_settlements (
  run_id uuid not null references public.runs(id) on delete cascade,
  execution_version integer not null check(execution_version>0),
  user_id uuid not null,
  settlement_kind text not null check(settlement_kind='hermes_usage'),
  idempotency_key text not null unique,
  status text not null check(status in ('known','unknown')),
  reserved_micros bigint not null check(reserved_micros>0),
  model_cost_micros bigint check(model_cost_micros>=0),
  compute_cost_micros bigint check(compute_cost_micros>=0),
  total_cost_micros bigint check(total_cost_micros>=0),
  usage_fingerprint text not null check(usage_fingerprint~'^[0-9a-f]{64}$'),
  rate_card_id text not null check(rate_card_id~'^[A-Za-z0-9._-]{1,80}$'),
  duration_ms bigint not null check(duration_ms>=0),
  vcpu_count integer not null check(vcpu_count>0),
  memory_mib integer not null check(memory_mib>0),
  missing_fields jsonb not null default '[]'::jsonb check(jsonb_typeof(missing_fields)='array'),
  created_at timestamptz not null default now(),
  primary key(run_id,execution_version,settlement_kind),
  foreign key(run_id,user_id) references public.runs(id,user_id) on delete cascade,
  check(
    (status='known' and model_cost_micros is not null and compute_cost_micros is not null and
      total_cost_micros=model_cost_micros+compute_cost_micros and jsonb_array_length(missing_fields)=0) or
    (status='unknown' and model_cost_micros is null and compute_cost_micros is null and
      total_cost_micros is null and jsonb_array_length(missing_fields)>0)
  )
);
alter table public.hermes_usage_settlements enable row level security;
revoke all on public.hermes_usage_settlements from public,anon,authenticated;
grant select on public.hermes_usage_settlements to service_role;

create function public.record_hermes_usage_settlement(
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
    p_usage_fingerprint!~'^[0-9a-f]{64}$' or p_rate_card_id!~'^[A-Za-z0-9._-]{1,80}$' or
    p_duration_ms is null or p_duration_ms<0 or p_vcpu_count is null or p_vcpu_count<=0 or
    p_memory_mib is null or p_memory_mib<=0 or p_missing_fields is null or jsonb_typeof(p_missing_fields)<>'array'
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
  if not found or r.execution_version<>p_version then raise exception 'LEASE_LOST'; end if;
  select coalesce(sum(reserved_micros),0),
    coalesce(sum(reserved_micros) filter(where reservation_kind='hermes'),0)
    into total_reserved,hermes_reserved
    from public.account_pilot_reservations where run_id=p_run_id and user_id=r.user_id;
  if total_reserved<>p_reserved_micros or hermes_reserved<=0 then raise exception 'RESERVATION_MISMATCH'; end if;
  if p_status='known' then
    if p_model_cost_micros is null or p_compute_cost_micros is null or p_total_cost_micros is null or
      p_total_cost_micros<>p_model_cost_micros+p_compute_cost_micros or p_model_cost_micros>r.reserved_cost_micros or
      p_compute_cost_micros>hermes_reserved or p_total_cost_micros>total_reserved or jsonb_array_length(p_missing_fields)<>0
      then raise exception 'HERMES_COST_LIMIT_BREACHED'; end if;
  elsif p_model_cost_micros is not null or p_compute_cost_micros is not null or p_total_cost_micros is not null or
    jsonb_array_length(p_missing_fields)=0 then raise exception 'INVALID_HERMES_SETTLEMENT';
  end if;
  insert into public.hermes_usage_settlements(run_id,execution_version,user_id,settlement_kind,idempotency_key,
    status,reserved_micros,model_cost_micros,compute_cost_micros,total_cost_micros,usage_fingerprint,
    rate_card_id,duration_ms,vcpu_count,memory_mib,missing_fields)
  values(p_run_id,p_version,r.user_id,'hermes_usage',p_idempotency_key,p_status,p_reserved_micros,
    p_model_cost_micros,p_compute_cost_micros,p_total_cost_micros,p_usage_fingerprint,p_rate_card_id,
    p_duration_ms,p_vcpu_count,p_memory_mib,p_missing_fields);
  return true;
end $$;

revoke all on function public.record_hermes_usage_settlement(uuid,integer,text,text,bigint,bigint,bigint,bigint,text,text,bigint,integer,integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.record_hermes_usage_settlement(uuid,integer,text,text,bigint,bigint,bigint,bigint,text,text,bigint,integer,integer,jsonb)
  to service_role;
