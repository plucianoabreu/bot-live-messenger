import { artifactContract } from './hermes-artifact-contract';
import { randomBytes, createHash } from 'node:crypto';
import { Sandbox } from '@e2b/desktop';
import { setTimeout as delay } from 'node:timers/promises';
import { workerDatabase } from './database';
import { HermesClient } from './hermes';
import { connectHermesE2B, HermesE2BFactory, hermesRuntimeNetworkPolicy } from './hermes-e2b';
import { HermesProvisionError, provisionHermes } from './hermes-provision';
import { completeHermesRecoveryAfterPause, rotateHermesGatewayToken } from './hermes-recovery';
import { HERMES_LAUNCH_COMMAND, HERMES_LAUNCH_PATH } from './hermes-launch-config';
import { readHermesExport } from './hermes-export-reader';
import { exportHermesArtifact } from '../computer/hermes-artifacts';
import { databaseHermesArtifactAuthorizer, databaseHermesArtifactRepository, privateArtifactStore } from '../computer/worker-database';
import { defaultWorkspacePolicy } from '../computer/policy';
import { destroyOrphanHermesSandboxes } from './hermes-maintenance-recovery';
import {
  assertHermesComputeReservation,
  calculateHermesUsage,
  createHermesSettlement,
  hermesUsageConfiguration,
} from '../billing/hermes-usage';

const TERMINAL_HERMES_STATES = new Set(['completed', 'failed', 'cancelled']);

export function hermesExecutionMayContinue(run: { state?: string; cancel_requested?: boolean; execution_version?: number } | null, runtimeEnabled: boolean, version: number) {
  return runtimeEnabled && run?.state === 'RUNNING' && !run.cancel_requested && run.execution_version === version;
}

export function hermesRuntimeEnabled(config: { runs_enabled?: boolean; computer_enabled?: boolean } | null) {
  return config?.runs_enabled === true && config.computer_enabled === true;
}

export function chatRuntimeEnabled(
  config: { runs_enabled?: boolean; computer_enabled?: boolean } | null,
  hermesEnabled: boolean,
) {
  return config?.runs_enabled === true && (!hermesEnabled || config.computer_enabled === true);
}

export async function quiesceHermesRuntime(input: { client?: Pick<HermesClient, 'stop' | 'read'>; remoteRunId?: string; startAttempted?: boolean; alreadyTerminal: boolean; maxPolls?: number; wait?: () => Promise<void>; pause(): Promise<void>; release(): Promise<void> }) {
  if (!input.alreadyTerminal && input.startAttempted && !input.remoteRunId) {
    throw new Error('HERMES_STOP_UNCONFIRMED');
  }
  if (!input.alreadyTerminal && input.remoteRunId) {
    if (!input.client) throw new Error('HERMES_STOP_UNCONFIRMED');
    try { await input.client.stop(input.remoteRunId, AbortSignal.timeout(5_000)); } catch { throw new Error('HERMES_STOP_UNCONFIRMED'); }
    let stopped = false;
    for (let attempt = 0; attempt < (input.maxPolls ?? 10); attempt += 1) {
      let state;
      try { state = await input.client.read(input.remoteRunId, AbortSignal.timeout(3_000)); } catch { throw new Error('HERMES_STOP_UNCONFIRMED'); }
      if (TERMINAL_HERMES_STATES.has(state.status)) { stopped = true; break; }
      if (attempt + 1 < (input.maxPolls ?? 10)) await (input.wait ?? (() => delay(1_000)))();
    }
    if (!stopped) throw new Error('HERMES_STOP_UNCONFIRMED');
  }
  await input.pause();
  await input.release();
}

export async function destroyAmbiguousHermesRuntime(input: {
  destroy(): Promise<void>;
  settleUnknown(): Promise<void>;
  releaseDestroyed(): Promise<void>;
}) {
  await input.destroy();
  await input.settleUnknown();
  await input.releaseDestroyed();
}

