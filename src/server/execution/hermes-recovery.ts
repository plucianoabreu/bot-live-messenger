import { z } from 'zod';
import { HERMES_LAUNCH_PATH, hermesLaunchConfiguration } from './hermes-launch-config';

const recoveryClaim = z.object({
  ownerId: z.uuid(),
  activeRunId: z.uuid(),
  activeExecutionVersion: z.number().int().positive(),
  machineId: z.string().trim().min(1).max(200).nullable(),
  recoveryToken: z.uuid(),
  recoveryAction: z.enum(['pause', 'destroy', 'reconcile']).default('pause'),
  orphanStartedBefore: z.coerce.date().optional(),
}).superRefine((claim, context) => {
  if (claim.recoveryAction === 'reconcile') {
    if (claim.machineId !== null || !claim.orphanStartedBefore) {
      context.addIssue({ code: 'custom', message: 'HERMES_RECOVERY_CLAIM_INVALID' });
    }
  } else if (claim.machineId === null) {
    context.addIssue({ code: 'custom', message: 'HERMES_RECOVERY_CLAIM_INVALID' });
  }
});

export type HermesRecoveryClaim = z.output<typeof recoveryClaim>;
export type HermesRecoveryInput = z.input<typeof recoveryClaim>;

export async function completeHermesRecoveryAfterPause(
  input: HermesRecoveryInput,
  dependencies: {
    pause(machineId: string): Promise<void>;
    destroy?(machineId: string): Promise<void>;
    reconcile?(input: HermesRecoveryClaim): Promise<void>;
    complete(input: HermesRecoveryClaim): Promise<boolean>;
  },
) {
  const claim = recoveryClaim.parse(input);
  try {
    if (claim.recoveryAction === 'reconcile') {
      if (!dependencies.reconcile) throw new Error('HERMES_RECOVERY_RECONCILE_UNAVAILABLE');
      await dependencies.reconcile(claim);
    } else if (claim.recoveryAction === 'destroy') {
      if (!dependencies.destroy) throw new Error('HERMES_RECOVERY_DESTROY_UNAVAILABLE');
      await dependencies.destroy(claim.machineId!);
    } else {
      await dependencies.pause(claim.machineId!);
    }
  } catch {
    throw new Error(claim.recoveryAction === 'reconcile' ? 'HERMES_RECOVERY_RECONCILE_FAILED'
      : claim.recoveryAction === 'destroy' ? 'HERMES_RECOVERY_DESTROY_FAILED' : 'HERMES_RECOVERY_PAUSE_FAILED');
  }
  let completed: boolean;
  try {
    completed = await dependencies.complete(claim);
  } catch {
    throw new Error('HERMES_RECOVERY_DATABASE_FAILED');
  }
  if (!completed) throw new Error('HERMES_RECOVERY_FENCE_CHANGED');
}

type HermesRuntimeFiles = {
  read(path: string, options?: { user?: string }): Promise<string>;
  write(path: string, contents: string, options?: { user?: string }): Promise<unknown>;
};

export async function rotateHermesGatewayToken(
  files: HermesRuntimeFiles,
  scopedToken: string,
  authority: { gatewayUrl: string; apiServerKey: string },
) {
  if (!/^[a-f0-9]{64}$/.test(scopedToken)) throw new Error('HERMES_GATEWAY_TOKEN_INVALID');
  if (!/^[a-f0-9]{64}$/.test(authority.apiServerKey)) throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  let gateway: URL;
  try {
    gateway = new URL(authority.gatewayUrl);
  } catch {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  let raw: string;
  try {
    raw = await files.read(HERMES_LAUNCH_PATH, { user: 'root' });
  } catch {
    throw new Error('HERMES_GATEWAY_CONFIG_READ_FAILED');
  }
  if (Buffer.byteLength(raw) > 32_000) throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  let configuration: unknown;
  try {
    configuration = JSON.parse(raw);
  } catch {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  const record = configuration as Record<string, unknown>;
  const expected = hermesLaunchConfiguration(authority, String(record.OPENAI_API_KEY));
  const allowedKeys = Object.keys(expected).sort();
  if (Object.keys(record).sort().join('\0') !== allowedKeys.join('\0') ||
    !/^[a-f0-9]{64}$/.test(String(record.OPENAI_API_KEY)) ||
    Object.entries(expected).some(([key, value]) => record[key] !== value)) {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  try {
    await files.write(HERMES_LAUNCH_PATH, JSON.stringify({
      ...record, OPENAI_API_KEY: scopedToken,
    }), { user: 'root' });
  } catch {
    throw new Error('HERMES_GATEWAY_CONFIG_WRITE_FAILED');
  }
}
