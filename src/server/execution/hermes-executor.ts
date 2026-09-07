import { randomBytes, createHash } from 'node:crypto';
import { Sandbox } from '@e2b/desktop';
import { setTimeout as delay } from 'node:timers/promises';
import { workerDatabase } from './database';
import { HermesClient } from './hermes';
import { connectHermesE2B, HermesE2BFactory, hermesRuntimeNetworkPolicy } from './hermes-e2b';
import { provisionHermes } from './hermes-provision';
import { exportHermesArtifact } from '../computer/hermes-artifacts';
import { databaseHermesArtifactAuthorizer, databaseHermesArtifactRepository, privateArtifactStore } from '../computer/database';
import { defaultWorkspacePolicy } from '../computer/policy';

const TERMINAL_HERMES_STATES = new Set(['completed', 'failed', 'cancelled']);

export function hermesExecutionMayContinue(
  run: { state?: string; cancel_requested?: boolean; execution_version?: number } | null,
  runtimeEnabled: boolean,
  version: number,
) {
  return runtimeEnabled && run?.state === 'RUNNING' && !run.cancel_requested && run.execution_version === version;
}

export async function quiesceHermesRuntime(input: {
  client?: Pick<HermesClient, 'stop' | 'read'>;
  remoteRunId?: string;
  alreadyTerminal: boolean;
  maxPolls?: number;
  wait?: () => Promise<void>;
  pause(): Promise<void>;
  release(): Promise<void>;
}) {
  if (!input.alreadyTerminal && input.remoteRunId) {
    if (!input.client) throw new Error('HERMES_STOP_UNCONFIRMED');
    try {
      await input.client.stop(input.remoteRunId, AbortSignal.timeout(5_000));
    } catch {
      throw new Error('HERMES_STOP_UNCONFIRMED');
    }
    const maxPolls = input.maxPolls ?? 10;
    let stopped = false;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      let state;
      try {
        state = await input.client.read(input.remoteRunId, AbortSignal.timeout(3_000));
      } catch {
        throw new Error('HERMES_STOP_UNCONFIRMED');
      }
      if (TERMINAL_HERMES_STATES.has(state.status)) { stopped = true; break; }
      if (attempt + 1 < maxPolls) await (input.wait ?? (() => delay(1_000)))();
    }
    if (!stopped) throw new Error('HERMES_STOP_UNCONFIRMED');
  }
  await input.pause();
  await input.release();
}

