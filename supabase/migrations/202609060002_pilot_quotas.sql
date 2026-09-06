-- USD 50 pilot: USD 10 chat, USD 25 computer, USD 15 held outside execution.
-- Full-run reservations are conservative and never automatically refunded, even on failure.
-- Provider execution must enforce these reservations before enabling runtime admission.
create table public.pilot_budgets (
 kind text primary key check(kind in ('chat','computer')),
 limit_micros bigint not null check(limit_micros>=0),
 allocated_micros bigint not null default 0 check(allocated_micros between 0 and limit_micros)
);
alter table public.pilot_budgets enable row level security;
revoke all on public.pilot_budgets from public,anon,authenticated;
alter table public.runs add column kind text not null default 'chat' check(kind in ('chat','computer'));
alter table public.runs add column max_seconds integer not null default 120 check(max_seconds between 1 and 120);
alter table public.runs alter column reserved_cost_micros set default 20000;
-- Preserve historical reservations; migration fails if they already exceed the new budget.
insert into public.pilot_budgets(kind,limit_micros,allocated_micros)
 values('chat',10000000,(select coalesce(sum(reserved_cost_micros),0) from public.runs)),('computer',25000000,0);
drop function public.enqueue_message(uuid,text,uuid);
create function public.enqueue_message(p_bot_id uuid,p_content text,p_idempotency_key uuid,p_kind text default 'chat') returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); existing uuid; result uuid; original text; allocation bigint; pool public.pilot_budgets%rowtype;
begin
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_kind is null or p_kind not in ('chat','computer') then raise exception 'INVALID_RUN_KIND'; end if;
 -- Serialize admission per user across concurrent HTTP requests and direct RPC calls.
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 if not exists(select 1 from public.bots where id=p_bot_id and user_id=uid and enabled) then raise exception 'BOT_NOT_FOUND'; end if;
 if p_idempotency_key is null or p_content is null or length(trim(p_content)) not between 1 and 8000 then raise exception 'INVALID_MESSAGE'; end if;
 select id into existing from public.runs where user_id=uid and idempotency_key=p_idempotency_key;
 if existing is not null then
  select content into original from public.messages where run_id=existing and role='user';
  if original<>trim(p_content) or not exists(select 1 from public.runs where id=existing and bot_id=p_bot_id and kind=p_kind) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return existing;
 end if;
 if not (select runs_enabled from public.runtime_config where singleton) then raise exception 'RUNTIME_DISABLED'; end if;
 if exists(select 1 from public.runs where user_id=uid and state in ('QUEUED','RUNNING','WAITING_FOR_USER')) then raise exception 'RUN_ALREADY_OPEN'; end if;
 -- Serialize global allocation as well as per-user admission. Reservations never reset.
 select * into pool from public.pilot_budgets where kind=p_kind for update;
 if not found then raise exception 'PILOT_BUDGET_EXHAUSTED'; end if;
 if (select count(*) from public.runs where user_id=uid and kind=p_kind)>=(case when p_kind='chat' then 5 else 1 end) then raise exception 'WELCOME_QUOTA'; end if;
 allocation:=case when p_kind='chat' then 20000 else 250000 end;
 if pool.allocated_micros+allocation>pool.limit_micros then raise exception 'PILOT_BUDGET_EXHAUSTED'; end if;
 update public.pilot_budgets set allocated_micros=allocated_micros+allocation where kind=p_kind;
 insert into public.runs(user_id,bot_id,idempotency_key,kind,reserved_cost_micros,max_seconds) values(uid,p_bot_id,p_idempotency_key,p_kind,allocation,120) returning id into result;
 insert into public.messages(user_id,bot_id,run_id,role,content) values(uid,p_bot_id,result,'user',trim(p_content));
 insert into public.run_events(user_id,run_id,kind,summary) values(uid,result,'queued','Tarefa na fila.');
 return result;
end $$;

revoke all on function public.enqueue_message(uuid,text,uuid,text) from public,anon;
grant execute on function public.enqueue_message(uuid,text,uuid,text) to authenticated;
