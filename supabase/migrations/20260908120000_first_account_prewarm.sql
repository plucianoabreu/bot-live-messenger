-- First authenticated conversation may reserve a workspace before a chat run;
-- this placeholder is not a provider credential and cannot authorize a model.
create or replace function public.claim_hermes_prewarm(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.hermes_workspaces%rowtype; lease public.hermes_prewarm_leases%rowtype; token uuid;
begin
 if p_user_id is null or not coalesce((select runs_enabled and computer_enabled and prewarm_enabled from public.runtime_config where singleton),false) then return jsonb_build_object('status','disabled'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,31));
 insert into public.hermes_workspaces(user_id,proxy_hash) values(p_user_id,md5(p_user_id::text||clock_timestamp()::text||random()::text)||md5(random()::text||clock_timestamp()::text)) on conflict(user_id) do nothing;
 select * into w from public.hermes_workspaces where user_id=p_user_id for update;
 if w.active_run is not null or w.recovery_token is not null then return jsonb_build_object('status','busy'); end if;
 select * into lease from public.hermes_prewarm_leases where user_id=p_user_id for update;
 if found and ((lease.state='PREPARING' and lease.preparation_expires_at>now()) or (lease.state='READY' and lease.expires_at>now()) or lease.state='PAUSING') then return jsonb_build_object('status',lower(lease.state),'lease_token',lease.lease_token,'machine_id',w.machine_id); end if;
 delete from public.hermes_prewarm_leases where user_id=p_user_id;
 token:=gen_random_uuid(); insert into public.hermes_prewarm_leases(user_id,lease_token,state,preparation_expires_at) values(p_user_id,token,'PREPARING',now()+interval '30 seconds');
 return jsonb_build_object('status','preparing','lease_token',token,'machine_id',w.machine_id);
end $$;
