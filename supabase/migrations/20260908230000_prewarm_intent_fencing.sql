-- Durable provider intent. Allocations are retained, including unknown outcomes.
create table public.prewarm_intents (
 id uuid primary key, user_id uuid not null references auth.users(id),
 state text not null check(state in ('PREPARING','READY','CLEANING','DONE','HANDED_OFF')),
 machine_id text, existing_machine boolean not null default false, created_at timestamptz not null default now(),
 deadline timestamptz not null default now()+interval '120 seconds',
 ready_at timestamptz, expires_at timestamptz, cleanup_token uuid,
 cleanup_at timestamptz, reserved_micros bigint not null default 250000 check(reserved_micros=250000),
 settled_at timestamptz, outcome text, compute_cost_micros bigint, provider_started_at timestamptz
);
create unique index one_open_prewarm on public.prewarm_intents(user_id) where settled_at is null;
alter table public.prewarm_intents enable row level security;
revoke all on public.prewarm_intents from public,anon,authenticated;
grant select on public.prewarm_intents to service_role;

create or replace function public.claim_hermes_prewarm(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; t uuid:=gen_random_uuid();
begin
 if not coalesce((select runs_enabled and computer_enabled and prewarm_enabled from public.runtime_config where singleton),false) then return jsonb_build_object('status','disabled'); end if;
 -- Shared with admission/deletion, followed by the workspace lock.
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,31));
 if not exists(select 1 from public.profiles where user_id=p_user_id) or
 exists(select 1 from public.account_deletion_requests where user_id=p_user_id and completed_at is null) then return jsonb_build_object('status','unavailable'); end if;
 if exists(select 1 from public.prewarm_intents where user_id=p_user_id and (settled_at is null or created_at>now()-interval '10 minutes')) or
 exists(select 1 from public.runs where user_id=p_user_id and state in ('QUEUED','RUNNING','WAITING_FOR_USER')) then return jsonb_build_object('status','busy'); end if;
 insert into public.hermes_workspaces(user_id,proxy_hash) values(p_user_id,replace(t::text,'-','')||replace(gen_random_uuid()::text,'-','')) on conflict do nothing;
 select * into w from public.hermes_workspaces where user_id=p_user_id for update;
 if w.active_run is not null or w.recovery_token is not null or w.provision_cleanup_required then return jsonb_build_object('status','busy'); end if;
 insert into public.account_pilot_budgets(user_id) values(p_user_id) on conflict do nothing;
 -- Leave room for the subsequent real run; a speculative warmup must not
 -- consume the last available normal-run allocation.
 update public.pilot_budgets set allocated_micros=allocated_micros+250000 where kind='computer' and allocated_micros+500000<=limit_micros;
 if not found then raise exception 'COMPUTER_BUDGET_EXHAUSTED'; end if;
 update public.account_pilot_budgets set allocated_micros=allocated_micros+250000 where user_id=p_user_id and allocated_micros+520000<=limit_micros;
 if not found then raise exception 'ACCOUNT_PILOT_BUDGET_EXHAUSTED'; end if;
 insert into public.prewarm_intents(id,user_id,state,machine_id,existing_machine) values(t,p_user_id,'PREPARING',w.machine_id,w.machine_id is not null);
 return jsonb_build_object('status','preparing','lease_token',t,'machine_id',w.machine_id);
end $$;

