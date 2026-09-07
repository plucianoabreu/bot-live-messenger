import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = OWNER;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function databaseWithAllMigrations() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    insert into auth.users values('${OWNER}'),('${B}');
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
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const { rows: [run] } = await db.query<{ id: string }>(`select public.enqueue_message((select id from public.bots limit 1),'hello',gen_random_uuid()) as id`);
    await db.query('select public.claim_chat($1)', [run.id]);
    const hash = 'a'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,1,$2)', [run.id, hash]);
    await db.query("update public.hermes_workspaces set machine_id='machine-a' where active_run=$1", [run.id]);
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

test('Hermes pause tokens fence delayed completion before recovery can begin', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const abandoned = await enqueueAndClaim(db);
    const abandonedHash = 'a'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [abandoned.run, abandoned.version, abandonedHash]);
    await db.exec("update public.hermes_workspaces set machine_id='machine-pause' where active_run is not null");

    const pause = (await db.query<{ value: { pause_token: string; machine_id: string } }>(
      'select public.begin_hermes_pause($1,$2,$3) as value', [abandoned.run, abandoned.version, abandonedHash],
    )).rows[0].value;
    const retry = (await db.query<{ value: null }>(
      'select public.begin_hermes_pause($1,$2,$3) as value', [abandoned.run, abandoned.version, abandonedHash],
    )).rows[0].value;
    assert.equal(pause.machine_id, 'machine-pause');
    assert.equal(retry, null, 'only the worker that minted the pause token may call the provider');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.release_hermes_workspace($1,$2,$3) as ok', [abandoned.run, abandoned.version, abandonedHash],
    )).rows[0].ok, false, 'legacy release must not clear an in-progress pause');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_pause($1,$2,$3,$4) as ok',
      [abandoned.run, abandoned.version, abandonedHash, crypto.randomUUID()],
    )).rows[0].ok, false);

    await db.exec("update public.runs set lease_expires_at=now()-interval '1 second'");
    await db.query('select public.reconcile_chats()');
    const replacement = await enqueueAndClaim(db, 1);
    await assert.rejects(
      db.query('select public.claim_hermes_workspace($1,$2,$3)', [replacement.run, replacement.version, 'b'.repeat(64)]),
      /COMPUTER_RECOVERY_IN_PROGRESS/,
    );
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_pause($1,$2,$3,$4) as ok',
      [abandoned.run, abandoned.version, abandonedHash, pause.pause_token],
    )).rows[0].ok, true);
    const claimed = (await db.query<{ value: { status: string; active_run: string } }>(
      'select public.claim_hermes_workspace($1,$2,$3) as value', [replacement.run, replacement.version, 'b'.repeat(64)],
    )).rows[0].value;
    assert.deepEqual({ status: claimed.status, active_run: claimed.active_run }, { status: 'claimed', active_run: replacement.run });
  } finally { await db.close(); }
});

test('failed Hermes provisioning can release confirmed cleanup or retain a known machine for recovery', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const cleaned = await enqueueAndClaim(db);
    const cleanedHash = 'a'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [cleaned.run, cleaned.version, cleanedHash]);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.release_failed_hermes_provision($1,$2,$3) as ok', [cleaned.run, cleaned.version, 'f'.repeat(64)],
    )).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.release_failed_hermes_provision($1,$2,$3) as ok', [cleaned.run, cleaned.version, cleanedHash],
    )).rows[0].ok, true);
    await db.query('select public.fail_chat($1,$2)', [cleaned.run, cleaned.version]);

    const uncertain = await enqueueAndClaim(db, 1);
    const uncertainHash = 'b'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [uncertain.run, uncertain.version, uncertainHash]);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.record_failed_hermes_provision($1,$2,$3,$4) as ok',
      [uncertain.run, uncertain.version, uncertainHash, 'machine-uncertain'],
    )).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.record_failed_hermes_provision($1,$2,$3,$4) as ok',
      [uncertain.run, uncertain.version, uncertainHash, 'machine-uncertain'],
    )).rows[0].ok, true, 'recording the same cleanup target must be idempotent');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.release_failed_hermes_provision($1,$2,$3) as ok', [uncertain.run, uncertain.version, uncertainHash],
    )).rows[0].ok, false, 'uncertain provider cleanup must retain the account fence');

    await db.exec("update public.runs set lease_expires_at=now()-interval '1 second' where id='" + uncertain.run + "'");
    await db.query('select public.reconcile_chats()');
    const replacement = await enqueueAndClaim(db, 2);
    const recovery = (await db.query<{ value: { recovery_token: string; machine_id: string } }>(
      'select public.claim_hermes_workspace($1,$2,$3) as value', [replacement.run, replacement.version, 'c'.repeat(64)],
    )).rows[0].value;
    const staleBeginDuringRecovery = (await db.query<{ value: null }>(
      'select public.begin_hermes_pause($1,$2,$3) as value', [uncertain.run, uncertain.version, uncertainHash],
    )).rows[0].value;
    assert.equal(staleBeginDuringRecovery, null);
    assert.equal(recovery.machine_id, 'machine-uncertain');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok',
      [OWNER, uncertain.run, uncertain.version, recovery.recovery_token],
    )).rows[0].ok, true);
    const replacementBinding = (await db.query<{ value: { status: string } }>(
      'select public.claim_hermes_workspace($1,$2,$3) as value', [replacement.run, replacement.version, 'c'.repeat(64)],
    )).rows[0].value;
    assert.equal(replacementBinding.status, 'claimed');
    const staleBeginAfterReplacement = (await db.query<{ value: null }>(
      'select public.begin_hermes_pause($1,$2,$3) as value', [uncertain.run, uncertain.version, uncertainHash],
    )).rows[0].value;
    assert.equal(staleBeginAfterReplacement, null);
  } finally { await db.close(); }
});

