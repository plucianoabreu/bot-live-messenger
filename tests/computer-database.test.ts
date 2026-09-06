import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const migrations = [
  '202609060001_initial',
  '202609060002_pilot_quotas',
  '202609060003_team_profiles',
  '20260906193000_chat_worker',
  '20260906200000_collaboration_foundation',
  '20260906210000_live_chat_updates',
  '20260906220000_computer_foundation',
];

test('computer migration isolates operational data, fences resources, expires watch and keeps artifact paths private', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      insert into auth.users values('${A}'),('${B}');`);
    for (const migration of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
    const asUser = async (id: string) => db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);
    await asUser(A); await db.query('select public.ensure_bots()');
    const ownedBots = (await db.query<{ id: string }>('select id from public.bots order by id limit 2')).rows;
    const botA = ownedBots[0].id, botA2 = ownedBots[1].id;
    await asUser(B); await db.query('select public.ensure_bots()');
    await db.exec(`reset role;update public.runtime_config set runs_enabled=true,computer_enabled=true,watch_enabled=true;`);
    await asUser(A);
    const run = (await db.query<{ id: string }>("select public.enqueue_message($1,'computer work',$2,'computer') as id", [botA, crypto.randomUUID()])).rows[0].id;
    const run2 = crypto.randomUUID();
    await db.exec(`reset role;update public.runs set state='RUNNING',execution_version=1,lease_expires_at=now()+interval '2 minutes' where id='${run}';
      insert into public.runs(id,user_id,bot_id,idempotency_key,state,execution_version,lease_expires_at,kind,instructions_snapshot)
      values('${run2}','${A}','${botA2}',gen_random_uuid(),'RUNNING',1,now()+interval '2 minutes','computer','test');
      update public.workspace_computers set state='READY',provider_id='provider-private',template_version='v1',last_used_at=now() where user_id='${A}';`);

    const holderA = crypto.randomUUID(), holderB = crypto.randomUUID();
    await db.exec('set role service_role;');
    await assert.rejects(db.query("select public.acquire_computer_resource($1,1,$2,'file:/workspace/../secret',30)", [run, holderA]), /INVALID_RESOURCE_LEASE/);
    await assert.rejects(db.query("select public.acquire_computer_resource($1,1,$2,'browser:default',30)", [run, holderA]), /INVALID_RESOURCE_LEASE/);
    const racing = await Promise.allSettled([
      db.query("select public.acquire_computer_resource($1,1,$2,'file:/workspace/exports/race.txt',30)", [run, holderA]),
      db.query("select public.acquire_computer_resource($1,1,$2,'file:/workspace/exports/race.txt',30)", [run2, holderB]),
    ]);
    assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(racing.filter(result => result.status === 'rejected' && /RESOURCE_BUSY/.test(String(result.reason))).length, 1);
    await db.exec("reset role;delete from public.computer_resource_leases where resource_key='file:/workspace/exports/race.txt';set role service_role;");
    const first = Number((await db.query<{ token: string }>('select public.acquire_computer_resource($1,1,$2,\'desktop\',30) as token', [run, holderA])).rows[0].token);
    const renewal = Number((await db.query<{ token: string }>('select public.acquire_computer_resource($1,1,$2,\'desktop\',30) as token', [run, holderA])).rows[0].token);
    assert.equal(first, renewal);
    await assert.rejects(db.query('select public.acquire_computer_resource($1,1,$2,\'desktop\',30)', [run, holderB]), /RESOURCE_BUSY/);
    await db.exec(`reset role;update public.computer_resource_leases set expires_at=now()-interval '1 second';set role service_role;`);
    const second = Number((await db.query<{ token: string }>('select public.acquire_computer_resource($1,1,$2,\'desktop\',30) as token', [run, holderB])).rows[0].token);
    assert.ok(second > first);
    const fileToken = Number((await db.query<{ token: string }>("select public.acquire_computer_resource($1,1,$2,'file:/workspace/exports/report.svg',30) as token", [run, holderB])).rows[0].token);
    await db.exec('reset role;update public.runtime_config set runs_enabled=false;set role service_role;');
    await assert.rejects(db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,30)", [run, second, crypto.randomUUID()]), /LEASE_LOST/);
    await db.exec(`reset role;update public.runtime_config set runs_enabled=true;update public.runs set lease_expires_at=null where id='${run}';set role service_role;`);
    await assert.rejects(db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,30)", [run, second, crypto.randomUUID()]), /LEASE_LOST/);
    await db.exec(`reset role;update public.runs set lease_expires_at=now()+interval '2 minutes' where id='${run}';update public.runtime_config set computer_enabled=false;set role service_role;`);
    await assert.rejects(db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,30)", [run, second, crypto.randomUUID()]), /LEASE_LOST/);
    await db.exec(`reset role;update public.runtime_config set computer_enabled=true;update public.runs set lease_expires_at=now()-interval '1 second' where id='${run}';set role service_role;`);
    await assert.rejects(db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,30)", [run, second, crypto.randomUUID()]), /LEASE_LOST/);
    await db.exec(`reset role;update public.runs set lease_expires_at=now()+interval '2 minutes' where id='${run}';set role service_role;`);
    const unresolvedOperation = crypto.randomUUID();
    await db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,1)", [run, second, unresolvedOperation]);
    await assert.rejects(db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,1)", [run, second, crypto.randomUUID()]), /RESOURCE_BUSY/);
    await db.exec("reset role;update public.computer_resource_leases set expires_at=now()-interval '1 second' where resource_key='desktop';update public.computer_operations set deadline_at=now()-interval '1 second' where id='"+unresolvedOperation+"';set role service_role;");
    await assert.rejects(db.query("select public.acquire_computer_resource($1,1,$2,'desktop',30)", [run, holderA]), /RESOURCE_RECONCILIATION_REQUIRED/);
    await db.query("select public.finish_computer_operation($1,'UNCERTAIN')", [unresolvedOperation]);
    await assert.rejects(db.query("select public.acquire_computer_resource($1,1,$2,'desktop',30)", [run, holderA]), /RESOURCE_RECONCILIATION_REQUIRED/);
    await db.query("select public.reconcile_computer_operation($1,'FAILED','Provider reported that the action was not applied.')", [unresolvedOperation]);
    const third = Number((await db.query<{ token: string }>("select public.acquire_computer_resource($1,1,$2,'desktop',30) as token", [run, holderA])).rows[0].token);
    assert.ok(third > second);
    await db.exec(`reset role;update public.computer_run_usage set action_count=59 where run_id='${run}';set role service_role;`);
    const finalOperation = crypto.randomUUID();
    await db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,30)", [run, third, finalOperation]);
    await db.exec('reset role;');
    assert.equal(Number((await db.query<{ action_count: number }>('select action_count from public.computer_run_usage where run_id=$1', [run])).rows[0].action_count), 60);
    await db.exec('set role service_role;');
    await db.query("select public.finish_computer_operation($1,'SUCCEEDED')", [finalOperation]);
    await assert.rejects(db.query("select public.authorize_computer_operation($1,1,'desktop',$2,'action',$3,30)", [run, third, crypto.randomUUID()]), /ACTION_LIMIT/);

    await asUser(A);
    const watchId = (await db.query<{ id: string }>('select public.start_watch($1) as id', [run])).rows[0].id;
    await db.exec('reset role;set role service_role;');
    await db.query('select public.authorize_watch_capture($1,$2)', [A, watchId]);
    await db.exec('reset role;update public.runtime_config set watch_enabled=false;set role service_role;');
    await assert.rejects(db.query('select public.authorize_watch_capture($1,$2)', [A, watchId]), /WATCH_EXPIRED/);
    await db.exec('reset role;update public.runtime_config set watch_enabled=true;set role service_role;');
    const checksum = 'a'.repeat(64);
    const framePath = `${A}/${watchId}/0`;
    await db.query("select public.store_watch_frame($1,0::smallint,$2,'image/png',12,$3,now())", [watchId, framePath, checksum]);
    assert.equal((await db.query('select object_path from public.watch_frames where lease_id=$1', [watchId])).rows.length, 1);
    await asUser(A);
    const frame = (await db.query<{ value: { slot: number; checksum_sha256: string } }>('select public.authorize_watch_frame($1) as value', [watchId])).rows[0].value;
    assert.equal(frame.slot, 0); assert.equal(frame.checksum_sha256, checksum);
    await db.exec('reset role;update public.runtime_config set watch_enabled=false;');
    await asUser(A); await assert.rejects(db.query('select public.authorize_watch_frame($1)', [watchId]), /WATCH_NOT_FOUND/);
    await db.exec('reset role;update public.runtime_config set watch_enabled=true;');
    await asUser(B);
    await assert.rejects(db.query('select public.authorize_watch_frame($1)', [watchId]), /WATCH_NOT_FOUND/);
    await assert.rejects(db.query('select public.start_watch($1)', [run]), /RUN_NOT_FOUND/);
    await assert.rejects(db.query('select * from public.watch_frames'), /permission denied/);
    await assert.rejects(db.query('select * from public.computer_run_usage'), /permission denied/);
    await assert.rejects(db.query('select * from public.computer_operations'), /permission denied/);
    await assert.rejects(db.query('select * from public.artifact_upload_intents'), /permission denied/);
    await assert.rejects(db.query('select public.acquire_computer_resource($1,1,$2,\'desktop\',30)', [run, holderB]), /permission denied/);
    await assert.rejects(db.query('select public.claim_watch_cleanup()'), /permission denied/);
    await asUser(A); await db.query('select public.stop_watch($1)', [watchId]);
    await db.exec('reset role;set role service_role;');
    const cleanup = (await db.query<{ value: { lease_id: string; cleanup_token: string; object_paths: string[] } }>('select public.claim_watch_cleanup() as value')).rows[0].value;
    assert.equal(cleanup.lease_id, watchId); assert.deepEqual(cleanup.object_paths, [framePath]);
    assert.equal((await db.query<{ ok: boolean }>('select public.finish_watch_cleanup($1) as ok', [cleanup.cleanup_token])).rows[0].ok, true);

    await db.exec('reset role;set role service_role;');
    const artifactPath = `${A}/${run}/final/object`;
    await assert.rejects(db.query("select public.reserve_artifact_upload($1::uuid,1,'file:/workspace/exports/report.svg',$2::bigint,'wrong-owner','report.svg','private/object','image/svg+xml',20::bigint,$3::text)", [run, fileToken, 'b'.repeat(64)]), /INVALID_ARTIFACT/);
    const intentId = (await db.query<{ id: string }>("select public.reserve_artifact_upload($1::uuid,1,'file:/workspace/exports/report.svg',$2::bigint,'final','report.svg',$3,'image/svg+xml',20::bigint,$4::text) as id", [run, fileToken, artifactPath, 'b'.repeat(64)])).rows[0].id;
    const duplicate = (await db.query<{ id: string }>("select public.reserve_artifact_upload($1::uuid,1,'file:/workspace/exports/report.svg',$2::bigint,'final','report.svg',$3,'image/svg+xml',20::bigint,$4::text) as id", [run, fileToken, artifactPath, 'b'.repeat(64)])).rows[0].id;
    assert.equal(intentId, duplicate);
    await asUser(A);
    assert.equal((await db.query('select id from public.artifacts')).rows.length, 0);
    await assert.rejects(db.query('select * from public.artifact_upload_intents'), /permission denied/);
    await db.exec('reset role;set role service_role;');
    await db.query('select public.mark_artifact_uploaded($1)', [intentId]);
    const artifact = (await db.query<{ value: { id: string } }>('select public.finalize_artifact_upload($1) as value', [intentId])).rows[0].value;
    const artifactId = artifact.id;
    assert.equal((await db.query('select object_path from public.artifacts where id=$1', [artifactId])).rows.length, 1);
    await db.query('select public.mark_artifact_uploaded($1)', [intentId]);
    assert.equal((await db.query<{ value: { id: string } }>('select public.finalize_artifact_upload($1) as value', [intentId])).rows[0].value.id, artifactId);
    await assert.rejects(db.query("select public.reserve_artifact_upload($1::uuid,1,'file:/workspace/exports/report.svg',$2::bigint,'stale','stale.svg',$3,'image/svg+xml',20::bigint,$4::text)", [run, fileToken - 1, `${A}/${run}/stale/object`, 'c'.repeat(64)]), /LEASE_LOST/);
    await assert.rejects(db.query("select public.reserve_artifact_upload($1::uuid,1,'file:/workspace/exports/report.svg',$2::bigint,'final','other.svg',$3,'image/svg+xml',20::bigint,$4::text)", [run, fileToken, artifactPath, 'b'.repeat(64)]), /IDEMPOTENCY_CONFLICT/);
    const cleanupPath = `${A}/${run}/cleanup/object`;
    const cleanupIntent = (await db.query<{ id: string }>("select public.reserve_artifact_upload($1::uuid,1,'file:/workspace/exports/report.svg',$2::bigint,'cleanup','cleanup.svg',$3,'image/svg+xml',20::bigint,$4::text) as id", [run, fileToken, cleanupPath, 'c'.repeat(64)])).rows[0].id;
    await db.query('select public.reject_artifact_upload($1,true)', [cleanupIntent]);
    const artifactCleanup = (await db.query<{ value: { intent_id: string; object_path: string; cleanup_token: string } }>('select public.claim_artifact_cleanup() as value')).rows[0].value;
    assert.equal(artifactCleanup.intent_id, cleanupIntent); assert.equal(artifactCleanup.object_path, cleanupPath);
    assert.equal((await db.query<{ ok: boolean }>('select public.finish_artifact_cleanup($1) as ok', [artifactCleanup.cleanup_token])).rows[0].ok, true);
    await asUser(A);
    assert.equal((await db.query('select id,name,checksum_sha256 from public.artifacts where id=$1', [artifactId])).rows.length, 1);
    await assert.rejects(db.query('select object_path from public.artifacts where id=$1', [artifactId]), /permission denied/);
    await assert.rejects(db.query("insert into public.artifacts(user_id,run_id,name,object_path,mime_type,size_bytes) values($1,$2,'x','x','text/plain',1)", [A, run]), /permission denied/);
    await asUser(B);
    assert.equal((await db.query('select id,name from public.artifacts where id=$1', [artifactId])).rows.length, 0);

    await db.exec(`reset role;update public.runs set state='CANCELLED',finished_at=now() where id in ('${run}','${run2}');
      update public.workspace_computers set state='READY',last_used_at=now()-interval '20 seconds' where user_id='${A}';set role service_role;`);
    assert.equal((await db.query<{ value: null }>('select public.claim_idle_computer(15) as value')).rows[0].value, null);
    await db.exec('reset role;delete from public.computer_resource_leases;set role service_role;');
    const idle = (await db.query<{ value: { user_id: string; provider_id: string; version: number } }>('select public.claim_idle_computer(15) as value')).rows[0].value;
    assert.equal(idle.user_id, A); assert.equal(idle.provider_id, 'provider-private');
    assert.equal((await db.query<{ ok: boolean }>('select public.finish_idle_pause($1,$2,true) as ok', [A, idle.version])).rows[0].ok, true);
    await db.exec('reset role;');
    assert.equal((await db.query<{ state: string }>('select state from public.workspace_computers where user_id=$1', [A])).rows[0].state, 'PAUSED');
  } finally { await db.close(); }
});
