import { isIP } from 'node:net';
import { Sandbox } from '@e2b/desktop';
import { z } from 'zod';
import type { HermesMachine, HermesMachineFactory } from './hermes-provision';

export type HermesNetworkPolicy = {
  version: string;
  allowedHosts: readonly string[];
};

type E2BSandbox = {
  sandboxId: string;
  trafficAccessToken?: string;
  files: { write(path: string, contents: string, options: { user: string }): Promise<unknown> };
  commands: { run(command: string, options: Record<string, unknown>): Promise<{ exitCode: number }> };
  getHost(port: number): string;
  getInfo(): Promise<{ network?: { allowOut?: string[]; denyOut?: string[]; allowPublicTraffic?: boolean } }>;
  updateNetwork(network: { allowOut: string[]; denyOut: string[] }): Promise<void>;
  kill(): Promise<unknown>;
};

export type HermesE2BApi = {
  create(template: string, options: Record<string, unknown>): Promise<E2BSandbox>;
  connect(sandboxId: string, options: Record<string, unknown>): Promise<E2BSandbox>;
};

const defaultApi: HermesE2BApi = {
  create: (template, options) => Sandbox.create(template, options) as unknown as Promise<E2BSandbox>,
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options) as unknown as Promise<E2BSandbox>,
};

function normalizeHost(input: string) {
  const host = input.trim().toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.includes('*') || isIP(host)) {
    throw new Error('HERMES_NETWORK_DESTINATION_INVALID');
  }
  let parsed: URL;
  try { parsed = new URL(`https://${host}`); } catch { throw new Error('HERMES_NETWORK_DESTINATION_INVALID'); }
  if (parsed.hostname !== host || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error('HERMES_NETWORK_DESTINATION_INVALID');
  }
  return host;
}

export function validateHermesNetworkPolicy(policy: HermesNetworkPolicy): HermesNetworkPolicy {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(policy.version.trim())) {
    throw new Error('HERMES_NETWORK_POLICY_UNVERIFIED');
  }
  const allowedHosts = [...new Set(policy.allowedHosts.map(normalizeHost))];
  if (allowedHosts.length === 0) throw new Error('HERMES_NETWORK_DESTINATIONS_EMPTY');
  return { version: policy.version.trim(), allowedHosts };
}

export function hermesRuntimeNetworkPolicy(gatewayUrl: string, version?: string, allowedHostsCsv?: string) {
  let gateway: URL;
  try { gateway = new URL(gatewayUrl); } catch { throw new Error('MODEL_GATEWAY_INVALID'); }
  const policy = validateHermesNetworkPolicy({
    version: version ?? '',
    allowedHosts: (allowedHostsCsv ?? '').split(',').filter(Boolean),
  });
  if (!policy.allowedHosts.includes(normalizeHost(gateway.hostname))) {
    throw new Error('HERMES_MODEL_GATEWAY_NOT_ALLOWLISTED');
  }
  return policy;
}

function networkRules(policy: HermesNetworkPolicy) {
  return { allowOut: [...policy.allowedHosts], denyOut: ['0.0.0.0/0'] };
}

async function verifyPrivateNetwork(sandbox: E2BSandbox, policy: HermesNetworkPolicy) {
  const info = await sandbox.getInfo();
  const actualAllowed = new Set(info.network?.allowOut ?? []);
  const expectedAllowed = new Set(policy.allowedHosts);
  const allowedMatches = actualAllowed.size === expectedAllowed.size &&
    [...expectedAllowed].every(host => actualAllowed.has(host));
  if (!allowedMatches || !info.network?.denyOut?.includes('0.0.0.0/0') ||
      info.network.allowPublicTraffic !== false) {
    throw new Error('HERMES_NETWORK_POLICY_UNVERIFIED');
  }
  if (!sandbox.trafficAccessToken?.trim()) throw new Error('E2B_TRAFFIC_TOKEN_MISSING');
}

/** Reconnects only to machines whose private ingress is still verifiable. */
export async function connectHermesE2B(
  apiKey: string,
  sandboxId: string,
  policyInput: HermesNetworkPolicy,
  api: HermesE2BApi = defaultApi,
) {
  const policy = validateHermesNetworkPolicy(policyInput);
  const sandbox = await api.connect(sandboxId, { apiKey, timeoutMs: 120_000 });
  // The SDK update endpoint replaces the complete egress policy atomically.
  await sandbox.updateNetwork(networkRules(policy));
  await verifyPrivateNetwork(sandbox, policy);
  return sandbox;
}

/** A separate VM for each account; no provider credentials are put in its environment. */
export class HermesE2BFactory implements HermesMachineFactory {
  private readonly policy: HermesNetworkPolicy;

  constructor(
    private readonly apiKey: string,
    private readonly template = 'desktop',
    private readonly timeoutMs = 120_000,
    policy: HermesNetworkPolicy,
    private readonly api: HermesE2BApi = defaultApi,
  ) {
    if (!apiKey) throw new Error('E2B_API_KEY_MISSING');
    this.policy = validateHermesNetworkPolicy(policy);
  }

  async create(ownerId: string): Promise<HermesMachine> {
    z.uuid().parse(ownerId);
    const sandbox = await this.api.create(this.template, {
      apiKey: this.apiKey, timeoutMs: this.timeoutMs, secure: true,
      lifecycle: { onTimeout: { action: 'pause', keepMemory: false }, autoResume: false },
      network: { ...networkRules(this.policy), allowPublicTraffic: false },
      metadata: {
        application: 'bot-live-messenger', owner: ownerId, engine: 'hermes',
        networkPolicy: this.policy.version,
      },
    });
    try {
      await verifyPrivateNetwork(sandbox, this.policy);
    } catch (error) {
      await sandbox.kill();
      throw error;
    }
    return {
      id: sandbox.sandboxId,
      trafficAccessToken: sandbox.trafficAccessToken!,
      async write(path, contents) { await sandbox.files.write(path, contents, { user: 'root' }); },
      async run(command) {
        const result = await sandbox.commands.run(command, { user: 'root', timeoutMs: 240_000 });
        if (result.exitCode !== 0) throw new Error('HERMES_MACHINE_COMMAND_FAILED');
      },
      async start(command) {
        await sandbox.commands.run(command, { user: 'root', background: true, timeoutMs: 0 });
      },
      endpoint(port) { return `https://${sandbox.getHost(port)}`; },
      async destroy() { await sandbox.kill(); },
    };
  }
}
