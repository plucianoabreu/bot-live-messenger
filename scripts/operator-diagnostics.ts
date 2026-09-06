import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { operatorDiagnosticReport, runtimeConfigurationReadiness, type DiagnosticRecord } from '../src/domain/operator-readiness';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

console.log(JSON.stringify(runtimeConfigurationReadiness()));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !serviceKey) {
  console.error(JSON.stringify({ event: 'operator.runtime_diagnostics_failed', code: 'SERVICE_DATABASE_CONFIGURATION_MISSING' }));
  process.exitCode = 1;
} else {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const [runtime, failed, active, computers, deletions] = await Promise.all([
    db.from('runtime_config').select('runs_enabled,computer_enabled,watch_enabled').eq('singleton', true).maybeSingle(),
    db.from('runs').select('id,state,error_code,created_at,heartbeat_at').eq('state', 'FAILED').order('created_at', { ascending: false }).limit(50),
    db.from('runs').select('id,user_id,state,error_code,created_at,heartbeat_at').in('state', ['QUEUED', 'RUNNING', 'WAITING_FOR_USER']).order('created_at', { ascending: true }).limit(200),
    db.from('workspace_computers').select('user_id,state,provider_id,last_used_at').not('provider_id', 'is', null).limit(200),
    db.from('account_deletion_requests').select('id,state,last_error_code,requested_at').neq('state', 'COMPLETED').order('requested_at', { ascending: true }).limit(100),
  ]);
  const databaseError = [runtime, failed, active, computers, deletions].some(result => Boolean(result.error));
  if (databaseError) {
    console.error(JSON.stringify({ event: 'operator.runtime_diagnostics_failed', code: 'DATABASE_READ_FAILED' }));
    process.exitCode = 1;
  } else {
    const activeRows = active.data ?? [];
    const activeUsers = new Set(activeRows.map(row => row.user_id));
    const mapRun = (row: typeof activeRows[number]): DiagnosticRecord => ({
      id: row.id, state: row.state, errorCode: row.error_code, createdAt: row.created_at, heartbeatAt: row.heartbeat_at,
    });
    const staleRuns = activeRows.filter(row => {
      const reference = row.heartbeat_at ?? row.created_at;
      return Boolean(reference && reference < staleBefore);
    }).map(mapRun);
    const orphanedComputers = (computers.data ?? []).filter(row =>
      !activeUsers.has(row.user_id) && ['CREATING', 'RESUMING', 'PAUSING', 'UNAVAILABLE', 'FAILED', 'DESTROYING'].includes(row.state)
    ).map(row => ({ id: `computer:${row.user_id}`, state: row.state, providerId: row.provider_id, createdAt: row.last_used_at }));
    console.log(JSON.stringify(operatorDiagnosticReport({
      admissions: {
        runsEnabled: Boolean(runtime.data?.runs_enabled),
        computerEnabled: Boolean(runtime.data?.computer_enabled),
        watchEnabled: Boolean(runtime.data?.watch_enabled),
      },
      failedRuns: (failed.data ?? []).map(row => ({ id: row.id, state: row.state, errorCode: row.error_code, createdAt: row.created_at, heartbeatAt: row.heartbeat_at })),
      staleRuns,
      orphanedComputers,
      pendingAccountDeletions: (deletions.data ?? []).map(row => ({ id: row.id, state: row.state, errorCode: row.last_error_code, createdAt: row.requested_at })),
    })));
  }
}

