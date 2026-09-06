-- Durable, owner-scoped memory, groups and bounded handoff records.
-- Handoff delivery is a service-only state transition; this migration dispatches no work.

alter table public.messages add constraint messages_id_user_unique unique(id,user_id);

create table public.memory_items (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 bot_id uuid,
 kind text not null check(kind in ('preference','role_context','working_context')),
 creation_key uuid not null,
 current_version integer not null default 1 check(current_version>0),
 deleted_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(bot_id,user_id) references public.bots(id,user_id) on delete cascade,
 unique(user_id,creation_key),
 unique(id,user_id),
 check((kind='preference' and bot_id is null) or (kind<>'preference' and bot_id is not null))
);

create table public.memory_versions (
 item_id uuid not null,
 user_id uuid not null,
 version integer not null check(version>0),
 content text not null check(length(content) between 1 and 4000),
 provenance text not null check(length(provenance) between 1 and 500),
 source_context jsonb not null default '{}'::jsonb check(jsonb_typeof(source_context)='object'),
 created_at timestamptz not null default now(),
 superseded_at timestamptz,
 primary key(item_id,version),
 foreign key(item_id,user_id) references public.memory_items(id,user_id) on delete cascade
);

create index memory_items_active on public.memory_items(user_id,bot_id,updated_at desc,id) where deleted_at is null;
create unique index memory_versions_one_active on public.memory_versions(item_id) where superseded_at is null;

create table public.bot_groups (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 80),
 creation_key uuid not null,
 archived_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,creation_key),
 unique(id,user_id)
);

create table public.bot_group_memberships (
 group_id uuid not null,
 user_id uuid not null,
 bot_id uuid not null,
 added_at timestamptz not null default now(),
 removed_at timestamptz,
 primary key(group_id,bot_id),
 foreign key(group_id,user_id) references public.bot_groups(id,user_id) on delete cascade,
 foreign key(bot_id,user_id) references public.bots(id,user_id) on delete cascade
);

create index bot_group_members_active on public.bot_group_memberships(group_id,added_at,bot_id) where removed_at is null;

create type public.handoff_state as enum ('AUTHORIZED','DELIVERED','COMPLETED','FAILED','CANCELLED');

create table public.root_task_budgets (
 root_run_id uuid primary key,
 user_id uuid not null,
 reserved_micros bigint not null check(reserved_micros>=0),
 allocated_micros bigint not null default 0 check(allocated_micros>=0 and allocated_micros<=reserved_micros),
 cancelled_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key(root_run_id,user_id) references public.runs(id,user_id) on delete cascade,
 unique(root_run_id,user_id)
);

comment on column public.root_task_budgets.allocated_micros is
 'Authoritative total committed from the root reservation, including the root model call and every child handoff.';

-- Preserve calls authorized before this migration. New root calls and handoffs both
-- commit against this same row under a root-run lock.
insert into public.root_task_budgets(root_run_id,user_id,reserved_micros,allocated_micros)
 select r.id,r.user_id,r.reserved_cost_micros,m.reserved_micros
 from public.model_calls m join public.runs r on r.id=m.run_id;

create or replace function public.authorize_chat_call(p_run_id uuid,p_version integer,p_cost bigint) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs%rowtype; budget public.root_task_budgets%rowtype;
begin
 -- Root row is always first. request_cancel and every handoff transition use the
 -- same order, so cancellation cannot deadlock behind a child record.
 select * into r from public.runs where id=p_run_id for update;
 if not found or r.kind<>'chat' or r.state<>'RUNNING' or r.execution_version<>p_version
 or r.lease_expires_at<=now() or r.cancel_requested then raise exception 'LEASE_LOST'; end if;
 if not (select runs_enabled from public.runtime_config where singleton) then raise exception 'RUNTIME_DISABLED'; end if;
 if p_cost is null or p_cost<=0 or p_cost>r.reserved_cost_micros then raise exception 'BUDGET_EXCEEDED'; end if;
 insert into public.root_task_budgets(root_run_id,user_id,reserved_micros)
  values(r.id,r.user_id,r.reserved_cost_micros) on conflict(root_run_id) do nothing;
 select * into budget from public.root_task_budgets where root_run_id=r.id for update;
 if budget.cancelled_at is not null then raise exception 'LEASE_LOST'; end if;
 -- Preserve the previous exactly-once boundary: a duplicate attempt fails at the
 -- unique model-call record, and its transaction cannot consume budget twice.
 insert into public.model_calls(run_id,execution_version,reserved_micros) values(r.id,p_version,p_cost);
 if budget.allocated_micros+p_cost>budget.reserved_micros then raise exception 'BUDGET_EXCEEDED'; end if;
 update public.root_task_budgets set allocated_micros=allocated_micros+p_cost where root_run_id=r.id;