create function public.begin_prewarm_provider(p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update public.prewarm_intents set provider_started_at=now()
 where id=p_id and state='PREPARING' and deadline>now() and provider_started_at is null
 and coalesce((select runs_enabled and computer_enabled and prewarm_enabled from public.runtime_config where singleton),false)
 and not exists(select 1 from public.account_deletion_requests d where d.user_id=prewarm_intents.user_id and d.completed_at is null);
 return found;
end $$;

create function public.bind_prewarm(p_id uuid,p_machine text,p_binding jsonb default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare i public.prewarm_intents%rowtype;
begin
 select * into i from public.prewarm_intents where id=p_id;
 perform pg_advisory_xact_lock(hashtextextended(i.user_id::text,31));
 select * into i from public.prewarm_intents where id=p_id for update;
 if i.state<>'PREPARING' or i.deadline<=now() or p_machine is null or
 exists(select 1 from public.account_deletion_requests where user_id=i.user_id and completed_at is null) then return false; end if;
 update public.prewarm_intents set machine_id=p_machine where id=p_id;
 update public.hermes_workspaces set machine_id=p_machine,
 base_url=coalesce(p_binding->>'baseUrl',base_url),api_key=coalesce(p_binding->>'apiKey',api_key),
 revision=coalesce(p_binding->>'revision',revision) where user_id=i.user_id and active_run is null;
 return found;
end $$;

create or replace function public.complete_hermes_prewarm(p_user_id uuid,p_lease_token uuid,p_machine_id text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,31));
 update public.prewarm_intents set state='READY',ready_at=now(),expires_at=now()+interval '60 seconds'
 where id=p_lease_token and user_id=p_user_id and state='PREPARING' and deadline>now() and machine_id=p_machine_id
 and not exists(select 1 from public.account_deletion_requests where user_id=p_user_id and completed_at is null);
 return found;
end $$;

-- Do not erase an ambiguous effect. Recovery waits out the original worker.
create or replace function public.abort_hermes_prewarm(p_user_id uuid,p_lease_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin return exists(select 1 from public.prewarm_intents where id=p_lease_token and user_id=p_user_id and settled_at is null); end $$;

create function public.prewarm_handoff_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare i public.prewarm_intents%rowtype;
begin
 if new.active_run is not null and old.active_run is null then
 select * into i from public.prewarm_intents where user_id=new.user_id and settled_at is null for update;
 if found then
 if i.state<>'READY' then raise exception 'PREWARM_PENDING'; end if;
 -- Reserve retained conservatively; runtime compute begins at handoff separately.
 update public.prewarm_intents set state='HANDED_OFF',settled_at=now(),outcome='reserved_upper_bound',compute_cost_micros=reserved_micros where id=i.id;
 end if;
 end if;
 return new;
end $$;
create trigger prewarm_handoff before update of active_run on public.hermes_workspaces for each row execute function public.prewarm_handoff_guard();

create function public.claim_prewarm_cleanup(p_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.prewarm_intents%rowtype; t uuid:=gen_random_uuid();
begin
 select * into i from public.prewarm_intents where (p_id is null or id=p_id) and settled_at is null and
 ((state='READY' and expires_at<=now()) or (state='PREPARING' and deadline+interval '3 minutes'<=now()) or
 (state='CLEANING' and cleanup_at+interval '5 minutes'<=now())) order by created_at limit 1;
 if not found then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended(i.user_id::text,31));
 select * into i from public.prewarm_intents where id=i.id for update;
 if i.settled_at is not null or (i.state='CLEANING' and i.cleanup_at>now()-interval '5 minutes') or
 exists(select 1 from public.hermes_workspaces where user_id=i.user_id and active_run is not null) then return null; end if;
 if i.state='READY' and exists(select 1 from public.runs where user_id=i.user_id and state in ('QUEUED','RUNNING')) then return null; end if;
 update public.prewarm_intents set state='CLEANING',cleanup_token=t,cleanup_at=now() where id=i.id;
 return to_jsonb(i)||jsonb_build_object('cleanup_token',t);
end $$;
create function public.finish_prewarm_cleanup(p_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare i public.prewarm_intents%rowtype;
begin
 select * into i from public.prewarm_intents where id=p_id;
 perform pg_advisory_xact_lock(hashtextextended(i.user_id::text,31));
 select * into i from public.prewarm_intents where id=p_id and cleanup_token=p_token and state='CLEANING' and settled_at is null for update;
 if not found then return false; end if;
 if not i.existing_machine and i.ready_at is null then
 update public.hermes_workspaces set machine_id=null,base_url=null,api_key=null,revision=null,provision_cleanup_required=false where user_id=i.user_id and active_run is null;
 end if;
 update public.prewarm_intents set state='DONE',settled_at=now(),outcome='reserved_upper_bound',compute_cost_micros=reserved_micros
 where id=p_id and cleanup_token=p_token and state='CLEANING' and settled_at is null;
 return found;
end $$;
-- Account deletion cannot erase the durable orphan lookup key before cleanup.
create function public.prewarm_deletion_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='CLEANING' and exists(select 1 from public.prewarm_intents where user_id=new.user_id and settled_at is null) then raise exception 'PREWARM_RECOVERY_PENDING'; end if;
 return new;
end $$;
create trigger prewarm_deletion before update on public.account_deletion_requests for each row execute function public.prewarm_deletion_guard();
create function public.prewarm_auth_deletion_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.prewarm_intents where user_id=old.id and settled_at is null) then raise exception 'PREWARM_RECOVERY_PENDING'; end if;
 return old;
end $$;
create trigger prewarm_auth_deletion before delete on auth.users for each row execute function public.prewarm_auth_deletion_guard();
alter table public.prewarm_intents drop constraint prewarm_intents_user_id_fkey;
alter table public.prewarm_intents add foreign key(user_id) references auth.users(id) on delete cascade;
revoke all on function public.begin_prewarm_provider(uuid),public.bind_prewarm(uuid,text,jsonb),public.claim_prewarm_cleanup(uuid),public.finish_prewarm_cleanup(uuid,uuid),public.prewarm_handoff_guard(),public.prewarm_deletion_guard(),public.prewarm_auth_deletion_guard() from public,anon,authenticated;
grant execute on function public.begin_prewarm_provider(uuid),public.bind_prewarm(uuid,text,jsonb),public.claim_prewarm_cleanup(uuid),public.finish_prewarm_cleanup(uuid,uuid) to service_role;
