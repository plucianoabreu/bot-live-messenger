import { z } from 'zod';
import { Sandbox } from '@e2b/desktop';
import { workerDatabase } from './database';

const staleRecoveryClaim = z.object({
  owner_id: z.uuid(),
  active_run_id: z.uuid(),
  active_execution_version: z.number().int().positive(),
  machine_id: z.string().trim().min(1).max(200).nullable(),
  recovery_token: z.uuid(),
  recovery_action: z.enum(['pause', 'destroy', 'reconcile']),
  orphan_started_before: z.coerce.date(),
}).superRefine((claim, context) => {
  if ((claim.recovery_action === 'reconcile') !== (claim.machine_id === null)) {
    context.addIssue({ code: 'custom', message: 'HERMES_RECOVERY_CLAIM_INVALID' });
  }
});

export type StaleHermesRecoveryClaim = z.infer<typeof staleRecoveryClaim>;

export type HermesMaintenanceRecoveryDependencies = {
  claim(): Promise<unknown>;
  pause(machineId: string): Promise<void>;
  destroy(machineId: string): Promise<void>;
  reconcile(claim: StaleHermesRecoveryClaim): Promise<void>;
  complete(claim: StaleHermesRecoveryClaim): Promise<boolean>;
};

type ListedSandbox = {
  sandboxId: string;
  metadata: Record<string, string>;
  state: 'running' | 'paused';
  startedAt: Date;
};

export type HermesOrphanSandboxApi = {
  list(options: {
    apiKey: string;
    query: { metadata: Record<string, string>; state: Array<'running' | 'paused'> };
    order: 'asc';
    limit: number;
  }): { readonly hasNext: boolean; nextItems(): Promise<ListedSandbox[]> };
  kill(sandboxId: string, options: { apiKey: string }): Promise<boolean>;
};

const defaultOrphanApi: HermesOrphanSandboxApi = {
  list: options => Sandbox.list(options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
};

/** Lists one bounded page and destroys only exact account-owned Hermes VMs. */
export async function destroyOrphanHermesSandboxes(
  apiKey: string,
  claim: Pick<StaleHermesRecoveryClaim, 'owner_id' | 'orphan_started_before'>,
  api: HermesOrphanSandboxApi = defaultOrphanApi,
  maxCandidates = 10,
) {
  if (!apiKey || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 25) {
    throw new Error('HERMES_ORPHAN_SCAN_INVALID');
  }
  const metadata = {
    application: 'bot-live-messenger',
    owner: claim.owner_id,
    engine: 'hermes',
  };
  const paginator = api.list({
    apiKey,
    query: { metadata, state: ['running', 'paused'] },
    order: 'asc',
    limit: maxCandidates,
  });
  const candidates = await paginator.nextItems();
  if (paginator.hasNext || candidates.length > maxCandidates) throw new Error('HERMES_ORPHAN_SCAN_LIMIT');
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.metadata.application !== metadata.application || candidate.metadata.owner !== metadata.owner ||
        candidate.metadata.engine !== metadata.engine || !['running', 'paused'].includes(candidate.state) ||
        !(candidate.startedAt instanceof Date) || !Number.isFinite(candidate.startedAt.getTime())) {
      throw new Error('HERMES_ORPHAN_SCAN_MISMATCH');
    }
    if (candidate.startedAt > claim.orphan_started_before) throw new Error('HERMES_ORPHAN_GRACE_ACTIVE');
    if (!candidate.sandboxId || candidate.sandboxId.length > 200 || /[\u0000-\u001f\u007f]/u.test(candidate.sandboxId)) {
      throw new Error('HERMES_ORPHAN_SCAN_MISMATCH');
    }
    ids.add(candidate.sandboxId);
  }
  for (const sandboxId of ids) await api.kill(sandboxId, { apiKey });
}

/** Reconciles at most one abandoned workspace under a database-owned token. */
export async function recoverOneStaleHermesWorkspace(
  dependencies: HermesMaintenanceRecoveryDependencies,
) {
  const raw = await dependencies.claim();
  if (raw === null) return false;
  const claim = staleRecoveryClaim.parse(raw);
  if (claim.recovery_action === 'reconcile') {
    await dependencies.reconcile(claim);
  } else if (claim.recovery_action === 'destroy') {
    await dependencies.destroy(claim.machine_id!);
  } else {
    await dependencies.pause(claim.machine_id!);
  }
  if (!await dependencies.complete(claim)) throw new Error('HERMES_RECOVERY_FENCE_CHANGED');
  return true;
}

export function supabaseHermesMaintenanceRecoveryDependencies(
  provider: Pick<HermesMaintenanceRecoveryDependencies, 'pause' | 'destroy' | 'reconcile'>,
): HermesMaintenanceRecoveryDependencies {
  const db = workerDatabase();
  return {
    claim: async () => {
      const result = await db.rpc('claim_stale_hermes_recovery');
      if (result.error) throw new Error('HERMES_RECOVERY_CLAIM_FAILED');
      return result.data;
    },
    pause: provider.pause,
    destroy: provider.destroy,
    reconcile: provider.reconcile,
    complete: async claim => {
      const result = await db.rpc('complete_hermes_recovery', {
        p_user_id: claim.owner_id,
        p_active_run: claim.active_run_id,
        p_active_version: claim.active_execution_version,
        p_recovery_token: claim.recovery_token,
      });
      if (result.error) throw new Error('HERMES_RECOVERY_COMPLETION_FAILED');
      return result.data === true;
    },
  };
}