end $$;

create table public.bot_handoffs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 root_run_id uuid not null,
 parent_handoff_id uuid,
 source_bot_id uuid not null,
 target_bot_id uuid not null,
 group_id uuid,
 idempotency_key uuid not null,
 task text not null check(length(task) between 1 and 8000),
 budget_micros bigint not null check(budget_micros>0),
 depth integer not null check(depth between 1 and 3),
 state public.handoff_state not null default 'AUTHORIZED',
 delivery_key uuid,
 result_key uuid,
 result text check(result is null or length(result) between 1 and 32000),
 created_at timestamptz not null default now(),
 delivered_at timestamptz,
 finished_at timestamptz,
 foreign key(root_run_id,user_id) references public.runs(id,user_id) on delete cascade,
 foreign key(parent_handoff_id,user_id) references public.bot_handoffs(id,user_id),
 foreign key(source_bot_id,user_id) references public.bots(id,user_id),
 foreign key(target_bot_id,user_id) references public.bots(id,user_id),
 foreign key(group_id,user_id) references public.bot_groups(id,user_id),
 unique(user_id,idempotency_key),
 unique(id,user_id),
 check(source_bot_id<>target_bot_id),
 check((state='AUTHORIZED' and delivered_at is null and finished_at is null) or
       (state='DELIVERED' and delivered_at is not null and finished_at is null) or
       (state in ('COMPLETED','FAILED') and delivered_at is not null and finished_at is not null) or
       (state='CANCELLED' and finished_at is not null))
);

create table public.handoff_source_messages (
 handoff_id uuid not null,
 user_id uuid not null,
 message_id uuid not null,
 primary key(handoff_id,message_id),
 foreign key(handoff_id,user_id) references public.bot_handoffs(id,user_id) on delete cascade,
 foreign key(message_id,user_id) references public.messages(id,user_id) on delete cascade
);

create index bot_handoffs_root_history on public.bot_handoffs(root_run_id,created_at,id);
create index bot_handoffs_group_history on public.bot_handoffs(group_id,created_at,id) where group_id is not null;

alter table public.memory_items enable row level security;
alter table public.memory_versions enable row level security;
alter table public.bot_groups enable row level security;
alter table public.bot_group_memberships enable row level security;
alter table public.root_task_budgets enable row level security;
alter table public.bot_handoffs enable row level security;
alter table public.handoff_source_messages enable row level security;

create policy read_own_memory_items on public.memory_items for select to authenticated
 using(user_id=(select auth.uid()) and deleted_at is null);
create policy read_own_memory_versions on public.memory_versions for select to authenticated
 using(user_id=(select auth.uid()) and exists(
  select 1 from public.memory_items item where item.id=memory_versions.item_id and item.user_id=memory_versions.user_id and item.deleted_at is null
 ));
create policy read_own_bot_groups on public.bot_groups for select to authenticated using(user_id=(select auth.uid()));
create policy read_own_bot_group_memberships on public.bot_group_memberships for select to authenticated using(user_id=(select auth.uid()));
create policy read_own_root_task_budgets on public.root_task_budgets for select to authenticated using(user_id=(select auth.uid()));
create policy read_own_bot_handoffs on public.bot_handoffs for select to authenticated using(user_id=(select auth.uid()));
create policy read_own_handoff_sources on public.handoff_source_messages for select to authenticated using(user_id=(select auth.uid()));