test('Hermes artifact RPCs enforce both kill switches and the active execution version', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const claimed = await enqueueAndClaim(db);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [claimed.run, claimed.version, 'a'.repeat(64)]);
    await db.exec("update public.hermes_workspaces set machine_id='machine-artifact'");
    const objectPath = `${OWNER}/${claimed.run}/final/${'d'.repeat(64)}`;
    const intent = (await db.query<{ id: string }>(
      "select public.reserve_hermes_artifact_upload($1,$2,'/workspace/exports/report.txt','report','report.txt',$3,'text/plain',6,$4) as id",
      [claimed.run, claimed.version, objectPath, 'd'.repeat(64)],
    )).rows[0].id;
    await db.query('select public.mark_artifact_uploaded($1)', [intent]);

    await db.query('update public.hermes_workspaces set active_execution_version=$1', [claimed.version + 1]);
    await assert.rejects(db.query(
      "select public.authorize_hermes_artifact_export($1,$2,$3,'/workspace/exports/report.txt')",
      [OWNER, claimed.run, claimed.version],
    ), /LEASE_LOST/);
    await assert.rejects(db.query(
      "select public.reserve_hermes_artifact_upload($1,$2,'/workspace/exports/other.txt','other','other.txt',$3,'text/plain',6,$4)",
      [claimed.run, claimed.version, `${OWNER}/${claimed.run}/final/${'e'.repeat(64)}`, 'e'.repeat(64)],
    ), /LEASE_LOST/);
    await assert.rejects(db.query('select public.finalize_artifact_upload($1)', [intent]), /LEASE_LOST/);

    await db.query('update public.hermes_workspaces set active_execution_version=$1', [claimed.version]);
    await db.exec('update public.runtime_config set computer_enabled=false');
    await assert.rejects(db.query(
      "select public.authorize_hermes_artifact_export($1,$2,$3,'/workspace/exports/report.txt')",
      [OWNER, claimed.run, claimed.version],
    ), /LEASE_LOST/);
    await assert.rejects(db.query(
      "select public.reserve_hermes_artifact_upload($1,$2,'/workspace/exports/other.txt','other','other.txt',$3,'text/plain',6,$4)",
      [claimed.run, claimed.version, `${OWNER}/${claimed.run}/final/${'e'.repeat(64)}`, 'e'.repeat(64)],
    ), /LEASE_LOST/);
    await assert.rejects(db.query('select public.finalize_artifact_upload($1)', [intent]), /LEASE_LOST/);
  } finally { await db.close(); }
});

test('Hermes active-run FK preserves the workspace pair on run deletion and permits account cascade cleanup', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true');
    const claimed = await enqueueAndClaim(db);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [claimed.run, claimed.version, 'a'.repeat(64)]);
    await db.exec("update public.hermes_workspaces set machine_id='machine-fk'");
    await assert.rejects(db.query('delete from public.runs where id=$1', [claimed.run]), /foreign key constraint/);
    assert.deepEqual((await db.query<{ active_run: string; active_execution_version: number }>(
      'select active_run,active_execution_version from public.hermes_workspaces',
    )).rows[0], { active_run: claimed.run, active_execution_version: claimed.version });
    await db.query('delete from auth.users where id=$1', [OWNER]);
    assert.equal((await db.query('select * from public.hermes_workspaces')).rows.length, 0);
  } finally { await db.close(); }
});

