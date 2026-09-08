import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('latency storage is service-only, fenced to the execution version, and holds no message content', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;insert into auth.users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);`);
    for (const file of ['202609060001_initial', '202609060002_pilot_quotas', '202609060003_team_profiles', '20260906193000_chat_worker', '20260906210000_live_chat_updates', '20260908020000_chat_latency_observability']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}.sql`, import.meta.url), 'utf8'));
    }
    await db.exec('select public.ensure_bots();update public.runtime_config set runs_enabled=true;');
    const { rows: [run] } = await db.query<{ id: string }>(`select public.enqueue_message((select id from public.bots limit 1),'hello',gen_random_uuid()) as id`);
    const { rows: [claim] } = await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [run.id]);
    assert.equal((await db.query<{ ok: boolean }>('select public.record_chat_latency_measurement($1,$2,0,4,7,8,null,null,null,null,null,null,null,null,42,45) as ok', [run.id, claim.value.version])).rows[0].ok, true);
    await db.exec('set role service_role;');
    const { rows: [measurement] } = await db.query<{ worker_claimed_ms: number; executor_finished_ms: number;persistence_completed_ms:number }>('select worker_claimed_ms,executor_finished_ms,persistence_completed_ms from public.chat_latency_measurements where run_id=$1', [run.id]);
    assert.deepEqual(measurement, { worker_claimed_ms: 0, executor_finished_ms: 42,persistence_completed_ms:45 });
    await db.exec('reset role;set role authenticated;');
    await assert.rejects(db.query('select * from public.chat_latency_measurements'), /permission denied/);
  } finally {
    await db.close();
  }
});
