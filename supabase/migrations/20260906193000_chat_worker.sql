-- Service-only execution API. No admission is enabled by this migration.
create table public.model_calls (
 run_id uuid primary key references public.runs(id),
 execution_version integer not null,
 reserved_micros bigint not null check(reserved_micros>0),
 response_id text, input_tokens bigint, output_tokens bigint,
 created_at timestamptz not null default now()
);
alter table public.model_calls enable row level security;
revoke all on public.model_calls from public,anon,authenticated;

create function public.claim_chat(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
 select * into r from public.runs where id=p_run_id for update;
 if not found or r.kind<>'chat' or r.state<>'QUEUED' or r.cancel_requested then return null; end if;
 if not (select runs_enabled from public.runtime_config where singleton) then return null; end if;
 update public.runs set state='RUNNING',execution_version=execution_version+1,
 lease_expires_at=now()+interval '120 seconds',heartbeat_at=now() where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'user_id',r.user_id,'bot_id',r.bot_id,
 'version',r.execution_version,'instructions',r.instructions_snapshot,'created_at',r.created_at);
end $$;

create function public.authorize_chat_call(p_run_id uuid,p_version integer,p_cost bigint) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
 select * into r from public.runs where id=p_run_id for update;
 if not found or r.kind<>'chat' or r.state<>'RUNNING' or r.execution_version<>p_version
 or r.lease_expires_at<=now() or r.cancel_requested then raise exception 'LEASE_LOST'; end if;
 if not (select runs_enabled from public.runtime_config where singleton) then raise exception 'RUNTIME_DISABLED'; end if;
 if p_cost is null or p_cost<=0 or p_cost>r.reserved_cost_micros then raise exception 'BUDGET_EXCEEDED'; end if;
 -- A second call is forbidden even if the first provider outcome is unknown.
 insert into public.model_calls(run_id,execution_version,reserved_micros) values(r.id,p_version,p_cost);
end $$;

create function public.finish_chat(p_run_id uuid,p_version integer,p_text text,p_response_id text,p_input bigint,p_output bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
 select * into r from public.runs where id=p_run_id for update;
 if not found or r.state<>'RUNNING' or r.execution_version<>p_version or r.lease_expires_at<=now() then return false; end if;
 if not exists(select 1 from public.model_calls where run_id=r.id and execution_version=p_version) then raise exception 'CALL_NOT_AUTHORIZED'; end if;
 if p_text is null or length(trim(p_text)) not between 1 and 32000 or p_response_id is null or p_input is null or p_output is null or p_input<0 or p_output<0 then raise exception 'INVALID_RESULT'; end if;
 update public.model_calls set response_id=p_response_id,input_tokens=p_input,output_tokens=p_output where run_id=r.id;
 if r.cancel_requested then
 update public.runs set state='CANCELLED',finished_at=now(),lease_expires_at=null where id=r.id;
 return false;
 end if;
 insert into public.messages(user_id,bot_id,run_id,role,content) values(r.user_id,r.bot_id,r.id,'assistant',p_text);
 update public.runs set state='SUCCEEDED',finished_at=now(),lease_expires_at=null where id=r.id;
 insert into public.run_events(user_id,run_id,kind,summary) values(r.user_id,r.id,'completed','Resposta concluída.');
 return true;
end $$;

create function public.fail_chat(p_run_id uuid,p_version integer) returns void
language plpgsql security definer set search_path='' as $$
begin
 update public.runs set state=case when cancel_requested then 'CANCELLED'::public.run_state else 'FAILED'::public.run_state end,
 error_code='EXECUTION_FAILED',finished_at=now(),lease_expires_at=null
 where id=p_run_id and state='RUNNING' and execution_version=p_version and lease_expires_at>now();
end $$;

create function public.reconcile_chats() returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Never replay an expired worker: its provider call might already have been billed.
 update public.runs set state=case when cancel_requested then 'CANCELLED'::public.run_state else 'FAILED'::public.run_state end,
 error_code='WORKER_EXPIRED',finished_at=now(),execution_version=execution_version+1
 where kind='chat' and state='RUNNING' and lease_expires_at<=now();
end $$;
revoke all on function public.claim_chat(uuid),public.authorize_chat_call(uuid,integer,bigint),public.finish_chat(uuid,integer,text,text,bigint,bigint),public.fail_chat(uuid,integer),public.reconcile_chats() from public,anon,authenticated;
grant execute on function public.claim_chat(uuid),public.authorize_chat_call(uuid,integer,bigint),public.finish_chat(uuid,integer,text,text,bigint,bigint),public.fail_chat(uuid,integer),public.reconcile_chats() to service_role;