export async function executeHermes(input: {
  runId: string; version: number; ownerId: string; botId: string;
  instructions: string; message: string; model: string; signal: AbortSignal;
  exportPath?: string;
}) {
  const key = process.env.E2B_API_KEY;
  const template = process.env.HERMES_TEMPLATE_ID;
  const gateway = process.env.HERMES_MODEL_GATEWAY_URL;
  if (!key || !template || !gateway) throw new Error('HERMES_NOT_CONFIGURED');
  const networkPolicy = hermesRuntimeNetworkPolicy(
    gateway,
    process.env.E2B_NETWORK_POLICY_VERSION,
    process.env.E2B_ALLOWED_HOSTS,
  );
  const db = workerDatabase();
  const token = randomBytes(32).toString('hex');
  const { data: binding, error } = await db.rpc('claim_hermes_workspace', {
    p_run_id: input.runId, p_version: input.version,
    p_proxy_hash: createHash('sha256').update(token).digest('hex'),
  });
  if (error || !binding || binding.user_id !== input.ownerId) throw new Error('HERMES_WORKSPACE_UNAVAILABLE');
  let machineId: string | undefined = binding.machine_id;
  let client: HermesClient | undefined;
  let remote: string | undefined;
  let terminal = false;
  try {
    if (!machineId) {
      const created = await provisionHermes(
        new HermesE2BFactory(key, template, 120_000, networkPolicy),
        input.ownerId,
        { url: gateway, scopedToken: token },
      );
      machineId = created.machineId;
      const { error: saveError } = await db.from('hermes_workspaces').update({
        machine_id: machineId, base_url: created.baseUrl, api_key: created.apiKey, revision: created.revision,
      }).eq('user_id', input.ownerId).eq('active_run', input.runId);
      if (saveError) throw new Error('HERMES_BINDING_SAVE_FAILED');
      client = new HermesClient(created);
    } else {
      const sandbox = await connectHermesE2B(key, machineId, networkPolicy);
      await sandbox.commands.run('umask 077 && python3 /opt/blm-hermes-launch.py > /opt/blm-hermes-state/gateway.log 2>&1', {
        user: 'root', background: true, timeoutMs: 0,
      });
      await sandbox.commands.run('python3 /opt/blm-hermes-ready.py', { user: 'root', timeoutMs: 50_000 });
      client = new HermesClient({
        ownerId: input.ownerId,
        baseUrl: binding.base_url,
        apiKey: binding.api_key,
        trafficAccessToken: sandbox.trafficAccessToken!,
      });
    }
    const started = await client.start(input, input.signal);
    remote = started.runId;
    const { error: remoteError } = await db.from('hermes_workspaces').update({ remote_run: remote })
      .eq('user_id', input.ownerId).eq('active_run', input.runId);
    if (remoteError) throw new Error('HERMES_RUN_SAVE_FAILED');
    for (;;) {
      const state = await client.read(remote, input.signal);
      if (['completed', 'failed', 'cancelled'].includes(state.status)) {
        terminal = true;
        if (state.status !== 'completed' || !state.output?.trim() || !state.usage) throw new Error('HERMES_RUN_FAILED');
        if (input.exportPath) {
          const exportDb = workerDatabase();
          const bucket = process.env.ARTIFACT_BUCKET;
          if (!bucket) throw new Error('ARTIFACT_STORE_NOT_CONFIGURED');
          const sandbox = await Sandbox.connect(machineId!, { apiKey: key, timeoutMs: 120_000 });
          await exportHermesArtifact({
            ownerId: input.ownerId, runId: input.runId, executionVersion: input.version,
            finalOutputKey: remote, relativePath: input.exportPath, policy: defaultWorkspacePolicy,
            authorizer: databaseHermesArtifactAuthorizer(exportDb),
            reader: { readExport: async request => {
              const command = `set -eu; test ! -L ${JSON.stringify(request.path)}; test -f ${JSON.stringify(request.path)}; realpath --no-symlinks ${JSON.stringify(request.path)} | grep -Fx ${JSON.stringify(request.path)} >/dev/null; size=$(wc -c < ${JSON.stringify(request.path)}); test "$size" -le ${request.maxBytes}; printf '%s' "$size"; base64 -w0 ${JSON.stringify(request.path)}`;
              const result = await sandbox.commands.run(command, { user: 'root', timeoutMs: 30_000 });
              const match = /^(\d+)([A-Za-z0-9+/=]+)$/.exec(result.stdout.trim());
              if (!match) throw new Error('ARTIFACT_READ_FAILED');
              return { canonicalPath: request.path, bytes: Buffer.from(match[2], 'base64'), mimeType: 'application/octet-stream', symlinkFree: true };
            } },
            store: privateArtifactStore(bucket, exportDb), repository: databaseHermesArtifactRepository(exportDb),
          });
        }
        return { text: state.output, providerResponseId: remote, usage: state.usage };
      }
      await delay(1000, undefined, { signal: input.signal });
    }
  } finally {
    if (machineId) {
      await quiesceHermesRuntime({
        client, remoteRunId: remote, alreadyTerminal: terminal,
        async pause() {
          // A filesystem-only pause discards the stopped gateway process while
          // preserving user files and session storage.
          await Sandbox.pause(machineId!, { apiKey: key, keepMemory: false });
        },
        async release() {
          const { error: releaseError } = await db.from('hermes_workspaces').update({ active_run: null, remote_run: null })
            .eq('user_id', input.ownerId).eq('active_run', input.runId);
          if (releaseError) throw new Error('HERMES_RELEASE_FAILED');
        },
      });
    }
  }
}
