import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Sandbox } from '@e2b/desktop';
import { HermesE2BFactory, connectHermesE2B } from '../src/server/execution/hermes-e2b';
import { hermesExecutionMayContinue, quiesceHermesRuntime } from '../src/server/execution/hermes-executor';
import { HermesProvisionError, provisionHermes } from '../src/server/execution/hermes-provision';

const MAX_SANDBOX_MS = 30 * 60 * 1000;
const policy = { version: 'hermes-runtime-live-proof-v1', allowedHosts: ['pypi.org'] } as const;
type LiveSandbox = Awaited<ReturnType<typeof Sandbox.create>>;

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`LIVE_PROOF_FAILED:${label}`);
}

function record(label: string, value: unknown) {
  console.log(JSON.stringify({ label, value }));
}

async function command(sandbox: LiveSandbox, text: string, user = 'root') {
  return sandbox.commands.run(text, { user, timeoutMs: 30_000 });
}

async function startLongTask(sandbox: LiveSandbox, label: string) {
  // E2B's command service starts a login shell for `user`; the service account
  // intentionally has nologin. Enter the account from the root control plane
  // instead, matching the gateway launcher's explicit privilege drop.
  const result = await command(
    sandbox,
    `runuser -u blm-hermes -- sh -c 'sleep 600 >/tmp/${label}.log 2>&1 & echo $!'`,
    'root',
  );
  const pid = Number(result.stdout.trim());
  check(Number.isInteger(pid) && pid > 1, `${label}_pid`);
  return pid;
}

async function taskState(sandbox: LiveSandbox, pid: number) {
  try {
    const result = await command(sandbox, `ps -p ${pid} -o stat=`, 'root');
    const state = result.stdout.trim();
    return state && !state.startsWith('Z') ? 'stopping' : 'cancelled';
  } catch { return 'cancelled'; }
}

async function proveStopBeforePause(sandbox: LiveSandbox, apiKey: string, signal: 'cancel' | 'kill-switch') {
  const pid = await startLongTask(sandbox, signal);
  const events: string[] = [];
  const run = { state: 'RUNNING', cancel_requested: signal === 'cancel', execution_version: 7 };
  check(!hermesExecutionMayContinue(run, signal !== 'kill-switch', 7), `${signal}_predicate`);
  await quiesceHermesRuntime({
    remoteRunId: `${signal}-run`, alreadyTerminal: false, maxPolls: 10,
    wait: () => new Promise(resolve => setTimeout(resolve, 100)),
    client: {
      async stop() {
        events.push('stop');
        await command(sandbox, `kill ${pid}`, 'root');
        return { state: 'stop_requested' };
      },
      async read() {
        const status = await taskState(sandbox, pid);
        events.push(`read:${status}`);
        return { run_id: `${signal}-run`, status };
      },
    },
    async pause() {
      events.push('pause');
      await Sandbox.pause(sandbox.sandboxId, { apiKey, keepMemory: false });
    },
    async release() { events.push('release'); },
  });
  check(events.includes('read:cancelled'), `${signal}_terminal_confirmed`);
  check(events.indexOf('read:cancelled') < events.indexOf('pause'), `${signal}_terminal_before_pause`);
  check(events.indexOf('pause') < events.indexOf('release'), `${signal}_pause_before_release`);
  record(`${signal}_ordering`, events);
}

