import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.POSTGRES_TEST_URL;
if (!url || process.env.PREWARM_POSTGRES_TEST_DISPOSABLE !== '1') {
  throw new Error('PREWARM_POSTGRES_TEST_GUARD');
}
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ||
    !/^bot_messenger_prewarm_test_[a-z0-9_]+$/i.test(parsed.pathname.slice(1))) {
  throw new Error('PREWARM_POSTGRES_TEST_LOCAL_DISPOSABLE_REQUIRED');
}

function psql(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--dbname', url, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`PSQL_FAILED:${code}:${stderr.trim()}`)));
    child.stdin.end(input);
  });
}

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const migrationDirectory = resolve('supabase/migrations');

async function setup() {
  await psql([], `drop schema public cascade; create schema public; drop schema if exists auth cascade; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    do $$begin create role anon; exception when duplicate_object then null; end$$;
    do $$begin create role authenticated; exception when duplicate_object then null; end$$;
    do $$begin create role service_role; exception when duplicate_object then null; end$$;
    insert into auth.users values('${owner}');`);
  for (const file of (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort()) {
    await psql(['--file', resolve(migrationDirectory, file)]);
  }
  await psql([], `select set_config('request.jwt.claim.sub','${owner}',false); select public.ensure_bots();
    update public.runtime_config set runs_enabled=true,computer_enabled=true,prewarm_enabled=true;`);
}

async function concurrent(sql) {
  const started = Date.now();
  const left = psql([], sql.left);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  const right = psql([], sql.right);
  const [leftResult, rightResult] = await Promise.allSettled([left, right]);
  const output = result => result.status === 'fulfilled' ? result.value : String(result.reason);
  const [a, b] = [output(leftResult), output(rightResult)];
  return { a, b, elapsed: Date.now() - started };
}

try {
  await setup();
  const reservation = await concurrent({
    left: `begin; select public.claim_hermes_prewarm('${owner}'); select pg_sleep(2); commit;`,
    right: `select public.claim_hermes_prewarm('${owner}');`,
  });
  if (reservation.elapsed < 1_800 || !reservation.b.includes('busy')) throw new Error('PREWARM_ADMISSION_LOCK_NOT_PROVEN');

  const intent = (await psql(['--tuples-only', '--no-align'], `select id from public.prewarm_intents where user_id='${owner}' and settled_at is null;`)).trim();
  await psql([], `select public.bind_prewarm('${intent}','machine-postgres');
    select public.complete_hermes_prewarm('${owner}','${intent}','machine-postgres');
    update public.prewarm_intents set expires_at=now()-interval '1 second' where id='${intent}';`);
  const race = await concurrent({
    left: `begin; select public.claim_prewarm_cleanup('${intent}'); select pg_sleep(2); commit;`,
    right: `select set_config('request.jwt.claim.sub','${owner}',false);
      with queued as (
        select public.enqueue_message((select id from public.bots where user_id='${owner}' limit 1),'lock test','${randomUUID()}') as id
      ), claimed as (
        select id, public.claim_chat(id) as claim from queued
      ) select public.claim_hermes_workspace(id,1,'${'a'.repeat(64)}') from claimed;`,
  });
  if (race.elapsed < 1_800 || !/PREWARM_PENDING|PREWARM/.test(race.b)) {
    throw new Error(`PREWARM_HANDOFF_CLEANUP_LOCK_NOT_PROVEN:${JSON.stringify(race)}`);
  }
  console.log('PREWARM_POSTGRES_LOCK_PROOF_PASSED');
} finally {
  // The caller selected a disposable database. Keep it empty after every outcome.
  await psql([], 'drop schema public cascade; create schema public; drop schema auth cascade; create schema auth;').catch(() => undefined);
}
