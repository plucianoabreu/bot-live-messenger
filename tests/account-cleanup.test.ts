import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const migrations = [
  '202609060001_initial', '202609060002_pilot_quotas', '202609060003_team_profiles',
  '20260906193000_chat_worker', '20260906200000_collaboration_foundation',
  '20260906210000_live_chat_updates', '20260906220000_computer_foundation',
  '20260906230000_account_cleanup',
];

test('account deletion is durable, cancels work, inventories private resources and keeps a completion ledger', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      insert into auth.users values('${A}'),('${B}');`);
    for (const migration of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
    const asUser = async (id: string) => db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);
    await asUser(A);
    await db.query('select public.ensure_bots()');
    const bot = (await db.query<{ id: string }>('select id from public.bots limit 1')).rows[0].id;
    await db.exec('reset role;update public.runtime_config set runs_enabled=true;');
    await asUser(A);
    const run = (await db.query<{ id: string }>("select public.enqueue_message($1,'hello',$2) as id", [bot, crypto.randomUUID()])).rows[0].id;
    await db.exec('reset role;set role service_role;');
    const runClaim = (await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [run])).rows[0].value;
    await db.query('select public.authorize_chat_call($1,$2,1000)', [run, runClaim.version]);
    const artifactPath = `${A}/${run}/final/report.txt`;
    const watchId = crypto.randomUUID();
    const watchPath = `${A}/${watchId}/0`;
    await db.exec(`reset role;
      update public.workspace_computers set state='READY',provider_id='provider-a',template_version='v1' where user_id='${A}';
      insert into public.artifacts(user_id,run_id,name,object_path,mime_type,size_bytes) values('${A}','${run}','report.txt','${artifactPath}','text/plain',12);
      insert into public.watch_leases(user_id,id,run_id,expires_at) values('${A}','${watchId}','${run}',now()+interval '1 minute');
      insert into public.watch_frames(lease_id,user_id,slot,object_path,content_type,size_bytes,checksum_sha256,captured_at)
        values('${watchId}','${A}',0,'${watchPath}','image/png',12,'${'a'.repeat(64)}',now());`);
    await asUser(A);
    await assert.rejects(db.query('select public.request_account_deletion($1)', [A]), /permission denied/);
    await db.exec('reset role;set role service_role;');
    const requested = (await db.query<{ value: { id: string; state: string } }>('select public.request_account_deletion($1) as value', [A])).rows[0].value;
    assert.equal(requested.state, 'PENDING');
    assert.equal((await db.query<{ value: { id: string } }>('select public.request_account_deletion($1) as value', [A])).rows[0].value.id, requested.id);
    await asUser(A);
    const cancelled = (await db.query<{ cancel_requested: boolean; state: string }>('select cancel_requested,state from public.runs where id=$1', [run])).rows[0];
    assert.equal(cancelled.cancel_requested, true);
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal((await db.query<{ state: string }>('select state from public.workspace_computers where user_id=$1', [A])).rows[0].state, 'DESTROYING');
    await assert.rejects(db.query("select public.enqueue_message($1,'too late',$2)", [bot, crypto.randomUUID()]), /ACCOUNT_DELETION_PENDING/);
    await assert.rejects(db.query('select public.claim_account_deletion()'), /permission denied/);
    await assert.rejects(db.query('select public.renew_account_deletion_claim($1)', [crypto.randomUUID()]), /permission denied/);
    await assert.rejects(db.query("select public.record_account_deletion_stage($1,'ARTIFACTS_DELETED')", [crypto.randomUUID()]), /permission denied/);
    await asUser(B);
    assert.equal((await db.query<{ value: null }>('select public.get_account_deletion_request() as value')).rows[0].value, null);
    await db.exec('reset role;set role service_role;');
    const cleanup = (await db.query<{ value: { request_id: string; user_id: string; claim_token: string; artifact_paths: string[]; watch_paths: string[]; computer_provider_id: string; artifacts_deleted: boolean } }>('select public.claim_account_deletion() as value')).rows[0].value;
    assert.equal(cleanup.request_id, requested.id);
    assert.equal(cleanup.user_id, A);
    assert.deepEqual(cleanup.artifact_paths, [artifactPath]);
    assert.deepEqual(cleanup.watch_paths, [watchPath]);
    assert.equal(cleanup.computer_provider_id, 'provider-a');
    assert.equal(cleanup.artifacts_deleted, false);
    assert.equal((await db.query<{ ok: boolean }>('select public.finish_account_deletion($1) as ok', [cleanup.claim_token])).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>("select public.record_account_deletion_stage($1,'WATCH_DELETED') as ok", [cleanup.claim_token])).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>("select public.record_account_deletion_stage($1,'ARTIFACTS_DELETED') as ok", [cleanup.claim_token])).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>("select public.record_account_deletion_stage($1,'WATCH_DELETED') as ok", [cleanup.claim_token])).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>("select public.record_account_deletion_stage($1,'COMPUTER_DESTROYED') as ok", [cleanup.claim_token])).rows[0].ok, true);
    await db.exec(`reset role;delete from auth.users where id='${A}';set role service_role;`);
    assert.equal((await db.query<{ ok: boolean }>("select public.record_account_deletion_stage($1,'AUTH_DELETED') as ok", [cleanup.claim_token])).rows[0].ok, true);
    await db.exec('reset role;');
    for (const table of ['model_calls','runs','bots','messages','computers','run_events','artifacts','watch_leases','watch_frames',
      'profiles','workspace_computers','computer_operations','computer_run_usage','computer_resource_leases','artifact_upload_intents',
      'memory_items','memory_versions','bot_groups','bot_group_memberships','root_task_budgets','bot_handoffs','handoff_source_messages']) {
      assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0, `${table} should be erased`);
    }
    await db.exec('set role service_role;');
    assert.equal((await db.query<{ ok: boolean }>('select public.finish_account_deletion($1) as ok', [cleanup.claim_token])).rows[0].ok, true);
    await db.exec('reset role;');
    const ledger = (await db.query<{ state: string; completed_at: string | null; user_id: string | null }>('select state,completed_at,user_id from public.account_deletion_requests where id=$1', [requested.id])).rows[0];
    assert.equal(ledger.state, 'COMPLETED');
    assert.ok(ledger.completed_at);
    assert.equal(ledger.user_id, null);
  } finally { await db.close(); }
});

test('failed cleanup claims are retryable and expose only bounded error codes', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;insert into auth.users values('${A}');`);
    for (const migration of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
    await db.exec(`set role service_role;select public.request_account_deletion('${A}');`);
    const cleanupClaim = (await db.query<{ value: { claim_token: string } }>('select public.claim_account_deletion() as value')).rows[0].value;
    await db.exec("reset role;update public.account_deletion_requests set lease_expires_at=now()-interval '1 second';set role service_role;");
    const reclaimed = (await db.query<{ value: { claim_token: string } }>('select public.claim_account_deletion() as value')).rows[0].value;
    assert.notEqual(reclaimed.claim_token, cleanupClaim.claim_token);
    assert.equal((await db.query<{ ok: boolean }>('select public.renew_account_deletion_claim($1) as ok', [cleanupClaim.claim_token])).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>("select public.record_account_deletion_stage($1,'ARTIFACTS_DELETED') as ok", [cleanupClaim.claim_token])).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>("select public.fail_account_deletion($1,'AUTH_DELETE_FAILED') as ok", [reclaimed.claim_token])).rows[0].ok, true);
    await assert.rejects(db.query("select public.fail_account_deletion($1,'raw provider response')", [cleanupClaim.claim_token]), /INVALID_CLEANUP_ERROR/);
    await db.exec('reset role;');
    const row = (await db.query<{ state: string; last_error_code: string }>('select state,last_error_code from public.account_deletion_requests')).rows[0];
    assert.deepEqual(row, { state: 'FAILED', last_error_code: 'AUTH_DELETE_FAILED' });
  } finally { await db.close(); }
});
