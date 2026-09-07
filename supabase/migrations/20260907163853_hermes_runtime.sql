-- Service-only workspace identity and account-wide fencing for the Hermes executor.
create table public.hermes_workspaces (
 user_id uuid primary key references auth.users(id),
 machine_id text unique,
 base_url text,
 api_key text,
 proxy_hash text not null unique check(length(proxy_hash)=64),
 active_run uuid references public.runs(id),
 remote_run text,
 revision text,
 created_at timestamptz not null default now()
);
alter table public.hermes_workspaces enable row level security;
revoke all on public.hermes_workspaces from public,anon,authenticated;
grant all on public.hermes_workspaces to service_role;

create function public.claim_hermes_workspace(p_run_id uuid,p_version integer,p_proxy_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; w public.hermes_workspaces%rowtype;
begin
 select * into r from public.runs where id=p_run_id for update;
 if not found or r.state<>'RUNNING' or r.execution_version<>p_version or r.cancel_requested
 or r.lease_expires_at<=now() then raise exception 'LEASE_LOST'; end if;
 insert into public.hermes_workspaces(user_id,proxy_hash) values(r.user_id,p_proxy_hash) on conflict(user_id) do nothing;
 select * into w from public.hermes_workspaces where user_id=r.user_id for update;
 -- An expired worker does not prove that its remote process has stopped.
 if w.active_run is not null then raise exception 'COMPUTER_RECOVERY_REQUIRED'; end if;
 -- Reserve compute separately from the model pool before creating or resuming a VM.
 update public.pilot_budgets set allocated_micros=allocated_micros+250000
 where kind='computer' and allocated_micros+250000<=limit_micros;
 if not found then raise exception 'COMPUTER_BUDGET_EXHAUSTED'; end if;
 update public.hermes_workspaces set active_run=r.id where user_id=r.user_id returning * into w;
 return to_jsonb(w);
end $$;

create function public.authorize_hermes_model(p_proxy_hash text,p_cost bigint) returns void
language plpgsql security definer set search_path='' as $$
declare target uuid; r public.runs%rowtype; w public.hermes_workspaces%rowtype; allocated bigint;
begin
 select active_run into target from public.hermes_workspaces where proxy_hash=p_proxy_hash;
 if target is null then raise exception 'UNAUTHORIZED'; end if;
 select * into r from public.runs where id=target for update;
 select * into w from public.hermes_workspaces where proxy_hash=p_proxy_hash for update;
 if w.active_run is distinct from target or r.state<>'RUNNING' or r.cancel_requested or r.lease_expires_at<=now()
 then raise exception 'LEASE_LOST'; end if;
 if not (select runs_enabled from public.runtime_config where singleton) then raise exception 'RUNTIME_DISABLED'; end if;
 select coalesce(sum(reserved_micros),0) into allocated from public.model_calls where run_id=r.id;
 if p_cost is null or p_cost<=0 or allocated+p_cost>r.reserved_cost_micros then raise exception 'BUDGET_EXCEEDED'; end if;
 insert into public.model_calls(run_id,execution_version,reserved_micros) values(r.id,r.execution_version,p_cost)
 on conflict(run_id) do update set reserved_micros=public.model_calls.reserved_micros+excluded.reserved_micros;
end $$;

revoke all on function public.claim_hermes_workspace(uuid,integer,text),public.authorize_hermes_model(text,bigint) from public,anon,authenticated;
grant execute on function public.claim_hermes_workspace(uuid,integer,text),public.authorize_hermes_model(text,bigint) to service_role;
