-- Per-run performance marks for diagnosis. These fields intentionally never store
-- user messages, assistant output, prompts, credentials, model requests, or IDs.
create table public.chat_latency_measurements (
  run_id uuid not null references public.runs(id) on delete cascade,
  execution_version integer not null check(execution_version > 0),
  worker_claimed_ms bigint not null check(worker_claimed_ms >= 0),
  history_loaded_ms bigint check(history_loaded_ms >= 0),
  memory_loaded_ms bigint check(memory_loaded_ms >= 0),
  executor_started_ms bigint check(executor_started_ms >= 0),
  hermes_workspace_claimed_ms bigint check(hermes_workspace_claimed_ms >= 0),
  hermes_sandbox_ready_ms bigint check(hermes_sandbox_ready_ms >= 0),
  hermes_remote_started_ms bigint check(hermes_remote_started_ms >= 0),
  hermes_remote_completed_ms bigint check(hermes_remote_completed_ms >= 0),
  executor_finished_ms bigint check(executor_finished_ms >= 0),
  recorded_at timestamptz not null default now(),
  primary key(run_id, execution_version)
);

alter table public.chat_latency_measurements enable row level security;
revoke all on public.chat_latency_measurements from public, anon, authenticated;
grant select on public.chat_latency_measurements to service_role;

create function public.record_chat_latency_measurement(
  p_run_id uuid,
  p_version integer,
  p_worker_claimed_ms bigint,
  p_history_loaded_ms bigint,
  p_memory_loaded_ms bigint,
  p_executor_started_ms bigint,
  p_hermes_workspace_claimed_ms bigint,
  p_hermes_sandbox_ready_ms bigint,
  p_hermes_remote_started_ms bigint,
  p_hermes_remote_completed_ms bigint,
  p_executor_finished_ms bigint
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
  if p_run_id is null or p_version is null or p_version <= 0 or p_worker_claimed_ms is null or p_worker_claimed_ms < 0 or
    p_history_loaded_ms < 0 or p_memory_loaded_ms < 0 or p_executor_started_ms < 0 or
    p_hermes_workspace_claimed_ms < 0 or p_hermes_sandbox_ready_ms < 0 or
    p_hermes_remote_started_ms < 0 or p_hermes_remote_completed_ms < 0 or p_executor_finished_ms < 0 then
    raise exception 'INVALID_CHAT_LATENCY_MEASUREMENT';
  end if;
  select * into r from public.runs where id=p_run_id for update;
  if not found or r.state <> 'RUNNING' or r.execution_version <> p_version or r.cancel_requested then return false; end if;
  insert into public.chat_latency_measurements(
    run_id, execution_version, worker_claimed_ms, history_loaded_ms, memory_loaded_ms, executor_started_ms,
    hermes_workspace_claimed_ms, hermes_sandbox_ready_ms, hermes_remote_started_ms,
    hermes_remote_completed_ms, executor_finished_ms
  ) values (
    p_run_id, p_version, p_worker_claimed_ms, p_history_loaded_ms, p_memory_loaded_ms, p_executor_started_ms,
    p_hermes_workspace_claimed_ms, p_hermes_sandbox_ready_ms, p_hermes_remote_started_ms,
    p_hermes_remote_completed_ms, p_executor_finished_ms
  ) on conflict(run_id, execution_version) do nothing;
  return true;
end $$;

revoke all on function public.record_chat_latency_measurement(uuid,integer,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.record_chat_latency_measurement(uuid,integer,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint) to service_role;