export async function executeHermes(input: { runId: string; version: number; ownerId: string; botId: string; instructions: string; message: string; model: string; signal: AbortSignal }) {
  const key = process.env.E2B_API_KEY;
  const template = process.env.HERMES_TEMPLATE_ID;
  const gateway = process.env.HERMES_MODEL_GATEWAY_URL;
  if (!key || !template || !gateway) throw new Error('HERMES_NOT_CONFIGURED');
  const usageConfiguration = hermesUsageConfiguration(process.env);
  assertHermesComputeReservation(usageConfiguration);
  const resourceShape = {
    cpuCount: usageConfiguration.vcpuCount,
    memoryMib: usageConfiguration.memoryMib,
  };
  const usageStartedAt = Date.now();
  const networkPolicy = hermesRuntimeNetworkPolicy(gateway, process.env.E2B_NETWORK_POLICY_VERSION, process.env.E2B_ALLOWED_HOSTS);
  const db = workerDatabase();
  const token = randomBytes(32).toString('hex');
  const proxyHash = createHash('sha256').update(token).digest('hex');
  const claim = () => db.rpc('claim_hermes_workspace', { p_run_id: input.runId, p_version: input.version, p_proxy_hash: proxyHash });
  let { data: binding, error } = await claim();
  if (error || !binding || binding.user_id !== input.ownerId) throw new Error('HERMES_WORKSPACE_UNAVAILABLE');
  if (binding.status === 'recovery_required') {
    await completeHermesRecoveryAfterPause({ ownerId: input.ownerId, activeRunId: binding.active_run, activeExecutionVersion: binding.active_execution_version, machineId: binding.machine_id ?? null, recoveryToken: binding.recovery_token, recoveryAction: binding.recovery_action ?? 'pause', orphanStartedBefore: binding.orphan_started_before }, {
      async pause(machineId) { await Sandbox.pause(machineId, { apiKey: key, keepMemory: false }); },
      async destroy(machineId) { await Sandbox.kill(machineId, { apiKey: key }); },
      async reconcile(recovery) {
        await destroyOrphanHermesSandboxes(key, {
          owner_id: recovery.ownerId,
          orphan_started_before: recovery.orphanStartedBefore!,
        });
      },
      async complete(recovery) { const result = await db.rpc('complete_hermes_recovery', { p_user_id: recovery.ownerId, p_active_run: recovery.activeRunId, p_active_version: recovery.activeExecutionVersion, p_recovery_token: recovery.recoveryToken }); if (result.error) throw new Error('RECOVERY_DATABASE_ERROR'); return Boolean(result.data); },
    });
    ({ data: binding, error } = await claim());
  }
  if (error || !binding || binding.status !== 'claimed' || binding.user_id !== input.ownerId || binding.active_run !== input.runId || binding.active_execution_version !== input.version) throw new Error('HERMES_WORKSPACE_UNAVAILABLE');
  let machineId: string | undefined = binding.machine_id;
  let machineBindingPersisted = Boolean(binding.machine_id);
  let provisionCleanupRequired = false;
  let client: HermesClient | undefined;
  let remote: string | undefined;
  let startAttempted = false;
  let terminal = false;
  let observedUsage: { input_tokens: number; output_tokens: number } | undefined;
  let settlementAttempted = false;
  let settlementRecorded = false;
  let releaseUnboundProvision = false;
  let provisionRecoveryNeedsRecording = false;

  const recordSettlement = async (forceUnknown = false) => {
    if (settlementAttempted) {
      if (!settlementRecorded) throw new Error('HERMES_SETTLEMENT_UNCONFIRMED');
      return;
    }
    settlementAttempted = true;
    const durationMs = Math.max(0, Date.now() - usageStartedAt);
    const settledUsage = forceUnknown ? undefined : observedUsage;
    const calculation = calculateHermesUsage({
      durationMs,
      vcpuCount: usageConfiguration.vcpuCount,
      memoryMib: usageConfiguration.memoryMib,
      inputTokens: settledUsage?.input_tokens,
      outputTokens: settledUsage?.output_tokens,
    }, usageConfiguration.rates);
    const settlement = createHermesSettlement({
      runId: input.runId,
      executionVersion: input.version,
      reservedMicros: 270_000,
      calculation,
    });
    const recorded = await db.rpc('record_hermes_usage_settlement', {
      p_run_id: settlement.runId,
      p_version: settlement.executionVersion,
      p_idempotency_key: settlement.idempotencyKey,
      p_status: calculation.status,
      p_reserved_micros: settlement.reservedMicros,
      p_model_cost_micros: calculation.status === 'known' ? calculation.modelCostMicros : null,
      p_compute_cost_micros: calculation.status === 'known' ? calculation.computeCostMicros : null,
      p_total_cost_micros: calculation.status === 'known' ? calculation.totalCostMicros : null,
      p_usage_fingerprint: calculation.usageFingerprint,
      p_rate_card_id: usageConfiguration.rates.rateCardId,
      p_duration_ms: durationMs,
      p_vcpu_count: usageConfiguration.vcpuCount,
      p_memory_mib: usageConfiguration.memoryMib,
      p_missing_fields: calculation.status === 'unknown' ? calculation.missing : [],
    });
    if (recorded.error || !recorded.data) throw new Error('HERMES_SETTLEMENT_FAILED');
    settlementRecorded = true;
  };
  try {
    if (!machineId) {
      const created = await provisionHermes(
        new HermesE2BFactory(key, template, 120_000, networkPolicy, resourceShape),
        input.ownerId,
        { url: gateway, scopedToken: token },
      );
      machineId = created.machineId;
      const saved = await db.from('hermes_workspaces')
        .update({ machine_id: machineId, base_url: created.baseUrl, api_key: created.apiKey, revision: created.revision, provision_cleanup_required: false })
        .eq('user_id', input.ownerId).eq('active_run', input.runId)
        .eq('active_execution_version', input.version).eq('proxy_hash', proxyHash)
        .select('user_id').maybeSingle();
      if (saved.error || !saved.data) {
        let cleanupConfirmed = false;
        try { await Sandbox.kill(machineId, { apiKey: key }); cleanupConfirmed = true; } catch { /* retain provider id for recovery */ }
        throw new HermesProvisionError('binding', undefined, machineId, cleanupConfirmed);
      }
      machineBindingPersisted = true;
      client = new HermesClient(created);
    } else {
      if (binding.provision_cleanup_required || typeof binding.base_url !== 'string' ||
          !/^[a-f0-9]{64}$/.test(String(binding.api_key))) {
        throw new Error('HERMES_WORKSPACE_INCOMPLETE');
      }
      const sandbox = await connectHermesE2B(key, machineId, networkPolicy, resourceShape);
      await rotateHermesGatewayToken(sandbox.files, token, { gatewayUrl: gateway, apiServerKey: binding.api_key });
      await sandbox.commands.run(`chmod 600 ${HERMES_LAUNCH_PATH}`, { user: 'root', timeoutMs: 10_000 });
      await sandbox.commands.run(HERMES_LAUNCH_COMMAND, { user: 'root', background: true, timeoutMs: 0 });
      await sandbox.commands.run('python3 /opt/blm-hermes-ready.py', { user: 'root', timeoutMs: 50_000 });
      client = new HermesClient({ ownerId: input.ownerId, baseUrl: binding.base_url, apiKey: binding.api_key, trafficAccessToken: sandbox.trafficAccessToken! });
    }
    const startMarked = await db.rpc('begin_hermes_remote_start', {
      p_run_id: input.runId,
      p_version: input.version,
      p_proxy_hash: proxyHash,
      p_rate_card_id: usageConfiguration.rates.rateCardId,
      p_vcpu_count: usageConfiguration.vcpuCount,
      p_memory_mib: usageConfiguration.memoryMib,
    });
    if (startMarked.error || !startMarked.data) throw new Error('HERMES_START_FENCE_CHANGED');
    startAttempted = true;
    const contract = artifactContract(input.runId, input.version);
    const started = await client.start({ ...input, instructions: input.instructions + '\n\n' + contract.instructions }, input.signal);
    remote = started.runId;
    const remoteSaved = await db.rpc('record_hermes_remote_start', {
      p_run_id: input.runId,
      p_version: input.version,
      p_proxy_hash: proxyHash,
      p_remote_run: remote,
    });
    if (remoteSaved.error || !remoteSaved.data) throw new Error('HERMES_RUN_SAVE_FAILED');
    for (;;) {
      const state = await client.read(remote, input.signal);
      if (TERMINAL_HERMES_STATES.has(state.status)) {
        terminal = true;
        if (state.status !== 'completed' || !state.output?.trim() || !state.usage) throw new Error('HERMES_RUN_FAILED');
        observedUsage = state.usage;
        const delivered = contract.parse(state.output);
        if (delivered.relativePath) {
          const exportDb = workerDatabase();
          const bucket = process.env.ARTIFACT_BUCKET;
          if (!bucket) throw new Error('ARTIFACT_STORE_NOT_CONFIGURED');
          const sandbox = await connectHermesE2B(key, machineId!, networkPolicy, resourceShape);
          await exportHermesArtifact({ ownerId: input.ownerId, runId: input.runId, executionVersion: input.version, finalOutputKey: remote, relativePath: delivered.relativePath, policy: defaultWorkspacePolicy, authorizer: databaseHermesArtifactAuthorizer(exportDb), reader: { readExport: async request => {
            return readHermesExport(sandbox, request.path, request.maxBytes);
          } }, store: privateArtifactStore(bucket, exportDb), repository: databaseHermesArtifactRepository(exportDb) });
        }
        return { text: delivered.text, providerResponseId: remote, usage: state.usage };
      }
      await delay(1000, undefined, { signal: input.signal });
    }
  } catch (failure) {
    if (failure instanceof HermesProvisionError) {
      if (failure.cleanupConfirmed) {
        releaseUnboundProvision = true;
        machineId = undefined;
      } else if (failure.machineId) {
        machineId = failure.machineId;
        provisionCleanupRequired = true;
        provisionRecoveryNeedsRecording = true;
      }
    }
    if (machineId && (!machineBindingPersisted || provisionRecoveryNeedsRecording)) {
      const recorded = await db.rpc('record_failed_hermes_provision', {
        p_run_id: input.runId, p_version: input.version, p_proxy_hash: proxyHash, p_machine_id: machineId,
      });
      if (recorded.error || !recorded.data) throw new Error('HERMES_PROVISION_RECOVERY_RECORD_FAILED');
      machineBindingPersisted = true;
      provisionCleanupRequired = true;
    }
    throw failure;
  } finally {
    // A machine whose provisioning cleanup is uncertain is never promoted into
    // the normal reusable pause flow. Its provider ID remains fenced for an
    // explicit destroy/recovery operation.
    let finalizerFailure: unknown;
    if (releaseUnboundProvision) {
      try {
        await recordSettlement(true);
        const released = await db.rpc('release_failed_hermes_provision', {
          p_run_id: input.runId, p_version: input.version, p_proxy_hash: proxyHash,
        });
        if (released.error || !released.data) throw new Error('HERMES_PROVISION_RELEASE_FAILED');
      } catch (failure) {
        finalizerFailure = failure;
      }
    } else if (machineId && machineBindingPersisted && !provisionCleanupRequired && startAttempted && !remote && !terminal) {
      try {
        await destroyAmbiguousHermesRuntime({
          async destroy() { await Sandbox.kill(machineId!, { apiKey: key }); },
          async settleUnknown() { await recordSettlement(true); },
          async releaseDestroyed() {
            const completed = await db.rpc('complete_hermes_destroyed_start', {
              p_run_id: input.runId,
              p_version: input.version,
              p_proxy_hash: proxyHash,
              p_machine_id: machineId,
            });
            if (completed.error || !completed.data) throw new Error('HERMES_DESTROY_COMPLETION_FAILED');
          },
        });
      } catch (failure) {
        finalizerFailure = failure;
      }
    } else if (machineId && machineBindingPersisted && !provisionCleanupRequired) {
      try {
        const begun = await db.rpc('begin_hermes_pause', {
          p_run_id: input.runId, p_version: input.version, p_proxy_hash: proxyHash,
        });
        const pauseClaim = begun.data as { machine_id?: string; pause_token?: string } | null;
        if (begun.error || !pauseClaim?.pause_token || pauseClaim.machine_id !== machineId) {
          throw new Error('HERMES_PAUSE_FENCE_CHANGED');
        }
        await quiesceHermesRuntime({ client, remoteRunId: remote, startAttempted, alreadyTerminal: terminal,
          async pause() { await Sandbox.pause(machineId!, { apiKey: key, keepMemory: false }); },
          async release() {
            await recordSettlement(false);
            const completed = await db.rpc('complete_hermes_pause', {
              p_run_id: input.runId, p_version: input.version, p_proxy_hash: proxyHash,
              p_pause_token: pauseClaim.pause_token,
            });
            if (completed.error || !completed.data) throw new Error('HERMES_PAUSE_COMPLETION_FAILED');
          },
        });
      } catch (failure) {
        finalizerFailure = failure;
      }
    }

    if (!settlementAttempted) {
      try {
        // A failed or incomplete provider finalizer can keep billing after the
        // worker exits. Persist only a conservative unknown settlement.
        await recordSettlement(Boolean(finalizerFailure) || !terminal);
      } catch (failure) {
        finalizerFailure ??= failure;
      }
    }
    if (finalizerFailure) throw finalizerFailure;
  }
}
