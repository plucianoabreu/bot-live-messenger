-- Rebalance the fixed USD 50 pilot toward messaging without weakening the
-- reservation/settlement boundary. Amounts are USD micros.
--
-- Per account worst case remains bounded: 8 chats * (20,000 model + 250,000
-- Hermes compute) + 1 computer run * 250,000 = 2,410,000 micros (USD 2.41).
-- The USD 10 computer pool therefore permits at most four fully allocated
-- accounts (USD 9.00) plus USD 1.00 for other bounded admissions.

alter table public.account_pilot_budgets
  drop constraint if exists account_pilot_budgets_limit_micros_check;
alter table public.account_pilot_budgets
  alter column limit_micros set default 2410000;
update public.account_pilot_budgets set limit_micros=2410000;
alter table public.account_pilot_budgets
  add constraint account_pilot_budgets_limit_micros_check check(limit_micros=2410000);

-- Reservations already committed to the old computer pool are never erased or
-- refunded. If they exceed the new USD 10 target, retain their exact amount as
-- the effective ceiling; all future computer reservations then fail closed.
update public.pilot_budgets
set limit_micros=case
  when kind='chat' then greatest(30000000,allocated_micros)
  when kind='computer' then greatest(10000000,allocated_micros)
  else limit_micros
end;

create or replace function public.enqueue_message(
  p_bot_id uuid,p_content text,p_idempotency_key uuid,p_kind text default 'chat'
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid();
  existing uuid;
  result uuid;
  original text;
  allocation bigint;
  pool public.pilot_budgets%rowtype;
  account_budget public.account_pilot_budgets%rowtype;
begin
  if uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_kind is null or p_kind not in ('chat','computer') then raise exception 'INVALID_RUN_KIND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if not exists(select 1 from public.bots where id=p_bot_id and user_id=uid and enabled) then raise exception 'BOT_NOT_FOUND'; end if;
  if p_idempotency_key is null or p_content is null or length(trim(p_content)) not between 1 and 8000 then raise exception 'INVALID_MESSAGE'; end if;
  select id into existing from public.runs where user_id=uid and idempotency_key=p_idempotency_key;
  if existing is not null then
    select content into original from public.messages where run_id=existing and role='user';
    if original<>trim(p_content) or not exists(select 1 from public.runs where id=existing and bot_id=p_bot_id and kind=p_kind)
      then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return existing;
  end if;
  if not coalesce((select runs_enabled from public.runtime_config where singleton),false) then raise exception 'RUNTIME_DISABLED'; end if;
  if exists(select 1 from public.runs where bot_id=p_bot_id and state in ('QUEUED','RUNNING','WAITING_FOR_USER'))
    then raise exception 'RUN_ALREADY_OPEN'; end if;
  if (select count(*) from public.runs where user_id=uid and state in ('QUEUED','RUNNING','WAITING_FOR_USER'))>=3
    then raise exception 'USER_CONCURRENCY'; end if;
  if (select count(*) from public.runs where user_id=uid and kind=p_kind)>=(case when p_kind='chat' then 8 else 1 end)
    then raise exception 'WELCOME_QUOTA'; end if;

  allocation:=case when p_kind='chat' then 20000 else 250000 end;
  insert into public.account_pilot_budgets(user_id) values(uid) on conflict(user_id) do nothing;
  select * into pool from public.pilot_budgets where kind=p_kind for update;
  if not found or pool.allocated_micros+allocation>pool.limit_micros then raise exception 'PILOT_BUDGET_EXHAUSTED'; end if;
  select * into account_budget from public.account_pilot_budgets where user_id=uid for update;
  if account_budget.allocated_micros+allocation>account_budget.limit_micros then
    raise exception 'ACCOUNT_PILOT_BUDGET_EXHAUSTED';
  end if;

  insert into public.runs(user_id,bot_id,idempotency_key,kind,reserved_cost_micros,max_seconds,instructions_version,instructions_snapshot)
    select uid,p_bot_id,p_idempotency_key,p_kind,allocation,120,b.instructions_version,b.instructions
      from public.bots b where b.id=p_bot_id returning id into result;
  insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros)
    values(result,uid,'run',allocation);
  update public.pilot_budgets set allocated_micros=allocated_micros+allocation where kind=p_kind;
  update public.account_pilot_budgets set allocated_micros=allocated_micros+allocation,updated_at=now() where user_id=uid;
  insert into public.messages(user_id,bot_id,run_id,role,content) values(uid,p_bot_id,result,'user',trim(p_content));
  insert into public.run_events(user_id,run_id,kind,summary) values(uid,result,'queued','Tarefa na fila.');
  return result;
end $$;

revoke all on function public.enqueue_message(uuid,text,uuid,text) from public,anon;
grant execute on function public.enqueue_message(uuid,text,uuid,text) to authenticated;
