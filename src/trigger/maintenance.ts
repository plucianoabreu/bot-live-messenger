import { Sandbox } from '@e2b/desktop';
import { schedules } from '@trigger.dev/sdk';
import { cleanupPrewarm } from '../server/execution/prewarm-recovery';
import { processOneAccountDeletion, supabaseAccountCleanupDependencies } from '../server/account-deletion';
import { cleanupOneArtifactIntent, cleanupOneExpiredWatch } from '../server/computer/worker-database';
import {
  destroyOrphanHermesSandboxes,
  recoverOneStaleHermesWorkspace,
  supabaseHermesMaintenanceRecoveryDependencies,
} from '../server/execution/hermes-maintenance-recovery';

export type MaintenanceOperations = {
  cleanupAccount(): Promise<unknown>;
  cleanupArtifact(): Promise<boolean>;
  cleanupWatch(): Promise<boolean>;
  recoverHermes(): Promise<boolean>;
  cleanupPrewarm(): Promise<boolean>;
};

export async function runMaintenance(operations: MaintenanceOperations) {
  // Start every lane through its own promise so synchronous configuration or
  // client construction failures cannot prevent the other lanes from running.
  const [account, artifact, watch, hermes, prewarm] = await Promise.allSettled([
    Promise.resolve().then(() => operations.cleanupAccount()),
    Promise.resolve().then(() => operations.cleanupArtifact()),
    Promise.resolve().then(() => operations.cleanupWatch()),
    Promise.resolve().then(() => operations.recoverHermes()),
    Promise.resolve().then(() => operations.cleanupPrewarm()),
  ]);
  if (account.status === 'rejected' || artifact.status === 'rejected' ||
      watch.status === 'rejected' || hermes.status === 'rejected' || prewarm.status === 'rejected') {
    // Each cleanup class still gets one bounded attempt. Trigger receives no
    // provider or database body that could contain private diagnostics.
    throw new Error('MAINTENANCE_PARTIAL_FAILURE');
  }
  return { account: account.value, artifact: artifact.value, watch: watch.value, hermes: hermes.value, prewarm: prewarm.value };
}

async function cleanupOneExpiredPrewarm(env: NodeJS.ProcessEnv): Promise<boolean> {
  return cleanupPrewarm(env);
}

function productionMaintenanceOperations(env: NodeJS.ProcessEnv = process.env): MaintenanceOperations {
  return {
    cleanupAccount: async () => {
      const e2bApiKey = env.E2B_API_KEY;
      if (!e2bApiKey) throw new Error('ACCOUNT_CLEANUP_NOT_CONFIGURED');
      return processOneAccountDeletion(supabaseAccountCleanupDependencies(async providerId => {
        // A missing sandbox is already in the desired destroyed state.
        await Sandbox.kill(providerId, { apiKey: e2bApiKey });
      }, env));
    },
    cleanupArtifact: async () => {
      if (!env.ARTIFACT_BUCKET) throw new Error('ARTIFACT_CLEANUP_NOT_CONFIGURED');
      return cleanupOneArtifactIntent(env.ARTIFACT_BUCKET);
    },
    cleanupWatch: async () => {
      if (!env.WATCH_FRAME_BUCKET) throw new Error('WATCH_CLEANUP_NOT_CONFIGURED');
      return cleanupOneExpiredWatch(env.WATCH_FRAME_BUCKET);
    },
    recoverHermes: async () => {
      const e2bApiKey = env.E2B_API_KEY;
      if (!e2bApiKey) throw new Error('HERMES_RECOVERY_NOT_CONFIGURED');
      return recoverOneStaleHermesWorkspace(supabaseHermesMaintenanceRecoveryDependencies({
        async pause(machineId) { await Sandbox.pause(machineId, { apiKey: e2bApiKey, keepMemory: false }); },
        async destroy(machineId) { await Sandbox.kill(machineId, { apiKey: e2bApiKey }); },
        async reconcile(claim) { await destroyOrphanHermesSandboxes(e2bApiKey, claim); },
      }));
    },
    cleanupPrewarm: () => cleanupOneExpiredPrewarm(env),
  };
}

export const maintenanceTask = schedules.task({
  id: 'bot-messenger-maintenance',
  cron: { pattern: '*/5 * * * *', environments: ['PRODUCTION'] },
  maxDuration: 120,
  retry: { maxAttempts: 1 },
  run: async () => runMaintenance(productionMaintenanceOperations()),
});
