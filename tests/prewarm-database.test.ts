import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function databaseWithAllMigrations() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    insert into auth.users values('${OWNER}');
    select set_config('request.jwt.claim.sub','${OWNER}',false);`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const migration of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(migration, directory), 'utf8'));
  }
  return db;
}

test('prewarm deduplicates an account and hands its ready lease to a real run without extending expiry', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec(`select public.ensure_bots(); reset role;
      update public.runtime_config set runs_enabled=true,computer_enabled=true,prewarm_enabled=true;
      insert into public.hermes_workspaces(user_id,machine_id,proxy_hash) values('${OWNER}','machine-prewarm','${'f'.repeat(64)}');`);
    const first = (await db.query<{ value: { status: string; lease_token: string } }>(
      'select public.claim_hermes_prewarm($1) as value', [OWNER],
    )).rows[0].value;
    const duplicate = (await db.query<{ value: { status: string; lease_token: string } }>(
      'select public.claim_hermes_prewarm($1) as value', [OWNER],
    )).rows[0].value;
    assert.equal(first.status, 'preparing');
    assert.equal(duplicate.lease_token, first.lease_token);
    assert.equal((await db.query('select user_id from public.hermes_prewarm_leases')).rows.length, 1);

    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_prewarm($1,$2,$3) as ok', [OWNER, first.lease_token, 'machine-prewarm'],
    )).rows[0].ok, true);
    const before = (await db.query<{ expires_at: string }>('select expires_at from public.hermes_prewarm_leases')).rows[0].expires_at;
    const bot = (await db.query<{ id: string }>('select id from public.bots limit 1')).rows[0].id;
    const run = (await db.query<{ id: string }>(
      "select public.enqueue_message($1,'hello',gen_random_uuid()) as id", [bot],
    )).rows[0].id;
    await db.query('select public.claim_chat($1)', [run]);
    const claimed = (await db.query<{ value: { status: string; machine_id: string } }>(
      'select public.claim_hermes_workspace($1,1,$2) as value', [run, 'a'.repeat(64)],
    )).rows[0].value;
    assert.deepEqual({ status: claimed.status, machine_id: claimed.machine_id }, { status: 'claimed', machine_id: 'machine-prewarm' });
    assert.equal((await db.query('select user_id from public.hermes_prewarm_leases')).rows.length, 0);
    assert.ok(before, 'ready expiry is minted once at readiness and is never extended by reopening');
  } finally { await db.close(); }
});

test('prewarm fails closed when disabled or when preparation misses its own deadline', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec('select public.ensure_bots(); reset role; update public.runtime_config set runs_enabled=true,computer_enabled=true,prewarm_enabled=false;');
    assert.equal((await db.query<{ value: { status: string } }>('select public.claim_hermes_prewarm($1) as value', [OWNER])).rows[0].value.status, 'disabled');
    await db.exec('reset role; update public.runtime_config set prewarm_enabled=true;');
    const lease = (await db.query<{ value: { lease_token: string } }>('select public.claim_hermes_prewarm($1) as value', [OWNER])).rows[0].value;
    await db.exec("update public.hermes_prewarm_leases set preparation_expires_at=now()-interval '1 second'");
    assert.equal((await db.query<{ ok: boolean }>(
      'select public.complete_hermes_prewarm($1,$2,$3) as ok', [OWNER, lease.lease_token, 'machine-late'],
    )).rows[0].ok, false);
    assert.equal((await db.query('select user_id from public.hermes_prewarm_leases')).rows.length, 0);
  } finally { await db.close(); }
});

test('expired ready prewarm is fenced, settled, and removed independently of a browser reopen', async () => {
  const db = await databaseWithAllMigrations();
  try {
    await db.exec(`select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true,prewarm_enabled=true;
      insert into public.hermes_workspaces(user_id,machine_id,proxy_hash) values('${OWNER}','machine-expiry','${'e'.repeat(64)}');`);
    const lease = (await db.query<{ value: { lease_token: string } }>('select public.claim_hermes_prewarm($1) as value', [OWNER])).rows[0].value;
    await db.query('select public.complete_hermes_prewarm($1,$2,$3)', [OWNER, lease.lease_token, 'machine-expiry']);
    await db.exec("update public.hermes_prewarm_leases set expires_at=now()-interval '1 second'");
    const cleanup = (await db.query<{ value: { lease_token: string; cleanup_token: string; machine_id: string } }>('select public.claim_expired_hermes_prewarm() as value')).rows[0].value;
    assert.equal(cleanup.machine_id, 'machine-expiry');
    assert.equal((await db.query<{ ok: boolean }>('select public.settle_hermes_prewarm($1,$2,$3,$4) as ok', [cleanup.lease_token, 'known', 42, 60_000])).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>('select public.complete_expired_hermes_prewarm($1,$2) as ok', [cleanup.lease_token, cleanup.cleanup_token])).rows[0].ok, true);
    assert.equal((await db.query('select lease_token from public.hermes_prewarm_leases')).rows.length, 0);
    assert.equal((await db.query('select lease_token from public.hermes_prewarm_settlements')).rows.length, 1);
  } finally { await db.close(); }
});
