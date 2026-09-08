import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import {
  destroyOrphanHermesSandboxes,
  recoverOneStaleHermesWorkspace,
  type HermesOrphanSandboxApi,
  type StaleHermesRecoveryClaim,
} from '../src/server/execution/hermes-maintenance-recovery';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const migrations = [
  '202609060001_initial', '202609060002_pilot_quotas', '202609060003_team_profiles',
  '20260906193000_chat_worker', '20260906200000_collaboration_foundation',
  '20260906210000_live_chat_updates', '20260906220000_computer_foundation',
  '20260906230000_account_cleanup', '20260907163853_hermes_runtime',
  '20260907170000_hermes_artifacts_lifecycle', '20260907180000_hermes_security_recovery',
  '20260907190000_hermes_lifecycle_hardening', '20260907191000_hermes_usage_settlement',
  '20260907220000_hermes_crash_settlement',
];

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;insert into auth.users values('${OWNER}');`);
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
  }
  await db.exec(`select set_config('request.jwt.claim.sub','${OWNER}',false);set role authenticated;
    select public.ensure_bots();reset role;update public.runtime_config set runs_enabled=true,computer_enabled=true;
    set role authenticated;`);
  return db;
}

async function claimedRun(db: PGlite, botOffset = 0) {
  const bot = (await db.query<{ id: string }>(`select id from public.bots order by id offset ${botOffset} limit 1`)).rows[0].id;
  const run = (await db.query<{ id: string }>("select public.enqueue_message($1,'hello',$2) as id", [bot, crypto.randomUUID()])).rows[0].id;
  await db.exec('reset role;set role service_role;');
  const claim = (await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [run])).rows[0].value;
  return { run, version: claim.version };
}

test('stale Hermes recovery renews ownership and preserves only a complete paused binding', async () => {
  const db = await database();
  try {
    const active = await claimedRun(db);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [active.run, active.version, 'a'.repeat(64)]);
    await db.exec(`reset role;update public.hermes_workspaces set machine_id='machine-complete',
      base_url='https://runtime.example',api_key='${'b'.repeat(64)}',revision='r1';
      update public.runs set lease_expires_at=now()-interval '1 second';set role service_role;select public.reconcile_chats();`);

    await db.exec('reset role;set role authenticated;');
    await assert.rejects(db.query('select public.claim_stale_hermes_recovery()'), /permission denied/);
    await db.exec('reset role;set role service_role;');
    const first = (await db.query<{ value: StaleHermesRecoveryClaim }>('select public.claim_stale_hermes_recovery() as value')).rows[0].value;
    assert.equal(first.recovery_action, 'pause');
    assert.equal((await db.query<{ value: null }>('select public.claim_stale_hermes_recovery() as value')).rows[0].value, null);

    await db.exec("reset role;update public.hermes_workspaces set recovery_started_at=now()-interval '6 minutes';set role service_role;");
    const renewed = (await db.query<{ value: StaleHermesRecoveryClaim }>('select public.claim_stale_hermes_recovery() as value')).rows[0].value;
    assert.notEqual(renewed.recovery_token, first.recovery_token);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok',
      [OWNER, active.run, active.version, first.recovery_token],
    )).rows[0].ok, false);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok',
      [OWNER, active.run, active.version, renewed.recovery_token],
    )).rows[0].ok, true);
    await db.exec('reset role;');
    const row = (await db.query<{ machine_id: string; base_url: string; active_run: null; provision_cleanup_required: boolean }>(
      'select machine_id,base_url,active_run,provision_cleanup_required from public.hermes_workspaces',
    )).rows[0];
    assert.deepEqual(row, {
      machine_id: 'machine-complete', base_url: 'https://runtime.example', active_run: null,
      provision_cleanup_required: false,
    });
  } finally { await db.close(); }
});

test('partial provisioning is explicitly destroyed and its unusable binding is cleared', async () => {
  const db = await database();
  try {
    const active = await claimedRun(db);
    const proxy = 'c'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [active.run, active.version, proxy]);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.record_failed_hermes_provision($1,$2,$3,$4) as ok',
      [active.run, active.version, proxy, 'machine-partial'],
    )).rows[0].ok, true);
    await db.exec('reset role;');
    const marked = (await db.query<{ provision_cleanup_required: boolean; base_url: null; api_key: null; revision: null }>(
      'select provision_cleanup_required,base_url,api_key,revision from public.hermes_workspaces',
    )).rows[0];
    assert.deepEqual(marked, { provision_cleanup_required: true, base_url: null, api_key: null, revision: null });
    await db.exec("update public.runs set lease_expires_at=now()-interval '1 second';set role service_role;select public.reconcile_chats();");
    const recovery = (await db.query<{ value: StaleHermesRecoveryClaim }>('select public.claim_stale_hermes_recovery() as value')).rows[0].value;
    assert.equal(recovery.recovery_action, 'destroy');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok',
      [OWNER, active.run, active.version, recovery.recovery_token],
    )).rows[0].ok, true);
    await db.exec('reset role;');
    const cleared = (await db.query<{ machine_id: null; active_run: null; provision_cleanup_required: boolean }>(
      'select machine_id,active_run,provision_cleanup_required from public.hermes_workspaces',
    )).rows[0];
    assert.deepEqual(cleared, { machine_id: null, active_run: null, provision_cleanup_required: false });
  } finally { await db.close(); }
});

test('an incompatible resumed machine is durably marked for destroy recovery', async () => {
  const db = await database();
  try {
    const active = await claimedRun(db);
    const proxy = 'f'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [active.run, active.version, proxy]);
    await db.exec(`reset role;update public.hermes_workspaces set machine_id='machine-wrong-shape',
      base_url='https://runtime.example',api_key='${'b'.repeat(64)}',revision='r1';set role service_role;`);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.record_failed_hermes_provision($1,$2,$3,$4) as ok',
      [active.run, active.version, proxy, 'machine-wrong-shape'],
    )).rows[0].ok, true);
    await db.exec("reset role;update public.runs set lease_expires_at=now()-interval '1 second';set role service_role;select public.reconcile_chats();");
    const recovery = (await db.query<{ value: StaleHermesRecoveryClaim }>(
      'select public.claim_stale_hermes_recovery() as value',
    )).rows[0].value;
    assert.equal(recovery.machine_id, 'machine-wrong-shape');
    assert.equal(recovery.recovery_action, 'destroy');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok',
      [OWNER, active.run, active.version, recovery.recovery_token],
    )).rows[0].ok, true);
    await db.exec('reset role;');
    const cleared = (await db.query<{ machine_id: null; active_run: null; provision_cleanup_required: boolean }>(
      'select machine_id,active_run,provision_cleanup_required from public.hermes_workspaces where user_id=$1', [OWNER],
    )).rows[0];
    assert.deepEqual(cleared, { machine_id: null, active_run: null, provision_cleanup_required: false });
  } finally { await db.close(); }
});

test('maintenance performs the claimed provider action before fenced completion', async () => {
  const events: string[] = [];
  const claim: StaleHermesRecoveryClaim = {
    owner_id: OWNER,
    active_run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    active_execution_version: 2,
    machine_id: 'machine-partial',
    recovery_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    recovery_action: 'destroy',
    orphan_started_before: new Date('2026-09-07T12:00:00Z'),
  };
  assert.equal(await recoverOneStaleHermesWorkspace({
    async claim() { events.push('claim'); return claim; },
    async pause() { events.push('pause'); },
    async destroy() { events.push('destroy'); },
    async reconcile() { events.push('reconcile'); },
    async complete(received) { assert.deepEqual(received, claim); events.push('complete'); return true; },
  }), true);
  assert.deepEqual(events, ['claim', 'destroy', 'complete']);
});

test('maintenance reconciles an unbound fence before database completion', async () => {
  const events: string[] = [];
  const claim: StaleHermesRecoveryClaim = {
    owner_id: OWNER,
    active_run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    active_execution_version: 2,
    machine_id: null,
    recovery_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    recovery_action: 'reconcile',
    orphan_started_before: new Date('2026-09-07T12:00:00Z'),
  };
  assert.equal(await recoverOneStaleHermesWorkspace({
    async claim() { events.push('claim'); return claim; },
    async pause() { events.push('pause'); },
    async destroy() { events.push('destroy'); },
    async reconcile(received) { assert.deepEqual(received, claim); events.push('reconcile'); },
    async complete() { events.push('complete'); return true; },
  }), true);
  assert.deepEqual(events, ['claim', 'reconcile', 'complete']);
});

test('provider failure leaves the durable recovery fence for a later retry', async () => {
  let completed = false;
  await assert.rejects(recoverOneStaleHermesWorkspace({
    async claim() { return {
      owner_id: OWNER,
      active_run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      active_execution_version: 2,
      machine_id: 'machine-complete',
      recovery_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      recovery_action: 'pause',
      orphan_started_before: new Date('2026-09-07T12:00:00Z'),
    }; },
    async pause() { throw new Error('private provider detail'); },
    async destroy() {},
    async reconcile() {},
    async complete() { completed = true; return true; },
  }), /private provider detail/);
  assert.equal(completed, false);
});

test('orphan reconciliation lists one exact bounded E2B page and destroys every old candidate', async () => {
  const killed: string[] = [];
  let listed: unknown;
  const candidates = ['orphan-running', 'orphan-paused'].map((sandboxId, index) => ({
    sandboxId,
    metadata: { application: 'bot-live-messenger', owner: OWNER, engine: 'hermes', extra: 'allowed' },
    state: (index === 0 ? 'running' : 'paused') as 'running' | 'paused',
    startedAt: new Date('2026-09-07T11:00:00Z'),
  }));
  const api: HermesOrphanSandboxApi = {
    list(options) {
      listed = options;
      return { hasNext: false, async nextItems() { return candidates; } };
    },
    async kill(sandboxId, options) { assert.equal(options.apiKey, 'e2b-key'); killed.push(sandboxId); return true; },
  };
  await destroyOrphanHermesSandboxes('e2b-key', {
    owner_id: OWNER, orphan_started_before: new Date('2026-09-07T12:00:00Z'),
  }, api, 3);
  assert.deepEqual(listed, {
    apiKey: 'e2b-key',
    query: {
      metadata: { application: 'bot-live-messenger', owner: OWNER, engine: 'hermes' },
      state: ['running', 'paused'],
    },
    order: 'asc',
    limit: 3,
  });
  assert.deepEqual(killed, ['orphan-running', 'orphan-paused']);
});

test('orphan reconciliation fails closed before deleting a recent or unbounded result set', async () => {
  const killed: string[] = [];
  const candidate = {
    sandboxId: 'recent',
    metadata: { application: 'bot-live-messenger', owner: OWNER, engine: 'hermes' },
    state: 'running' as const,
    startedAt: new Date('2026-09-07T12:00:01Z'),
  };
  const api = (hasNext: boolean): HermesOrphanSandboxApi => ({
    list() { return { hasNext, async nextItems() { return [candidate]; } }; },
    async kill(sandboxId) { killed.push(sandboxId); return true; },
  });
  const claim = { owner_id: OWNER, orphan_started_before: new Date('2026-09-07T12:00:00Z') };
  await assert.rejects(destroyOrphanHermesSandboxes('key', claim, api(false)), /HERMES_ORPHAN_GRACE_ACTIVE/);
  await assert.rejects(destroyOrphanHermesSandboxes('key', claim, api(true)), /HERMES_ORPHAN_SCAN_LIMIT/);
  assert.deepEqual(killed, []);
});

test('account deletion waits until provisioning has either bound or released its provider target', async () => {
  const db = await database();
  try {
    const active = await claimedRun(db);
    const proxy = 'd'.repeat(64);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [active.run, active.version, proxy]);
    await db.query('select public.request_account_deletion($1)', [OWNER]);
    assert.equal((await db.query<{ value: null }>('select public.claim_account_deletion() as value')).rows[0].value, null,
      'machine_id NULL means provider creation may still be in flight');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.record_failed_hermes_provision($1,$2,$3,$4) as ok',
      [active.run, active.version, proxy, 'machine-created-late'],
    )).rows[0].ok, true);
    const cleanup = (await db.query<{ value: { computer_provider_ids: string[] } }>(
      'select public.claim_account_deletion() as value',
    )).rows[0].value;
    assert.deepEqual(cleanup.computer_provider_ids, ['machine-created-late']);
  } finally { await db.close(); }
});

test('stale unbound provisioning is reconciled even while account deletion is pending', async () => {
  const db = await database();
  try {
    const active = await claimedRun(db);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [active.run, active.version, 'e'.repeat(64)]);
    await db.query('select public.request_account_deletion($1)', [OWNER]);
    await db.exec("reset role;update public.runs set finished_at=now()-interval '6 minutes' where id='" + active.run + "';set role service_role;");
    assert.equal((await db.query<{ value: null }>('select public.claim_account_deletion() as value')).rows[0].value, null);
    const recovery = (await db.query<{ value: StaleHermesRecoveryClaim }>(
      'select public.claim_stale_hermes_recovery() as value',
    )).rows[0].value;
    assert.equal(recovery.recovery_action, 'reconcile');
    assert.equal(recovery.machine_id, null);
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_recovery($1,$2,$3,$4) as ok',
      [OWNER, active.run, active.version, recovery.recovery_token],
    )).rows[0].ok, true);
    const cleanup = (await db.query<{ value: { user_id: string } }>('select public.claim_account_deletion() as value')).rows[0].value;
    assert.equal(cleanup.user_id, OWNER);
  } finally { await db.close(); }
});

test('a replacement run cannot claim an unbound orphan before the maintenance scan', async () => {
  const db = await database();
  try {
    const abandoned = await claimedRun(db);
    await db.query('select public.claim_hermes_workspace($1,$2,$3)', [abandoned.run, abandoned.version, 'f'.repeat(64)]);
    await db.exec("reset role;update public.runs set lease_expires_at=now()-interval '1 second';set role service_role;select public.reconcile_chats();");
    await db.exec('reset role;set role authenticated;');
    const replacement = await claimedRun(db, 1);
    await assert.rejects(
      db.query('select public.claim_hermes_workspace($1,$2,$3)', [replacement.run, replacement.version, 'a'.repeat(64)]),
      /COMPUTER_RECOVERY_IN_PROGRESS/,
    );
    assert.equal((await db.query<{ value: null }>('select public.claim_stale_hermes_recovery() as value')).rows[0].value, null,
      'the metadata scan must wait for the five-minute grace');
    await db.exec("reset role;update public.runs set finished_at=now()-interval '6 minutes' where id='" + abandoned.run + "';set role service_role;");
    const recovery = (await db.query<{ value: StaleHermesRecoveryClaim }>('select public.claim_stale_hermes_recovery() as value')).rows[0].value;
    assert.equal(recovery.recovery_action, 'reconcile');
  } finally { await db.close(); }
});

test('account deletion reconciles unresolved operations only after every provider receipt', async () => {
  const db = await database();
  try {
    const active = await claimedRun(db);
    const operationId = crypto.randomUUID();
    await db.exec(`reset role;
      update public.workspace_computers set state='READY',provider_id='provider-delete',template_version='v1'
        where user_id='${OWNER}';
      insert into public.computer_operations(id,user_id,run_id,run_execution_version,resource_key,fencing_token,kind,deadline_at)
        values('${operationId}','${OWNER}','${active.run}',${active.version},'desktop',1,'action',now()+interval '1 minute');
      set role service_role;select public.request_account_deletion('${OWNER}');`);
    const cleanup = (await db.query<{ value: { claim_token: string } }>('select public.claim_account_deletion() as value')).rows[0].value;
    assert.ok(cleanup, 'a known provider can be destroyed even while its operation is unresolved');
    assert.equal((await db.query<{ ok: boolean }>(
      "select public.record_account_deletion_stage($1,'ARTIFACTS_DELETED') as ok", [cleanup.claim_token],
    )).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>(
      "select public.record_account_deletion_stage($1,'WATCH_DELETED') as ok", [cleanup.claim_token],
    )).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>(
      "select public.record_account_deletion_stage($1,'COMPUTER_DESTROYED') as ok", [cleanup.claim_token],
    )).rows[0].ok, false);
    await db.exec('reset role;');
    assert.equal((await db.query<{ state: string }>('select state from public.computer_operations where id=$1', [operationId])).rows[0].state, 'IN_FLIGHT');
    await db.exec('set role service_role;');
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.record_account_deletion_computer_receipt($1,$2) as ok', [cleanup.claim_token, 'provider-delete'],
    )).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>(
      "select public.record_account_deletion_stage($1,'COMPUTER_DESTROYED') as ok", [cleanup.claim_token],
    )).rows[0].ok, true);
    await db.exec('reset role;');
    const reconciled = (await db.query<{ state: string; reconciliation_evidence: string }>(
      'select state,reconciliation_evidence from public.computer_operations where id=$1', [operationId],
    )).rows[0];
    assert.deepEqual(reconciled, { state: 'FAILED', reconciliation_evidence: 'ACCOUNT_DELETION_PROVIDER_DESTROYED' });
    await db.exec('set role service_role;');
    await assert.rejects(db.query("select public.finish_computer_operation($1,'SUCCEEDED')", [operationId]), /OPERATION_NOT_CURRENT/);
  } finally { await db.close(); }
});
