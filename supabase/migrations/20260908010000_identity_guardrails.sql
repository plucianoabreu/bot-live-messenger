-- A run must retain the product identity that was authorized when it was queued.
-- This is separate from free-form instructions so a later bot edit cannot rename a
-- queued/retrying run or let the worker fall back to an upstream runtime persona.
alter table public.runs add column bot_identity_snapshot jsonb;

update public.runs r
set bot_identity_snapshot=jsonb_build_object(
  'name',b.name,'role',b.role,'description',b.description,'instructions',b.instructions
)
from public.bots b
where r.bot_id=b.id;

alter table public.runs alter column bot_identity_snapshot set default jsonb_build_object(
  'name','AI Assistant','role','Assistant','description','General assistant.','instructions','Help with the user request within the available capabilities.'
);
update public.runs set bot_identity_snapshot=coalesce(bot_identity_snapshot, jsonb_build_object(
  'name','AI Assistant','role','Assistant','description','General assistant.','instructions','Help with the user request within the available capabilities.'
));
alter table public.runs alter column bot_identity_snapshot set not null;
alter table public.runs add constraint runs_bot_identity_snapshot_shape check(
  jsonb_typeof(bot_identity_snapshot)='object' and
  bot_identity_snapshot ?& array['name','role','description','instructions'] and
  jsonb_typeof(bot_identity_snapshot->'name')='string' and
  jsonb_typeof(bot_identity_snapshot->'role')='string' and
  jsonb_typeof(bot_identity_snapshot->'description')='string' and
  jsonb_typeof(bot_identity_snapshot->'instructions')='string'
);

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
  if account_budget.allocated_micros+allocation>account_budget.limit_micros then raise exception 'ACCOUNT_PILOT_BUDGET_EXHAUSTED'; end if;
  insert into public.runs(user_id,bot_id,idempotency_key,kind,reserved_cost_micros,max_seconds,instructions_version,instructions_snapshot,bot_identity_snapshot)
    select uid,p_bot_id,p_idempotency_key,p_kind,allocation,120,b.instructions_version,b.instructions,
      jsonb_build_object('name',b.name,'role',b.role,'description',b.description,'instructions',b.instructions)
      from public.bots b where b.id=p_bot_id returning id into result;
  insert into public.account_pilot_reservations(run_id,user_id,reservation_kind,reserved_micros) values(result,uid,'run',allocation);
  update public.pilot_budgets set allocated_micros=allocated_micros+allocation where kind=p_kind;
  update public.account_pilot_budgets set allocated_micros=allocated_micros+allocation,updated_at=now() where user_id=uid;
  insert into public.messages(user_id,bot_id,run_id,role,content) values(uid,p_bot_id,result,'user',trim(p_content));
  insert into public.run_events(user_id,run_id,kind,summary) values(uid,result,'queued','Tarefa na fila.');
  return result;
end $$;

create or replace function public.claim_chat(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype;
begin
 select * into r from public.runs where id=p_run_id for update;
 if not found or r.kind<>'chat' or r.state<>'QUEUED' or r.cancel_requested then return null; end if;
 if not (select runs_enabled from public.runtime_config where singleton) then return null; end if;
 update public.runs set state='RUNNING',execution_version=execution_version+1,
 lease_expires_at=now()+interval '120 seconds',heartbeat_at=now() where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'user_id',r.user_id,'bot_id',r.bot_id,
 'version',r.execution_version,'instructions',r.instructions_snapshot,
 'identity',r.bot_identity_snapshot,'created_at',r.created_at);
end $$;

create or replace function public.save_bot_profile(p_id uuid,p_name text,p_role text,p_description text,p_instructions text,p_avatar_id text,p_creation_key uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); found_bot public.bots%rowtype; result uuid;
begin
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 if p_name is null or length(trim(p_name)) not between 5 and 80 or trim(p_name)!~'^AI[[:space:]]+[^[:space:]].*[[:space:]]+[^[:space:]]' or
 p_role is null or length(trim(p_role)) not between 1 and 120 or p_description is null or length(trim(p_description)) not between 1 and 140 or
 p_instructions is null or length(trim(p_instructions)) not between 1 and 4000 or not exists(select 1 from public.display_pictures where id=p_avatar_id) then raise exception 'INVALID_BOT_PROFILE'; end if;
 if p_id is null then
  if p_creation_key is null then raise exception 'INVALID_REQUEST_KEY'; end if;
  select id into result from public.bots where user_id=uid and creation_key=p_creation_key;
  if result is not null then
   if exists(select 1 from public.bots where id=result and name=trim(p_name) and role=trim(p_role) and description=trim(p_description) and instructions=trim(p_instructions) and avatar_id=p_avatar_id) then return result; end if;
   raise exception 'IDEMPOTENCY_CONFLICT';
  end if;
  if (select count(*) from public.bots where user_id=uid and preset is null)>=20 then raise exception 'BOT_LIMIT'; end if;
  insert into public.bots(user_id,name,role,description,instructions,avatar_id,creation_key) values(uid,trim(p_name),trim(p_role),trim(p_description),trim(p_instructions),p_avatar_id,p_creation_key) returning id into result;
 else
  select * into found_bot from public.bots where id=p_id and user_id=uid for update;
  if not found then raise exception 'BOT_NOT_FOUND'; end if;
  update public.bots set name=trim(p_name),role=trim(p_role),description=trim(p_description),instructions=trim(p_instructions),avatar_id=p_avatar_id,
   instructions_version=instructions_version+case when name is distinct from trim(p_name) or role is distinct from trim(p_role) or description is distinct from trim(p_description) or instructions is distinct from trim(p_instructions) then 1 else 0 end
   where id=p_id;
  result:=p_id;
 end if;
 return result;
end $$;