revoke all on public.memory_items,public.memory_versions,public.bot_groups,public.bot_group_memberships,
 public.root_task_budgets,public.bot_handoffs,public.handoff_source_messages from public,anon,authenticated;
grant select on public.memory_items,public.memory_versions,public.bot_groups,public.bot_group_memberships,
 public.root_task_budgets,public.bot_handoffs,public.handoff_source_messages to authenticated;

create function public.save_memory(
 p_id uuid,
 p_bot_id uuid,
 p_kind text,
 p_content text,
 p_provenance text,
 p_source_context jsonb,
 p_idempotency_key uuid,
 p_expected_version integer default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 existing public.memory_items%rowtype;
 existing_version public.memory_versions%rowtype;
 result uuid;
 next_version integer;
 context jsonb:=coalesce(p_source_context,'{}'::jsonb);
begin
 if uid is null and p_bot_id is not null then select user_id into uid from public.bots where id=p_bot_id; end if;
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_kind is null or p_kind not in ('preference','role_context','working_context') or
    p_content is null or length(trim(p_content)) not between 1 and 4000 or
    p_provenance is null or length(trim(p_provenance)) not between 1 and 500 or
    jsonb_typeof(context)<>'object' or octet_length(context::text)>4000 or
    (p_kind='preference' and p_bot_id is not null) or (p_kind<>'preference' and p_bot_id is null) then
  raise exception 'INVALID_MEMORY';
 end if;
 if p_bot_id is not null and not exists(select 1 from public.bots where id=p_bot_id and user_id=uid) then
  raise exception 'BOT_NOT_FOUND';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,11));
 if p_id is null then
  if p_idempotency_key is null then raise exception 'INVALID_MEMORY'; end if;
  select * into existing from public.memory_items where user_id=uid and creation_key=p_idempotency_key;
  if found then
   if existing.deleted_at is not null then raise exception 'MEMORY_DELETED'; end if;
   select * into existing_version from public.memory_versions where item_id=existing.id and version=1;
   if existing.bot_id is distinct from p_bot_id or existing.kind<>p_kind or
      existing_version.content<>trim(p_content) or existing_version.provenance<>trim(p_provenance) or
      existing_version.source_context<>context then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return existing.id;
  end if;
  insert into public.memory_items(user_id,bot_id,kind,creation_key)
   values(uid,p_bot_id,p_kind,p_idempotency_key) returning id into result;
  insert into public.memory_versions(item_id,user_id,version,content,provenance,source_context)
   values(result,uid,1,trim(p_content),trim(p_provenance),context);
  return result;
 end if;
 select * into existing from public.memory_items where id=p_id and user_id=uid and deleted_at is null for update;
 if not found then raise exception 'MEMORY_NOT_FOUND'; end if;
 if p_expected_version is null or existing.current_version<>p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
 if existing.bot_id is distinct from p_bot_id then raise exception 'INVALID_MEMORY'; end if;
 next_version:=existing.current_version+1;
 update public.memory_versions set superseded_at=now() where item_id=existing.id and version=existing.current_version;
 insert into public.memory_versions(item_id,user_id,version,content,provenance,source_context)
  values(existing.id,uid,next_version,trim(p_content),trim(p_provenance),context);
 update public.memory_items set kind=p_kind,current_version=next_version,updated_at=now() where id=existing.id;
 return existing.id;
end $$;

create function public.delete_memory(p_id uuid,p_expected_version integer) returns void
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); item public.memory_items%rowtype;
begin
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 select * into item from public.memory_items where id=p_id and user_id=uid and deleted_at is null for update;
 if not found then raise exception 'MEMORY_NOT_FOUND'; end if;
 if p_expected_version is null or item.current_version<>p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
 -- Erasure removes every content/provenance payload. The item row remains only as
 -- a minimal tombstone for idempotency and lifecycle audit metadata.
 delete from public.memory_versions where item_id=item.id;
 update public.memory_items set deleted_at=now(),updated_at=now() where id=item.id;
