-- Per-run performance marks for diagnosis. These fields intentionally never store
-- user messages, assistant output, prompts, credentials, model requests, or IDs.
create table public.chat_latency_measurements (
  run_id uuid not null references public.runs(id) on delete cascade,
  execution_version integer not null check(execution_version > 0),
  worker_claimed_ms bigint not null check(worker_claimed_ms >= 0),
  history_loaded_ms bigint check(history_loaded_ms >= 0),
  memory_loaded_ms bigint check(memory_loaded_ms >= 0),
  executor_started_ms bigint check(executor_started_ms >= 0),
  direct_provider_started_ms bigint check(direct_provider_started_ms >= 0),
  direct_provider_completed_ms bigint check(direct_provider_completed_ms >= 0),
  hermes_workspace_claimed_ms bigint check(hermes_workspace_claimed_ms >= 0),
  hermes_provision_started_ms bigint check(hermes_provision_started_ms >= 0),
  hermes_resume_started_ms bigint check(hermes_resume_started_ms >= 0),
  hermes_sandbox_ready_ms bigint check(hermes_sandbox_ready_ms >= 0),
  hermes_remote_started_ms bigint check(hermes_remote_started_ms >= 0),
  hermes_remote_completed_ms bigint check(hermes_remote_completed_ms >= 0),
  executor_finished_ms bigint check(executor_finished_ms >= 0),
  persistence_completed_ms bigint check(persistence_completed_ms >= 0),
  recorded_at timestamptz not null default now(),
  primary key(run_id, execution_version)
);

alter table public.chat_latency_measurements enable row level security;
revoke all on public.chat_latency_measurements from public, anon, authenticated;
grant select on public.chat_latency_measurements to service_role;
create policy service_role_chat_latency_read on public.chat_latency_measurements for select to service_role using(true);

create function public.record_chat_latency_measurement(
  p_run_id uuid,
  p_version integer,
  p_worker_claimed_ms bigint,
  p_history_loaded_ms bigint,
  p_memory_loaded_ms bigint,
  p_executor_started_ms bigint,
  p_direct_provider_started_ms bigint,
  p_direct_provider_completed_ms bigint,
  p_hermes_workspace_claimed_ms bigint,
  p_hermes_provision_started_ms bigint,
  p_hermes_resume_started_ms bigint,
  p_hermes_sandbox_ready_ms bigint,
  p_hermes_remote_started_ms bigint,
  p_hermes_remote_completed_ms bigint,
  p_executor_finished_ms bigint,
  p_persistence_completed_ms bigint
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
  if p_run_id is null or p_version is null or p_version <= 0 or p_worker_claimed_ms is null or p_worker_claimed_ms < 0 or
    p_history_loaded_ms < 0 or p_memory_loaded_ms < 0 or p_executor_started_ms < 0 or p_direct_provider_started_ms < 0 or p_direct_provider_completed_ms < 0 or
    p_hermes_workspace_claimed_ms < 0 or p_hermes_provision_started_ms < 0 or p_hermes_resume_started_ms < 0 or p_hermes_sandbox_ready_ms < 0 or
    p_hermes_remote_started_ms < 0 or p_hermes_remote_completed_ms < 0 or p_executor_finished_ms < 0 or p_persistence_completed_ms < 0 then
    raise exception 'INVALID_CHAT_LATENCY_MEASUREMENT';
  end if;
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.state not in ('RUNNING','SUCCEEDED') or r.execution_version <> p_version or r.cancel_requested then return false; end if;
  insert into public.chat_latency_measurements(
    run_id, execution_version, worker_claimed_ms, history_loaded_ms, memory_loaded_ms, executor_started_ms,
    direct_provider_started_ms,direct_provider_completed_ms,hermes_workspace_claimed_ms,hermes_provision_started_ms,hermes_resume_started_ms,hermes_sandbox_ready_ms,hermes_remote_started_ms,
    hermes_remote_completed_ms,executor_finished_ms,persistence_completed_ms
  ) values (
    p_run_id,p_version,p_worker_claimed_ms,p_history_loaded_ms,p_memory_loaded_ms,p_executor_started_ms,
    p_direct_provider_started_ms,p_direct_provider_completed_ms,p_hermes_workspace_claimed_ms,p_hermes_provision_started_ms,p_hermes_resume_started_ms,p_hermes_sandbox_ready_ms,p_hermes_remote_started_ms,
    p_hermes_remote_completed_ms,p_executor_finished_ms,p_persistence_completed_ms
  ) on conflict(run_id, execution_version) do nothing;
  return true;
end $$;

revoke all on function public.record_chat_latency_measurement(uuid,integer,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.record_chat_latency_measurement(uuid,integer,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint) to service_role;

-- Browser and admission spans use their own monotonic clocks. They are owner-checked
-- before write and intentionally contain no message, response or browser identifier.
create table public.chat_latency_client_measurements (
 run_id uuid primary key references public.runs(id) on delete cascade,
 admission_enqueued_ms bigint check(admission_enqueued_ms >= 0),
 dispatch_completed_ms bigint check(dispatch_completed_ms >= 0),
 browser_admission_received_ms bigint check(browser_admission_received_ms >= 0),
 browser_answer_dom_ready_ms bigint check(browser_answer_dom_ready_ms >= 0),
 recorded_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.chat_latency_client_measurements enable row level security;
revoke all on public.chat_latency_client_measurements from public,anon,authenticated;
grant select on public.chat_latency_client_measurements to service_role;
create policy service_role_chat_latency_client_read on public.chat_latency_client_measurements for select to service_role using(true);

create function public.record_chat_latency_client_measurement(p_run_id uuid,p_stage text,p_elapsed_ms bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
 if p_stage not in ('admission_enqueued','dispatch_completed','browser_admission_received','browser_answer_dom_ready') or p_elapsed_ms is null or p_elapsed_ms<0 or p_elapsed_ms>3600000 then
  raise exception 'INVALID_CHAT_LATENCY_CLIENT_MEASUREMENT';
 end if;
 select * into r from public.runs where id=p_run_id;
 if not found or r.user_id is distinct from auth.uid() then return false; end if;
 insert into public.chat_latency_client_measurements(run_id,admission_enqueued_ms,dispatch_completed_ms,browser_admission_received_ms,browser_answer_dom_ready_ms)
 values(r.id,
  case when p_stage='admission_enqueued' then p_elapsed_ms end,
  case when p_stage='dispatch_completed' then p_elapsed_ms end,
  case when p_stage='browser_admission_received' then p_elapsed_ms end,
  case when p_stage='browser_answer_dom_ready' then p_elapsed_ms end)
 on conflict(run_id) do update set
  admission_enqueued_ms=coalesce(excluded.admission_enqueued_ms,public.chat_latency_client_measurements.admission_enqueued_ms),
  dispatch_completed_ms=coalesce(excluded.dispatch_completed_ms,public.chat_latency_client_measurements.dispatch_completed_ms),
  browser_admission_received_ms=coalesce(excluded.browser_admission_received_ms,public.chat_latency_client_measurements.browser_admission_received_ms),
  browser_answer_dom_ready_ms=coalesce(excluded.browser_answer_dom_ready_ms,public.chat_latency_client_measurements.browser_answer_dom_ready_ms),
  updated_at=now();
 return true;
end $$;
revoke all on function public.record_chat_latency_client_measurement(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.record_chat_latency_client_measurement(uuid,text,bigint) to authenticated;
