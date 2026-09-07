import { z } from 'zod';

const recoveryClaim = z.object({
  ownerId: z.uuid(),
  activeRunId: z.uuid(),
  activeExecutionVersion: z.number().int().positive(),
  machineId: z.string().trim().min(1).max(200),
  recoveryToken: z.uuid(),
});

export type HermesRecoveryClaim = z.infer<typeof recoveryClaim>;

export async function completeHermesRecoveryAfterPause(
  input: HermesRecoveryClaim,
  dependencies: {
    pause(machineId: string): Promise<void>;
    complete(input: HermesRecoveryClaim): Promise<boolean>;
  },
) {
  const claim = recoveryClaim.parse(input);
  try {
    await dependencies.pause(claim.machineId);
  } catch {
    throw new Error('HERMES_RECOVERY_PAUSE_FAILED');
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
    raw = await files.read('/opt/blm-hermes-state/launch.json', { user: 'root' });
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
  const expected = {
    HERMES_HOME: '/opt/blm-hermes-state', API_SERVER_KEY: authority.apiServerKey, API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: '8642', OPENAI_BASE_URL: gateway.toString(),
    TERMINAL_CWD: '/workspace/shared',
  };
  const allowedKeys = [...Object.keys(expected), 'OPENAI_API_KEY'].sort();
  if (Object.keys(record).sort().join('\0') !== allowedKeys.join('\0') ||
    !/^[a-f0-9]{64}$/.test(String(record.OPENAI_API_KEY)) ||
    Object.entries(expected).some(([key, value]) => record[key] !== value)) {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  try {
    await files.write('/opt/blm-hermes-state/launch.json', JSON.stringify({
      ...record, OPENAI_API_KEY: scopedToken,
    }), { user: 'root' });
  } catch {
    throw new Error('HERMES_GATEWAY_CONFIG_WRITE_FAILED');
  }
}