end $$;

create function public.save_bot_group(p_id uuid,p_name text,p_idempotency_key uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); existing public.bot_groups%rowtype; result uuid;
begin
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 80 then raise exception 'INVALID_GROUP'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,12));
 if p_id is null then
  if p_idempotency_key is null then raise exception 'INVALID_GROUP'; end if;
  select * into existing from public.bot_groups where user_id=uid and creation_key=p_idempotency_key;
  if found then
   if existing.name<>trim(p_name) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return existing.id;
  end if;
  insert into public.bot_groups(user_id,name,creation_key) values(uid,trim(p_name),p_idempotency_key) returning id into result;
  return result;
 end if;
 update public.bot_groups set name=trim(p_name),updated_at=now() where id=p_id and user_id=uid and archived_at is null returning id into result;
 if result is null then raise exception 'GROUP_NOT_FOUND'; end if;
 return result;
end $$;

create function public.archive_bot_group(p_group_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); changed uuid;
begin
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 update public.bot_groups set archived_at=now(),updated_at=now() where id=p_group_id and user_id=uid and archived_at is null returning id into changed;
 if changed is null then raise exception 'GROUP_NOT_FOUND'; end if;
 update public.bot_group_memberships set removed_at=coalesce(removed_at,now()) where group_id=p_group_id and user_id=uid;
end $$;

create function public.set_bot_group_member(p_group_id uuid,p_bot_id uuid,p_active boolean) returns void
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); group_owner uuid;
begin
 if uid is null then raise exception 'UNAUTHENTICATED'; end if;
 select user_id into group_owner from public.bot_groups where id=p_group_id and user_id=uid and archived_at is null for update;
 if group_owner is null then raise exception 'GROUP_NOT_FOUND'; end if;
 if p_active is null or not exists(select 1 from public.bots where id=p_bot_id and user_id=uid) or
    (p_active and not exists(select 1 from public.bots where id=p_bot_id and user_id=uid and enabled)) then raise exception 'BOT_NOT_FOUND'; end if;
 if p_active then
  insert into public.bot_group_memberships(group_id,user_id,bot_id) values(p_group_id,uid,p_bot_id)
   on conflict(group_id,bot_id) do update set removed_at=null,added_at=now();
 else
  update public.bot_group_memberships set removed_at=coalesce(removed_at,now()) where group_id=p_group_id and bot_id=p_bot_id and user_id=uid;
 end if;
end $$;