async function main() {
  const apiKey = process.env.E2B_API_KEY;
  check(apiKey, 'api_key_present');
  const image = JSON.parse(await readFile('.local-setup/hermes-image.json', 'utf8')) as { snapshotId?: string };
  check(image.snapshotId, 'snapshot_id_present');

  let sandbox: LiveSandbox | undefined;
  let sandboxId: string | undefined;
  let startedAt = 0;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  let cleanupResult: boolean | 'already-destroyed' | 'failed' = 'already-destroyed';
  const api = {
    async create(template: string, options: Record<string, unknown>) {
      startedAt = Date.now();
      sandbox = await Sandbox.create(template, options);
      sandboxId = sandbox.sandboxId;
      record('sandbox_created', { idPrefix: sandboxId.slice(0, 8) });
      hardStop = setTimeout(() => {
        if (sandboxId) void Sandbox.kill(sandboxId, { apiKey }).catch(() => undefined);
      }, MAX_SANDBOX_MS);
      return sandbox;
    },
    async connect(id: string, options: Record<string, unknown>) {
      sandbox = await Sandbox.connect(id, options);
      return sandbox;
    },
  };

  try {
    const binding = await provisionHermes(
      new HermesE2BFactory(apiKey, image.snapshotId, MAX_SANDBOX_MS, policy, api),
      randomUUID(),
      { url: 'https://pypi.org/v1', scopedToken: randomBytes(32).toString('hex') },
    );
    check(sandbox, 'sandbox_created');
    const info = await sandbox.getInfo();
    const fullInfo = await Sandbox.getFullInfo(sandbox.sandboxId, { apiKey });
    record('sandbox_info', { cpuCount: fullInfo.cpuCount, memoryMB: fullInfo.memoryMB, network: info.network });
    check(JSON.stringify(info.network?.allowOut) === JSON.stringify(['pypi.org']), 'exact_allowlist');
    check(info.network?.denyOut?.includes('0.0.0.0/0'), 'deny_all_egress');
    check(info.network?.allowPublicTraffic === false, 'private_ingress');

    const applicationHeaders = { Authorization: `Bearer ${binding.apiKey}` };
    const withoutToken = await fetch(`${binding.baseUrl}/v1/capabilities`, { headers: applicationHeaders });
    record('ingress_without_traffic_token', withoutToken.status);
    check(withoutToken.status === 403, 'ingress_without_token_403');
    const privateHeaders = { ...applicationHeaders, 'E2B-Traffic-Access-Token': binding.trafficAccessToken };
    const withToken = await fetch(`${binding.baseUrl}/v1/capabilities`, { headers: privateHeaders });
    record('ingress_with_traffic_token', withToken.status);
    check(withToken.status === 200, 'ingress_with_token_200');

    const toolsetsResponse = await fetch(`${binding.baseUrl}/v1/toolsets`, { headers: privateHeaders });
    const toolsets = await toolsetsResponse.json() as { data?: Array<{ name?: string; enabled?: boolean }> };
    const enabled = toolsets.data?.filter(item => item.enabled).map(item => item.name).sort() ?? [];
    record('enabled_toolsets', enabled);
    check(JSON.stringify(enabled) === JSON.stringify(['file']), 'file_only_toolset');

    const process = await command(sandbox, "ps -eo uid=,args= | grep '[g]ateway.run'", 'root');
    const uid = Number(process.stdout.trim().split(/\s+/)[0]);
    record('gateway_uid', uid);
    check(Number.isInteger(uid) && uid > 0, 'gateway_non_root');
    const permissions = await command(sandbox,
      "runuser -u blm-hermes -- sh -lc 'test ! -r /opt/blm-hermes-secrets/launch.json && touch /workspace/shared/live-proof && ! touch /opt/blm-hermes-secrets/live-proof'",
      'root');
    check(permissions.exitCode === 0, 'secret_and_write_confinement');
    record('secret_unreadable_and_write_confined', true);

    const allowed = await command(sandbox,
      "python3 -c \"import urllib.request; print(urllib.request.urlopen('https://pypi.org', timeout=10).status)\"", 'root');
    check(allowed.stdout.includes('200'), 'allowlisted_egress');
    record('allowlisted_egress', 200);
    let denied = false;
    try {
      const result = await command(sandbox,
        "python3 -c \"import urllib.request; urllib.request.urlopen('https://example.com', timeout=10)\"", 'root');
      denied = result.exitCode !== 0;
    } catch { denied = true; }
    check(denied, 'unlisted_egress_denied');
    record('unlisted_egress_denied', true);

    await proveStopBeforePause(sandbox, apiKey, 'cancel');
    sandbox = await connectHermesE2B(apiKey, binding.machineId, policy, api) as unknown as LiveSandbox;
    const resumed = sandbox;
    await resumed.commands.run('umask 077 && python3 /opt/blm-hermes-launch.py > /opt/blm-hermes-state/gateway.log 2>&1', {
      user: 'root', background: true, timeoutMs: 0,
    });
    await resumed.commands.run('python3 /opt/blm-hermes-ready.py', { user: 'root', timeoutMs: 50_000 });
    await proveStopBeforePause(resumed, apiKey, 'kill-switch');
    record('live_proof', 'PASS');
  } catch (error) {
    if (error instanceof HermesProvisionError) {
      record('provision_failure', { stage: error.stage, diagnostic: error.diagnostic ?? 'unavailable' });
    }
    throw error;
  } finally {
    if (hardStop) clearTimeout(hardStop);
    if (sandboxId) {
      try {
        const killed = await Sandbox.kill(sandboxId, { apiKey });
        cleanupResult = killed ? true : 'already-destroyed';
      } catch { cleanupResult = 'failed'; }
    }
    record('cleanup', {
      result: cleanupResult,
      activeSecondsUpperBound: startedAt ? Math.ceil((Date.now() - startedAt) / 1000) : 0,
    });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'LIVE_PROOF_FAILED');
  process.exitCode = 1;
});
