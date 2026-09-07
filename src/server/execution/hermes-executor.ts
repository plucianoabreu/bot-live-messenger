import { randomBytes, createHash } from 'node:crypto';
import { Sandbox } from '@e2b/desktop';
import { setTimeout as delay } from 'node:timers/promises';
import { workerDatabase } from './database';
import { HermesClient } from './hermes';
import { HermesE2BFactory } from './hermes-e2b';
import { provisionHermes } from './hermes-provision';

export async function executeHermes(input: {
  runId: string; version: number; ownerId: string; botId: string;
  instructions: string; message: string; model: string; signal: AbortSignal;
}) {
  const key = process.env.E2B_API_KEY;
  const template = process.env.HERMES_TEMPLATE_ID;
  const gateway = process.env.HERMES_MODEL_GATEWAY_URL;
  if (!key || !template || !gateway) throw new Error('HERMES_NOT_CONFIGURED');
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
      const created = await provisionHermes(new HermesE2BFactory(key, template), input.ownerId, { url: gateway, scopedToken: token });
      machineId = created.machineId;
      const { error: saveError } = await db.from('hermes_workspaces').update({
        machine_id: machineId, base_url: created.baseUrl, api_key: created.apiKey, revision: created.revision,
      }).eq('user_id', input.ownerId).eq('active_run', input.runId);
      if (saveError) throw new Error('HERMES_BINDING_SAVE_FAILED');
      client = new HermesClient(created);
    } else {
      const sandbox = await Sandbox.connect(machineId, { apiKey: key, timeoutMs: 120_000 });
      await sandbox.commands.run('python3 /opt/blm-hermes-launch.py > /opt/blm-hermes-state/gateway.log 2>&1', {
        user: 'root', background: true, timeoutMs: 0,
      });
      await sandbox.commands.run('python3 /opt/blm-hermes-ready.py', { user: 'root', timeoutMs: 50_000 });
      client = new HermesClient({ ownerId: input.ownerId, baseUrl: binding.base_url, apiKey: binding.api_key });
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
        return { text: state.output, providerResponseId: remote, usage: state.usage };
      }
      await delay(1000, undefined, { signal: input.signal });
    }
  } finally {
    if (!terminal && remote && client) {
      try { await client.stop(remote, AbortSignal.timeout(5000)); } catch { /* Retain the fence. */ }
    }
    if (machineId) {
      // Pause must succeed before another bot may acquire this computer.
      await Sandbox.pause(machineId, { apiKey: key, keepMemory: false });
    }
    // A filesystem-only pause discards every process, including unfinished tools.
    // The next run boots a fresh gateway while retaining files and session storage.
    if (machineId) {
      const { error: releaseError } = await db.from('hermes_workspaces').update({ active_run: null, remote_run: null })
        .eq('user_id', input.ownerId).eq('active_run', input.runId);
      if (releaseError) throw new Error('HERMES_RELEASE_FAILED');
    }
  }
}