create function public.authorize_bot_handoff(
 p_root_run_id uuid,
 p_parent_handoff_id uuid,
 p_source_bot_id uuid,
 p_target_bot_id uuid,
 p_group_id uuid,
 p_task text,
 p_source_message_ids uuid[],
 p_budget_micros bigint,
 p_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 root public.runs%rowtype;
 parent public.bot_handoffs%rowtype;
 existing public.bot_handoffs%rowtype;
 budget public.root_task_budgets%rowtype;
 result uuid;
 next_depth integer;
 active_members integer;
 source_ids uuid[];
 existing_sources uuid[];
begin
 if uid is null then select user_id into uid from public.runs where id=p_root_run_id; end if;
 if uid is null then raise exception 'RUN_NOT_FOUND'; end if;
 select coalesce(array_agg(value order by value),'{}'::uuid[]) into source_ids
  from (select distinct unnest(coalesce(p_source_message_ids,'{}'::uuid[])) as value) normalized;
 if p_idempotency_key is null or p_task is null or length(trim(p_task)) not between 1 and 8000 or
    p_budget_micros is null or p_budget_micros<=0 or cardinality(source_ids)>20 or
    p_source_bot_id=p_target_bot_id then raise exception 'INVALID_HANDOFF'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text || p_root_run_id::text,13));
 select * into existing from public.bot_handoffs where user_id=uid and idempotency_key=p_idempotency_key;
 if found then
  select coalesce(array_agg(message_id order by message_id),'{}'::uuid[]) into existing_sources from public.handoff_source_messages where handoff_id=existing.id;
  if existing.root_run_id<>p_root_run_id or existing.parent_handoff_id is distinct from p_parent_handoff_id or
     existing.source_bot_id<>p_source_bot_id or existing.target_bot_id<>p_target_bot_id or
     existing.group_id is distinct from p_group_id or existing.task<>trim(p_task) or
     existing.budget_micros<>p_budget_micros or existing_sources<>source_ids then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return existing.id;
 end if;
 select * into root from public.runs where id=p_root_run_id and user_id=uid for update;
 if not found then raise exception 'RUN_NOT_FOUND'; end if;
 if root.cancel_requested or root.state='CANCELLED' then raise exception 'ROOT_CANCELLED'; end if;
 if root.state in ('SUCCEEDED','FAILED') then raise exception 'ROOT_FINISHED'; end if;
 if not exists(select 1 from public.bots where id=p_source_bot_id and user_id=uid and enabled) or
    not exists(select 1 from public.bots where id=p_target_bot_id and user_id=uid and enabled) then raise exception 'BOT_NOT_FOUND'; end if;
 if p_parent_handoff_id is null then
  if p_source_bot_id<>root.bot_id then raise exception 'INVALID_HANDOFF'; end if;
  next_depth:=1;
 else
  select * into parent from public.bot_handoffs where id=p_parent_handoff_id and user_id=uid and root_run_id=p_root_run_id for update;
  if not found then raise exception 'HANDOFF_NOT_FOUND'; end if;
  if parent.state not in ('DELIVERED','COMPLETED') then raise exception 'PARENT_NOT_DELIVERED'; end if;
  if parent.target_bot_id<>p_source_bot_id then raise exception 'INVALID_HANDOFF'; end if;
  next_depth:=parent.depth+1;
  if next_depth>3 then raise exception 'HANDOFF_DEPTH'; end if;
  if exists(
   with recursive chain as (
    select id,parent_handoff_id,source_bot_id,target_bot_id from public.bot_handoffs where id=p_parent_handoff_id and user_id=uid
    union all
    select h.id,h.parent_handoff_id,h.source_bot_id,h.target_bot_id from public.bot_handoffs h join chain c on h.id=c.parent_handoff_id
   ) select 1 from chain where p_target_bot_id in (source_bot_id,target_bot_id)
  ) then raise exception 'HANDOFF_CYCLE'; end if;
 end if;
 if p_group_id is not null then
  perform id from public.bot_groups where id=p_group_id and user_id=uid and archived_at is null for update;
  if not found then raise exception 'GROUP_NOT_FOUND'; end if;
  perform bot_id from public.bot_group_memberships
   where group_id=p_group_id and user_id=uid and bot_id in (p_source_bot_id,p_target_bot_id)
   order by bot_id for update;
  select count(*) into active_members from public.bot_group_memberships
   where group_id=p_group_id and user_id=uid and bot_id in (p_source_bot_id,p_target_bot_id) and removed_at is null;
  if active_members<>2 then raise exception 'GROUP_MEMBER_REQUIRED'; end if;
 end if;
 if exists(select 1 from unnest(source_ids) source_id where not exists(
  select 1 from public.messages where id=source_id and user_id=uid
 )) then raise exception 'MESSAGE_NOT_FOUND'; end if;
 insert into public.root_task_budgets(root_run_id,user_id,reserved_micros)
  values(root.id,uid,root.reserved_cost_micros) on conflict(root_run_id) do nothing;
 select * into budget from public.root_task_budgets where root_run_id=root.id and user_id=uid for update;
 if budget.cancelled_at is not null then raise exception 'ROOT_CANCELLED'; end if;
 if budget.allocated_micros+p_budget_micros>budget.reserved_micros then raise exception 'HANDOFF_BUDGET'; end if;
 update public.root_task_budgets set allocated_micros=allocated_micros+p_budget_micros where root_run_id=root.id;
 insert into public.bot_handoffs(user_id,root_run_id,parent_handoff_id,source_bot_id,target_bot_id,group_id,idempotency_key,task,budget_micros,depth)
  values(uid,root.id,p_parent_handoff_id,p_source_bot_id,p_target_bot_id,p_group_id,p_idempotency_key,trim(p_task),p_budget_micros,next_depth)
  returning id into result;
 insert into public.handoff_source_messages(handoff_id,user_id,message_id) select result,uid,unnest(source_ids);
 return result;
