import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = OWNER;

async function databaseWithAllMigrations() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    insert into auth.users values('${OWNER}');
    select set_config('request.jwt.claim.sub','${OWNER}',false);`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
  for (const migration of migrations) await db.exec(await readFile(new URL(migration, directory), 'utf8'));
  return db;
}

async function enqueueAndClaim(db: PGlite, botOffset = 0) {
  const bot = (await db.query<{ id: string }>('select id from public.bots order by id offset $1 limit 1', [botOffset])).rows[0].id;
  const run = (await db.query<{ id: string }>('select public.enqueue_message($1,$2,$3) as id', [bot, `hello-${botOffset}`, crypto.randomUUID()])).rows[0].id;
  const claim = (await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [run])).rows[0].value;
  return { run, version: claim.version };
}

test('Hermes keeps an account fence and atomically bounds cumulative model charges with the complete schema', async () => {
  const db = await databaseWithAllMigrations();
  try {
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
    await db.exec('update public.runtime_config set computer_enabled=true');
    const binding = (await db.query<{ value: { status: string } }>('select public.claim_hermes_workspace($1,1,$2) as value', [run.id, hash])).rows[0].value;
    assert.equal(binding.status, 'claimed');
    await assert.rejects(db.query('select public.claim_hermes_workspace($1,1,$2)', [run.id, hash]), /COMPUTER_BUSY/);
    await db.query('select public.authorize_hermes_model($1,10000)', [hash]);
    await db.exec('update public.runtime_config set computer_enabled=false');
    await assert.rejects(db.query('select public.authorize_hermes_model($1,1)', [hash]), /COMPUTER_DISABLED/);
    await db.exec('update public.runtime_config set computer_enabled=true');
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

test('Hermes claim fails closed while authoritative computer execution is disabled', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=false');
    const claimed = await enqueueAndClaim(db);
    await assert.rejects(
      db.query('select public.claim_hermes_workspace($1,$2,$3)', [claimed.run, claimed.version, 'a'.repeat(64)]),
      /COMPUTER_DISABLED/,
    );
    assert.equal((await db.query('select * from public.hermes_workspaces')).rows.length, 0);
  } finally { await db.close(); }
});

test('a new run and execution version rotate the Hermes proxy token and fence stale release', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const first = await enqueueAndClaim(db);
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [first.run, first.version, firstHash]);
    assert.equal((await db.query<{ ok: boolean }>('select public.release_hermes_workspace($1,$2,$3) as ok', [first.run, first.version + 1, firstHash])).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>('select public.release_hermes_workspace($1,$2,$3) as ok', [first.run, first.version, firstHash])).rows[0].ok, true);
    await db.query('select public.fail_chat($1,$2)', [first.run, first.version]);

    const second = await enqueueAndClaim(db, 1);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [second.run, second.version, secondHash]);
    await assert.rejects(db.query('select public.authorize_hermes_model($1,1)', [firstHash]), /UNAUTHORIZED/);
    await db.query('select public.authorize_hermes_model($1,1000)', [secondHash]);
    const workspace = (await db.query<{ proxy_hash: string; active_run: string; active_execution_version: number }>(
      'select proxy_hash,active_run,active_execution_version from public.hermes_workspaces',
    )).rows[0];
    assert.deepEqual(workspace, { proxy_hash: secondHash, active_run: second.run, active_execution_version: second.version });
  } finally { await db.close(); }
});

test('expired Hermes work requires an explicit recovery acknowledgement before the fence can move', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const abandoned = await enqueueAndClaim(db);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [abandoned.run, abandoned.version, 'a'.repeat(64)]);
    await db.exec("update public.hermes_workspaces set machine_id='machine-a'; update public.runs set lease_expires_at=now()-interval '1 second'");
    await db.query('select public.reconcile_chats()');
    const replacement = await enqueueAndClaim(db, 1);

    const firstRecovery = (await db.query<{ value: { status: string; active_run: string; active_execution_version: number; machine_id: string; recovery_token: string } }>(
      'select public.claim_hermes_workspace($1,$2,$3) as value', [replacement.run, replacement.version, 'b'.repeat(64)],
    )).rows[0].value;
    assert.equal(firstRecovery.status, 'recovery_required');
    assert.equal(firstRecovery.active_run, abandoned.run);
    assert.equal(firstRecovery.active_execution_version, abandoned.version);
    assert.equal(firstRecovery.machine_id, 'machine-a');

    await db.exec("update public.hermes_workspaces set recovery_started_at=now()-interval '1 day'");
    await assert.rejects(
      db.query('select public.claim_hermes_workspace($1,$2,$3)', [replacement.run, replacement.version, 'b'.repeat(64)]),
      /COMPUTER_RECOVERY_IN_PROGRESS/,
    );
    assert.equal((await db.query<{ active_run: string }>('select active_run from public.hermes_workspaces')).rows[0].active_run, abandoned.run);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok', [OWNER, abandoned.run, abandoned.version, crypto.randomUUID()],
    )).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok', [OWNER, abandoned.run, abandoned.version, firstRecovery.recovery_token],
    )).rows[0].ok, true);
    const replacementBinding = (await db.query<{ value: { status: string; active_run: string; active_execution_version: number } }>(
      'select public.claim_hermes_workspace($1,$2,$3) as value', [replacement.run, replacement.version, 'b'.repeat(64)],
    )).rows[0].value;
    assert.deepEqual(
      { status: replacementBinding.status, active_run: replacementBinding.active_run, active_execution_version: replacementBinding.active_execution_version },
      { status: 'claimed', active_run: replacement.run, active_execution_version: replacement.version },
    );
  } finally { await db.close(); }
});
