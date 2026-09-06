-- Canonical, owner-scoped chat polling cursors and sanitized lifecycle events.
-- This does not enable runtime admission or publish Realtime subscriptions.
alter table public.messages add column sequence bigint generated always as identity;
create unique index messages_owner_sequence on public.messages(user_id,bot_id,sequence);
create index runs_owner_latest on public.runs(user_id,bot_id,created_at desc,id desc);
create index events_owner_cursor on public.run_events(user_id,run_id,id);

alter table public.run_events add column schema_version integer not null default 1 check(schema_version=1);
alter table public.run_events add column payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object');

create function public.normalize_run_event() returns trigger
language plpgsql set search_path='' as $$
begin
 new.kind:=case new.kind
  when 'queued' then 'run_queued'
  when 'started' then 'run_started'
  when 'completed' then 'run_completed'
  when 'failed' then 'run_failed'
  when 'cancelled' then 'run_cancelled'
  else new.kind end;
 return new;
end $$;
create trigger normalize_run_event_before_insert before insert on public.run_events
for each row execute function public.normalize_run_event();

update public.run_events set kind=case kind
 when 'queued' then 'run_queued'
 when 'started' then 'run_started'
 when 'completed' then 'run_completed'
 when 'failed' then 'run_failed'
 when 'cancelled' then 'run_cancelled'
 else kind end;

create function public.record_run_transition() returns trigger
language plpgsql security definer set search_path='' as $$
declare event_kind text; event_summary text; event_payload jsonb:='{}'::jsonb;
begin
 if old.state is distinct from new.state then
  case new.state
   when 'RUNNING' then event_kind:='run_started'; event_summary:='Tarefa iniciada.';
   when 'FAILED' then event_kind:='run_failed'; event_summary:='Não foi possível concluir a tarefa.'; event_payload:=jsonb_build_object('reasonCode',coalesce(new.error_code,'EXECUTION_FAILED'));
   when 'CANCELLED' then event_kind:='run_cancelled'; event_summary:='Tarefa interrompida.';
   else event_kind:=null;
  end case;
 elsif not old.cancel_requested and new.cancel_requested then
  event_kind:='run_cancel_requested'; event_summary:='Interrupção solicitada.';
 end if;
 if event_kind is not null then
  insert into public.run_events(user_id,run_id,kind,summary,payload)
  values(new.user_id,new.id,event_kind,event_summary,event_payload);
 end if;
 return null;
end $$;
create trigger record_run_transition_after_update after update of state,cancel_requested,error_code on public.runs
for each row execute function public.record_run_transition();

revoke all on function public.normalize_run_event(),public.record_run_transition() from public,anon,authenticated;
