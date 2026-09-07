import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorDiagnosticReport, runtimeConfigurationReadiness } from '../src/domain/operator-readiness';

test('operator readiness reports missing keys and flags without exposing configured secret values', () => {
  const report = runtimeConfigurationReadiness({
    NODE_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'public-key',
    APP_URL: 'https://app.example.com', SUPABASE_SERVICE_ROLE_KEY: 'private-service-secret', TRIGGER_SECRET_KEY: 'private-trigger-secret',
    OPENAI_API_KEY: 'private-openai-secret', OPENAI_MODEL: 'model', OPENAI_INPUT_MICROS_PER_TOKEN: '1', OPENAI_OUTPUT_MICROS_PER_TOKEN: '1',
    ACCOUNT_CLEANUP_ENABLED: 'false', ACCOUNT_CLEANUP_WORKER_CONFIGURED: 'false', ACCOUNT_CLEANUP_COMPUTER_DESTROYER_CONFIGURED: 'false',
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private-service-secret|private-trigger-secret|private-openai-secret/);
  assert.equal(report.requestedFlags.memoryEnabled, false);
  assert.equal(report.requestedFlags.cleanupEnabled, false);
  assert.equal(report.configuration.accountCleanup.ready, false);
});

test('operator diagnostics expose bounded identifiers and aggregate counts only', () => {
  const report = operatorDiagnosticReport({ admissions: { runsEnabled: false, computerEnabled: false, watchEnabled: false },
    failedRuns: [{ id: 'run-a', state: 'FAILED', errorCode: 'BOUNDED' }], staleRuns: [], orphanedComputers: [],
    hermesRecoveryRequired: [{ id: 'run-stuck', state: 'RECOVERY_IN_PROGRESS', providerId: 'machine-a' }],
    pendingAccountDeletions: [{ id: 'deletion-a', state: 'FAILED', errorCode: 'AUTH_DELETE_FAILED' }] });
  assert.deepEqual(report.counts, { failedRuns: 1, staleRuns: 0, orphanedComputers: 0, hermesRecoveryRequired: 1, pendingAccountDeletions: 1 });
  assert.doesNotMatch(JSON.stringify(report), /message|password|content|credential/i);
});
