import { accountCleanupReadiness } from './account-deletion';

export type DiagnosticRecord = {
  id: string;
  state: string;
  errorCode?: string | null;
  createdAt?: string | null;
  heartbeatAt?: string | null;
  providerId?: string | null;
};

export type OperatorSnapshot = {
  admissions: { runsEnabled: boolean; computerEnabled: boolean; watchEnabled: boolean };
  failedRuns: DiagnosticRecord[];
  staleRuns: DiagnosticRecord[];
  orphanedComputers: DiagnosticRecord[];
  hermesRecoveryRequired: DiagnosticRecord[];
  pendingAccountDeletions: DiagnosticRecord[];
};

export function runtimeConfigurationReadiness(env: NodeJS.ProcessEnv = process.env) {
  const groups = {
    identity: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'APP_URL'],
    chat: ['SUPABASE_SERVICE_ROLE_KEY', 'TRIGGER_SECRET_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_INPUT_MICROS_PER_TOKEN', 'OPENAI_OUTPUT_MICROS_PER_TOKEN'],
    computer: ['E2B_API_KEY', 'E2B_TEMPLATE_ID', 'E2B_TEMPLATE_VERSION', 'E2B_NETWORK_POLICY_VERSION', 'E2B_ALLOWED_HOSTS', 'ARTIFACT_BUCKET', 'WATCH_FRAME_BUCKET'],
  } as const;
  const missing = Object.fromEntries(Object.entries(groups).map(([group, keys]) => [group, keys.filter(key => !env[key]?.trim())]));
  const cleanup = accountCleanupReadiness(env);
  return {
    event: 'operator.runtime_readiness',
    checkedAt: new Date().toISOString(),
    configuration: { missing, accountCleanup: cleanup },
    requestedFlags: {
      runsEnabled: env.RUNS_ENABLED === 'true',
      computerEnabled: env.COMPUTER_ENABLED === 'true',
      memoryEnabled: env.MEMORY_ENABLED === 'true',
      cleanupEnabled: env.ACCOUNT_CLEANUP_ENABLED === 'true',
    },
  };
}

export function operatorDiagnosticReport(snapshot: OperatorSnapshot) {
  return {
    event: 'operator.runtime_diagnostics',
    checkedAt: new Date().toISOString(),
    ...snapshot,
    counts: {
      failedRuns: snapshot.failedRuns.length,
      staleRuns: snapshot.staleRuns.length,
      orphanedComputers: snapshot.orphanedComputers.length,
      hermesRecoveryRequired: snapshot.hermesRecoveryRequired.length,
      pendingAccountDeletions: snapshot.pendingAccountDeletions.length,
    },
  };
}