test('account pilot budgets isolate users and keep run and Hermes reservations idempotent', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec(`select public.ensure_bots();select set_config('request.jwt.claim.sub','${B}',false);select public.ensure_bots();
      select set_config('request.jwt.claim.sub','${A}',false);update public.runtime_config set runs_enabled=true,computer_enabled=true;
      update public.account_pilot_budgets set allocated_micros=limit_micros where user_id='${A}';`);
    const botA = (await db.query<{ id: string }>('select id from public.bots where user_id=$1 order by id limit 1', [A])).rows[0].id;
    const botB = (await db.query<{ id: string }>('select id from public.bots where user_id=$1 order by id limit 1', [B])).rows[0].id;
    await assert.rejects(
      db.query("select public.enqueue_message($1,'account capped',$2)", [botA, crypto.randomUUID()]),
      /ACCOUNT_PILOT_BUDGET_EXHAUSTED/,
    );
    assert.equal((await db.query('select * from public.runs where user_id=$1', [A])).rows.length, 0);

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [B]);
    const key = crypto.randomUUID();
    const runB = (await db.query<{ id: string }>(
      "select public.enqueue_message($1,'other account',$2) as id", [botB, key],
    )).rows[0].id;
    assert.equal((await db.query<{ id: string }>(
      "select public.enqueue_message($1,'other account',$2) as id", [botB, key],
    )).rows[0].id, runB);
    assert.equal(Number((await db.query<{ allocated_micros: number }>(
      'select allocated_micros from public.account_pilot_budgets where user_id=$1', [B],
    )).rows[0].allocated_micros), 20000);
    assert.equal((await db.query(
      "select * from public.account_pilot_reservations where run_id=$1 and reservation_kind='run'", [runB],
    )).rows.length, 1);

    const claimB = (await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [runB])).rows[0].value;
    await db.query('select public.fail_chat($1,$2)', [runB, claimB.version]);
    await db.exec(`update public.account_pilot_budgets set allocated_micros=0 where user_id='${A}';
      select set_config('request.jwt.claim.sub','${A}',false);`);
    const runA = (await db.query<{ id: string }>(
      "select public.enqueue_message($1,'Hermes budget',$2) as id", [botA, crypto.randomUUID()],
    )).rows[0].id;
    const claimA = (await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [runA])).rows[0].value;
    await db.exec(`update public.account_pilot_budgets set allocated_micros=limit_micros where user_id='${A}'`);
    const computerBefore = Number((await db.query<{ allocated_micros: number }>(
      "select allocated_micros from public.pilot_budgets where kind='computer'",
    )).rows[0].allocated_micros);
    await assert.rejects(
      db.query('select public.claim_hermes_workspace($1,$2,$3)', [runA, claimA.version, 'a'.repeat(64)]),
      /ACCOUNT_PILOT_BUDGET_EXHAUSTED/,
    );
    assert.equal((await db.query('select * from public.hermes_workspaces where user_id=$1', [A])).rows.length, 0,
      'budget denial must roll back the tentative workspace row before provider work');
    assert.equal((await db.query(
      "select * from public.account_pilot_reservations where run_id=$1 and reservation_kind='hermes'", [runA],
    )).rows.length, 0);
    assert.equal(Number((await db.query<{ allocated_micros: number }>(
      "select allocated_micros from public.pilot_budgets where kind='computer'",
    )).rows[0].allocated_micros), computerBefore, 'account rejection must not consume the global pool');

    await db.exec(`update public.account_pilot_budgets set allocated_micros=20000 where user_id='${A}'`);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [runA, claimA.version, 'a'.repeat(64)]);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.release_failed_hermes_provision($1,$2,$3) as ok', [runA, claimA.version, 'a'.repeat(64)],
    )).rows[0].ok, true);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [runA, claimA.version, 'b'.repeat(64)]);
    assert.equal(Number((await db.query<{ allocated_micros: number }>(
      'select allocated_micros from public.account_pilot_budgets where user_id=$1', [A],
    )).rows[0].allocated_micros), 270000);
    assert.equal(Number((await db.query<{ allocated_micros: number }>(
      "select allocated_micros from public.pilot_budgets where kind='computer'",
    )).rows[0].allocated_micros), computerBefore + 250000);
    assert.equal((await db.query(
      "select * from public.account_pilot_reservations where run_id=$1 and reservation_kind='hermes'", [runA],
    )).rows.length, 1);
    await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);`);
    await assert.rejects(db.query('select * from public.account_pilot_budgets'), /permission denied/);
    await assert.rejects(db.query('select * from public.account_pilot_reservations'), /permission denied/);
  } finally { await db.close(); }
});

test('global pilot pool exhaustion rejects every account without creating reservations', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec(`select public.ensure_bots();select set_config('request.jwt.claim.sub','${B}',false);select public.ensure_bots();
      update public.runtime_config set runs_enabled=true;update public.pilot_budgets set allocated_micros=limit_micros where kind='chat';`);
    const botA = (await db.query<{ id: string }>('select id from public.bots where user_id=$1 limit 1', [A])).rows[0].id;
    const botB = (await db.query<{ id: string }>('select id from public.bots where user_id=$1 limit 1', [B])).rows[0].id;
    for (const [userId, botId] of [[A, botA], [B, botB]]) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
      await assert.rejects(
        db.query("select public.enqueue_message($1,'globally capped',$2)", [botId, crypto.randomUUID()]),
        /PILOT_BUDGET_EXHAUSTED/,
      );
    }
    assert.equal((await db.query('select * from public.runs')).rows.length, 0);
    assert.equal((await db.query('select * from public.account_pilot_reservations')).rows.length, 0);
  } finally { await db.close(); }
});
