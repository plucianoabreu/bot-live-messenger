import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;insert into auth.users values('${OWNER}');`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, directory), 'utf8'));
  }
  await db.exec(`select set_config('request.jwt.claim.sub','${OWNER}',false);set role authenticated;
    select public.ensure_bots();reset role;update public.runtime_config set runs_enabled=true,computer_enabled=true;set role authenticated;`);
  return db;
}

async function claimedHermesRun(db: PGlite) {
  const bot = (await db.query<{ id: string }>('select id from public.bots order by id limit 1')).rows[0].id;
  const run = (await db.query<{ id: string }>("select public.enqueue_message($1,'hello',$2) as id", [bot, crypto.randomUUID()])).rows[0].id;
  await db.exec('reset role;set role service_role;');
  const version = (await db.query<{ value: { version: number } }>('select public.claim_chat($1) as value', [run])).rows[0].value.version;
  await db.query('select public.claim_hermes_workspace($1,$2,$3)', [run, version, 'a'.repeat(64)]);
  return { run, version };
}

test('Hermes settlement is service-only, bounded and idempotent', async () => {
  const db = await database();
  try {
    const { run, version } = await claimedHermesRun(db);
    const key = `${run}:${version}:hermes_usage`;
    const fingerprint = 'b'.repeat(64);
    const args = [run, version, key, 'known', 270000, 1000, 2000, 3000, fingerprint, 'verified-v1', 1000, 2, 2048, JSON.stringify([])];
    const sql = 'select public.record_hermes_usage_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) as ok';
    assert.equal((await db.query<{ ok: boolean }>(sql, args)).rows[0].ok, true);
    assert.equal((await db.query<{ ok: boolean }>(sql, args)).rows[0].ok, true);
    await assert.rejects(db.query(sql, [...args.slice(0, 8), 'c'.repeat(64), ...args.slice(9)]), /HERMES_SETTLEMENT_CONFLICT/);
    await assert.rejects(db.query(sql, [run, version, key, 'known', 270000, 21000, 2000, 23000, fingerprint, 'verified-v1', 1000, 2, 2048, JSON.stringify([])]), /HERMES_SETTLEMENT_CONFLICT|HERMES_COST_LIMIT_BREACHED/);

    await db.exec('reset role;set role authenticated;');
    await assert.rejects(db.query(sql, args), /permission denied/);
  } finally { await db.close(); }
});

test('unknown usage is durable and retains the reservation without zero-cost fields', async () => {
  const db = await database();
  try {
    const { run, version } = await claimedHermesRun(db);
    const row = (await db.query<{ ok: boolean }>(
      'select public.record_hermes_usage_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) as ok',
      [run, version, `${run}:${version}:hermes_usage`, 'unknown', 270000, null, null, null,
        'd'.repeat(64), 'verified-v1', 1000, 2, 2048, JSON.stringify(['inputTokens','outputTokens'])],
    )).rows[0];
    assert.equal(row.ok, true);
    await db.exec('reset role;');
    const saved = (await db.query<{ status: string; total_cost_micros: null; reserved_micros: number }>(
      'select status,total_cost_micros,reserved_micros from public.hermes_usage_settlements where run_id=$1', [run],
    )).rows[0];
    assert.deepEqual(saved, { status: 'unknown', total_cost_micros: null, reserved_micros: 270000 });
  } finally { await db.close(); }
});