end $$;

create function public.deliver_bot_handoff(p_handoff_id uuid,p_delivery_key uuid) returns void
language plpgsql security definer set search_path='' as $$
declare handoff public.bot_handoffs%rowtype; root public.runs%rowtype; root_id uuid; active_members integer;
begin
 if p_delivery_key is null then raise exception 'INVALID_HANDOFF'; end if;
 -- Resolve the immutable root reference without taking a lock, then acquire every
 -- mutable row in root -> handoff -> group -> memberships order.
 select root_run_id into root_id from public.bot_handoffs where id=p_handoff_id;
 if root_id is null then raise exception 'HANDOFF_NOT_FOUND'; end if;
 select * into root from public.runs where id=root_id for update;
 if not found then raise exception 'HANDOFF_NOT_FOUND'; end if;
 select * into handoff from public.bot_handoffs where id=p_handoff_id and root_run_id=root.id for update;
 if not found then raise exception 'HANDOFF_NOT_FOUND'; end if;
 if handoff.state<>'AUTHORIZED' then
  if handoff.delivery_key=p_delivery_key and handoff.state in ('DELIVERED','COMPLETED','FAILED') then return; end if;
  if handoff.state='CANCELLED' then raise exception 'ROOT_CANCELLED'; end if;
  raise exception 'IDEMPOTENCY_CONFLICT';
 end if;
 if root.cancel_requested or root.state='CANCELLED' then raise exception 'ROOT_CANCELLED'; end if;
 if root.state in ('SUCCEEDED','FAILED') then raise exception 'ROOT_FINISHED'; end if;
 if handoff.group_id is not null then
  perform id from public.bot_groups where id=handoff.group_id and user_id=handoff.user_id and archived_at is null for update;
  if not found then raise exception 'GROUP_MEMBER_REQUIRED'; end if;
  perform bot_id from public.bot_group_memberships
   where group_id=handoff.group_id and user_id=handoff.user_id and bot_id in (handoff.source_bot_id,handoff.target_bot_id)
   order by bot_id for update;
  select count(*) into active_members from public.bot_group_memberships
   where group_id=handoff.group_id and user_id=handoff.user_id and bot_id in (handoff.source_bot_id,handoff.target_bot_id) and removed_at is null;
  if active_members<>2 then raise exception 'GROUP_MEMBER_REQUIRED'; end if;
 end if;
 update public.bot_handoffs set state='DELIVERED',delivery_key=p_delivery_key,delivered_at=now() where id=handoff.id;
end $$;

