import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as
    $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;insert into auth.users values('${OWNER}');`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  await db.exec(`select set_config('request.jwt.claim.sub','${OWNER}',false);set role authenticated;
    select public.ensure_bots();reset role;update public.runtime_config set runs_enabled=true;set role authenticated;`);
  return db;
}

async function databaseWithHistoricalComputerAllocation() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as
    $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;insert into auth.users values('${OWNER}');`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql') && name !== '20260907230000_pilot_quota_rebalance.sql').sort();
  for (const name of migrations) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  await db.exec("update public.pilot_budgets set allocated_micros=12000000 where kind='computer'");
  await db.exec(await readFile(new URL('../supabase/migrations/20260907230000_pilot_quota_rebalance.sql', import.meta.url), 'utf8'));
  await db.exec(`select set_config('request.jwt.claim.sub','${OWNER}',false);set role authenticated;
    select public.ensure_bots();reset role;update public.runtime_config set runs_enabled=true,computer_enabled=true;set role authenticated;`);
  return db;
}

test('rebalance gives each account eight lifetime chats while retaining fixed global hard stops', async () => {
  const db = await database();
  try {
    await db.exec('reset role;');
    const pools = (await db.query<{ kind: string; limit_micros: number }>(
      'select kind,limit_micros from public.pilot_budgets order by kind',
    )).rows;
    assert.deepEqual(pools, [
      { kind: 'chat', limit_micros: 30_000_000 },
      { kind: 'computer', limit_micros: 10_000_000 },
    ]);
    assert.equal(Number((await db.query<{ limit_micros: number }>(
      'select limit_micros from public.account_pilot_budgets where user_id=$1', [OWNER],
    )).rows[0].limit_micros), 2_410_000);

    const bot = (await db.query<{ id: string }>('select id from public.bots limit 1')).rows[0].id;
    for (let index = 0; index < 8; index += 1) {
      await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${OWNER}',false);`);
      const run = (await db.query<{ id: string }>(
        "select public.enqueue_message($1,'quota',$2) as id", [bot, crypto.randomUUID()],
      )).rows[0].id;
      await db.exec(`reset role;update public.runs set state='FAILED',finished_at=now() where id='${run}';`);
    }
    await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${OWNER}',false);`);
    await assert.rejects(
      db.query("select public.enqueue_message($1,'ninth',$2)", [bot, crypto.randomUUID()]),
      /WELCOME_QUOTA/,
    );
  } finally { await db.close(); }
});

test('upgrade preserves an over-target computer allocation and fails closed for Hermes work', async () => {
  const db = await databaseWithHistoricalComputerAllocation();
  try {
    await db.exec('reset role;');
    assert.deepEqual((await db.query<{ allocated_micros: number; limit_micros: number }>(
      "select allocated_micros,limit_micros from public.pilot_budgets where kind='computer'",
    )).rows[0], { allocated_micros: 12_000_000, limit_micros: 12_000_000 });
    const bot = (await db.query<{ id: string }>('select id from public.bots limit 1')).rows[0].id;
    await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${OWNER}',false);`);
    const run = (await db.query<{ id: string }>(
      "select public.enqueue_message($1,'historical hold',$2) as id", [bot, crypto.randomUUID()],
    )).rows[0].id;
    await db.exec('reset role;set role service_role;');
    const version = (await db.query<{ value: { version: number } }>(
      'select public.claim_chat($1) as value', [run],
    )).rows[0].value.version;
    await assert.rejects(
      db.query('select public.claim_hermes_workspace($1,$2,$3)', [run, version, 'a'.repeat(64)]),
      /COMPUTER_BUDGET_EXHAUSTED/,
    );
    assert.equal((await db.query<{ count: number }>("select count(*)::int as count from public.account_pilot_reservations where run_id=$1 and reservation_kind='hermes'", [run])).rows[0].count, 0);
  } finally { await db.close(); }
});
