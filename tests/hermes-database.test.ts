import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('Hermes keeps an account fence and atomically bounds cumulative model charges', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      insert into auth.users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);`);
    for (const file of ['202609060001_initial','202609060002_pilot_quotas','202609060003_team_profiles','20260906193000_chat_worker',
      '20260906220000_computer_foundation','20260906230000_account_cleanup','20260907163853_hermes_runtime','20260907170000_hermes_artifacts_lifecycle']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}.sql`, import.meta.url), 'utf8'));
    }
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true');
    const { rows: [run] } = await db.query<{ id: string }>(`select public.enqueue_message((select id from public.bots limit 1),'hello',gen_random_uuid()) as id`);
    await db.query('select public.claim_chat($1)', [run.id]);
    const hash = 'a'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,1,$2)', [run.id, hash]);
    await db.query("update public.hermes_workspaces set machine_id='machine-a' where active_run=$1", [run.id]);
    await assert.rejects(db.query('select public.claim_hermes_workspace($1,1,$2)', [run.id, hash]), /COMPUTER_RECOVERY_REQUIRED/);
    const authorized = (await db.query<{ value: { machine_id: string } }>(
      "select public.authorize_hermes_artifact_export($1,$2,1,'/workspace/exports/report.txt') as value", [A, run.id],
    )).rows[0].value;
    assert.equal(authorized.machine_id, 'machine-a');
    const objectPath = `${A}/${run.id}/final/${'c'.repeat(64)}`;
    const intent = (await db.query<{ id: string }>(
      "select public.reserve_hermes_artifact_upload($1,1,'/workspace/exports/report.txt','report','report.txt',$2,'text/plain',6,$3) as id",
      [run.id, objectPath, 'c'.repeat(64)],
    )).rows[0].id;
    await db.query('select public.mark_artifact_uploaded($1)', [intent]);
    const artifact = (await db.query<{ value: { checksum_sha256: string; size_bytes: number } }>(
      'select public.finalize_artifact_upload($1) as value', [intent],
    )).rows[0].value;
    assert.equal(artifact.checksum_sha256, 'c'.repeat(64));
    assert.equal(Number(artifact.size_bytes), 6);
    await assert.rejects(db.query(
      "select public.authorize_hermes_artifact_export($1,$2,1,'/workspace/exports/../secret')", [A, run.id],
    ), /INVALID_EXPORT_PATH/);
    await db.query('select public.authorize_hermes_model($1,10000)', [hash]);
    await db.query('select public.authorize_hermes_model($1,10000)', [hash]);
    await assert.rejects(db.query('select public.authorize_hermes_model($1,1)', [hash]), /BUDGET_EXCEEDED/);
    assert.equal(Number((await db.query<{ reserved_micros: number }>('select reserved_micros from public.model_calls')).rows[0].reserved_micros), 20000);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from public.hermes_workspaces'), /permission denied/);
    await assert.rejects(db.query('select public.authorize_hermes_model($1,1)', [hash]), /permission denied/);
    await assert.rejects(db.query(
      "select public.authorize_hermes_artifact_export($1,$2,1,'/workspace/exports/report.txt')", [A, run.id],
    ), /permission denied/);
    await db.exec('reset role');
    await db.query('update public.runs set cancel_requested=true where id=$1', [run.id]);
    await assert.rejects(db.query('select public.authorize_hermes_model($1,1)', [hash]), /LEASE_LOST/);
    await assert.rejects(db.query(
      "select public.authorize_hermes_artifact_export($1,$2,1,'/workspace/exports/report.txt')", [A, run.id],
    ), /LEASE_LOST/);
  } finally { await db.close(); }
});