create function public.finish_bot_handoff(p_handoff_id uuid,p_result_key uuid,p_state text,p_result text) returns void
language plpgsql security definer set search_path='' as $$
declare handoff public.bot_handoffs%rowtype; root public.runs%rowtype; root_id uuid; final_state public.handoff_state; active_members integer;
begin
 if p_result_key is null or p_state not in ('COMPLETED','FAILED') or p_result is null or length(trim(p_result)) not between 1 and 32000 then
  raise exception 'INVALID_HANDOFF_RESULT';
 end if;
 final_state:=p_state::public.handoff_state;
 select root_run_id into root_id from public.bot_handoffs where id=p_handoff_id;
 if root_id is null then raise exception 'HANDOFF_NOT_FOUND'; end if;
 select * into root from public.runs where id=root_id for update;
 if not found then raise exception 'HANDOFF_NOT_FOUND'; end if;
 select * into handoff from public.bot_handoffs where id=p_handoff_id and root_run_id=root.id for update;
 if not found then raise exception 'HANDOFF_NOT_FOUND'; end if;
 if handoff.state in ('COMPLETED','FAILED') then
  if handoff.result_key=p_result_key and handoff.state=final_state and handoff.result=trim(p_result) then return; end if;
  raise exception 'IDEMPOTENCY_CONFLICT';
 end if;
 if handoff.state='CANCELLED' then raise exception 'ROOT_CANCELLED'; end if;
 if handoff.state<>'DELIVERED' then raise exception 'HANDOFF_NOT_DELIVERED'; end if;
 if root.cancel_requested or root.state='CANCELLED' then raise exception 'ROOT_CANCELLED'; end if;
 if root.state in ('SUCCEEDED','FAILED') then raise exception 'ROOT_FINISHED'; end if;
 if handoff.group_id is not null then
  perform id from public.bot_groups where id=handoff.group_id and user_id=handoff.user_id and archived_at is null for update;
  if not found then raise exception 'GROUP_MEMBER_REQUIRED'; end if;
  perform bot_id from public.bot_group_memberships
   where group_id=handoff.group_id and user_id=handoff.user_id and bot_id in (handoff.source_bot_id,handoff.target_bot_id)
   order by bot_id for update;
  select count(*) into active_members from public.bot_group_memberships
   where group_id=handoff.group_id and user_id=handoff.user_id and bot_id in (handoff.source_bot_id,handoff.target_bot_id) and removed_at is null;
  if active_members<>2 then raise exception 'GROUP_MEMBER_REQUIRED'; end if;
 end if;
 update public.bot_handoffs set state=final_state,result_key=p_result_key,result=trim(p_result),finished_at=now() where id=handoff.id;
end $$;

create function public.cancel_root_handoffs() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.cancel_requested and not old.cancel_requested) or (new.state='CANCELLED' and old.state<>'CANCELLED') then
  update public.root_task_budgets set cancelled_at=coalesce(cancelled_at,now()) where root_run_id=new.id;
  update public.bot_handoffs set state='CANCELLED',finished_at=coalesce(finished_at,now())
   where root_run_id=new.id and state in ('AUTHORIZED','DELIVERED');
 end if;
 return new;
end $$;

create trigger propagate_root_handoff_cancellation after update of cancel_requested,state on public.runs
 for each row execute function public.cancel_root_handoffs();

revoke all on function public.save_memory(uuid,uuid,text,text,text,jsonb,uuid,integer),
 public.delete_memory(uuid,integer),public.save_bot_group(uuid,text,uuid),public.archive_bot_group(uuid),
 public.set_bot_group_member(uuid,uuid,boolean),public.authorize_bot_handoff(uuid,uuid,uuid,uuid,uuid,text,uuid[],bigint,uuid)
 from public,anon;
grant execute on function public.save_memory(uuid,uuid,text,text,text,jsonb,uuid,integer),
 public.delete_memory(uuid,integer),public.save_bot_group(uuid,text,uuid),public.archive_bot_group(uuid),
 public.set_bot_group_member(uuid,uuid,boolean),public.authorize_bot_handoff(uuid,uuid,uuid,uuid,uuid,text,uuid[],bigint,uuid)
 to authenticated;

revoke all on function public.deliver_bot_handoff(uuid,uuid),public.finish_bot_handoff(uuid,uuid,text,text),public.cancel_root_handoffs()
 from public,anon,authenticated;
grant execute on function public.deliver_bot_handoff(uuid,uuid),public.finish_bot_handoff(uuid,uuid,text,text) to service_role;
grant execute on function public.save_memory(uuid,uuid,text,text,text,jsonb,uuid,integer),
 public.authorize_bot_handoff(uuid,uuid,uuid,uuid,uuid,text,uuid[],bigint,uuid) to service_role;
