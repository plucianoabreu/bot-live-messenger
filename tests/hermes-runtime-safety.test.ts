import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '@e2b/desktop';
import {
  connectHermesE2B,
  HermesE2BFactory,
  hermesRuntimeNetworkPolicy,
  type HermesE2BApi,
} from '../src/server/execution/hermes-e2b';
import {
  HermesProvisionError,
  installHermesImage,
  provisionHermes,
  sanitizeHermesDiagnostic,
  type HermesMachine,
} from '../src/server/execution/hermes-provision';

const ownerId = '11111111-1111-4111-8111-111111111111';

test('runtime sandbox denies non-allowlisted egress and public ingress', async () => {
  const originalCreate = Sandbox.create;
  let received: Record<string, unknown> | undefined;
  Object.defineProperty(Sandbox, 'create', {
    configurable: true,
    value: async (_template: string, options: Record<string, unknown>) => {
      received = options;
      return {
        sandboxId: 'sandbox-id',
        trafficAccessToken: 'traffic-token',
        files: { write: async () => undefined },
        commands: { run: async () => ({ exitCode: 0 }) },
        getHost: () => '8642-sandbox-id.e2b.app',
        getInfo: async () => ({ network: {
          allowOut: ['gateway.example.com', 'docs.example.com'],
          denyOut: ['0.0.0.0/0'], allowPublicTraffic: false,
        } }),
        kill: async () => true,
      };
    },
  });
  try {
    const factory = new HermesE2BFactory('api-key', 'template', 120_000, {
      version: 'runtime-v1',
      allowedHosts: ['gateway.example.com', 'docs.example.com'],
    });
    const machine = await factory.create(ownerId);
    assert.equal(machine.trafficAccessToken, 'traffic-token');
    assert.deepEqual(received?.network, {
      allowOut: ['gateway.example.com', 'docs.example.com'],
      denyOut: ['0.0.0.0/0'],
      allowPublicTraffic: false,
    });
    assert.equal(received?.secure, true);
  } finally {
    Object.defineProperty(Sandbox, 'create', { configurable: true, value: originalCreate });
  }
});

test('runtime sandbox rejects an unversioned or empty network policy before provider access', async () => {
  assert.throws(
    () => new HermesE2BFactory('api-key', 'template', 120_000, { version: '', allowedHosts: ['gateway.example.com'] }),
    /HERMES_NETWORK_POLICY_UNVERIFIED/,
  );
  assert.throws(
    () => new HermesE2BFactory('api-key', 'template', 120_000, { version: 'runtime-v1', allowedHosts: [] }),
    /HERMES_NETWORK_DESTINATIONS_EMPTY/,
  );
  assert.throws(
    () => hermesRuntimeNetworkPolicy('https://gateway.example.com/api', 'runtime-v1', 'docs.example.com'),
    /HERMES_MODEL_GATEWAY_NOT_ALLOWLISTED/,
  );
  assert.throws(
    () => hermesRuntimeNetworkPolicy('https://gateway.example.com/api', 'runtime-v1', '127.0.0.1,gateway.example.com'),
    /HERMES_NETWORK_DESTINATION_INVALID/,
  );
});

test('resume reasserts egress and rejects a legacy machine with public ingress', async () => {
  const updates: unknown[] = [];
  const sandbox = {
    sandboxId: 'sandbox-id', trafficAccessToken: 'traffic-token',
    files: { write: async () => undefined }, commands: { run: async () => ({ exitCode: 0 }) },
    getHost: () => '8642-sandbox-id.e2b.app', kill: async () => true,
    async updateNetwork(network: unknown) { updates.push(network); },
    async getInfo() { return { network: {
      allowOut: ['gateway.example.com'], denyOut: ['0.0.0.0/0'], allowPublicTraffic: true,
    } }; },
  };
  const api = { async connect() { return sandbox; } } as unknown as HermesE2BApi;
  await assert.rejects(
    connectHermesE2B('api-key', 'sandbox-id', { version: 'runtime-v1', allowedHosts: ['gateway.example.com'] }, api),
    /HERMES_NETWORK_POLICY_UNVERIFIED/,
  );
  assert.deepEqual(updates, [{ allowOut: ['gateway.example.com'], denyOut: ['0.0.0.0/0'] }]);
});

test('provisioning exposes only file tools and drops runtime privileges before exec', async () => {
  const commands: string[] = [];
  const starts: string[] = [];
  const writes = new Map<string, string>();
  const machine: HermesMachine = {
    id: 'sandbox-id',
    trafficAccessToken: 'traffic-token',
    async write(path, contents) { writes.set(path, contents); },
    async run(command) { commands.push(command); },
    async start(command) { starts.push(command); },
    endpoint() { return 'https://8642-sandbox-id.e2b.app'; },
    async destroy() { assert.fail('valid provisioning must not destroy the machine'); },
  };

  await installHermesImage(machine);
  await provisionHermes({ async create() { return machine; } }, ownerId, {
    url: 'https://gateway.example.com/api/hermes/v1/chat/completions',
    scopedToken: 'scoped-model-token',
  });

  const allCommands = commands.join('\n');
  assert.match(allCommands, /useradd/);
  assert.match(allCommands, /-m 700 \/opt\/blm-hermes-secrets/);
  assert.match(allCommands, /install -d -o root -g root -m 755 \/opt\/blm-python/);
  assert.match(allCommands, /UV_PYTHON_INSTALL_DIR=\/opt\/blm-python .*uv python install 3\.11 --managed-python/);
  assert.match(allCommands, /uv python find 3\.11 --managed-python/);
  assert.match(allCommands, /uv sync .*--python "\$managed_python"/);
  assert.match(allCommands, /chmod -R a\+rX \/opt\/blm-hermes \/opt\/blm-bootstrap \/opt\/blm-python/);
  assert.match(allCommands, /chmod -R go-w \/opt\/blm-hermes \/opt\/blm-bootstrap \/opt\/blm-python/);
  assert.match(allCommands, /readlink -f \/opt\/blm-hermes\/\.venv\/bin\/python/);
  assert.match(allCommands, /\/opt\/blm-python\/\*/);
  assert.match(allCommands, /runuser -u blm-hermes -- \/opt\/blm-hermes\/\.venv\/bin\/python/);
  assert.match(allCommands, /test ! -w \/opt\/blm-python/);
  assert.ok(writes.has('/opt/blm-hermes-secrets/launch.json'));
  assert.ok(!writes.has('/opt/blm-hermes-state/launch.json'));
  assert.match(writes.get('/opt/blm-hermes-state/config.yaml') ?? '', /api_server: \[file\]/);
  assert.doesNotMatch(writes.get('/opt/blm-hermes-state/config.yaml') ?? '', /terminal/);
  const launcher = writes.get('/opt/blm-hermes-launch.py') ?? '';
  assert.match(launcher, /os\.setgroups\(\[\]\)/);
  assert.match(launcher, /os\.setgid/);
  assert.match(launcher, /os\.setuid/);
  const launchConfig = JSON.parse(writes.get('/opt/blm-hermes-secrets/launch.json') ?? '{}');
  assert.equal(launchConfig.HERMES_WRITE_SAFE_ROOT, '/workspace');
  assert.equal(launchConfig.HOME, '/workspace');
  const readiness = writes.get('/opt/blm-hermes-ready.py') ?? '';
  assert.match(readiness, /\/v1\/toolsets/);
  assert.match(readiness, /enabled != \{"file"\}/);
  assert.deepEqual(starts, ['umask 077 && python3 /opt/blm-hermes-launch.py > /opt/blm-hermes-state/gateway.log 2>&1']);
});

test('provisioning failure exposes a safe stage and separately sanitized gateway diagnostic', async () => {
  const secret = 'super-secret-model-token-1234567890';
  let destroyed = false;
  const machine: HermesMachine = {
    id: 'sandbox-id', trafficAccessToken: 'traffic-token',
    async write() {},
    async run(command) {
      if (command === 'python3 /opt/blm-hermes-ready.py') throw new Error('HERMES_MACHINE_COMMAND_FAILED');
    },
    async start() {},
    endpoint() { return 'https://8642-sandbox-id.e2b.app'; },
    async diagnose() {
      return `OPENAI_API_KEY=${secret}\nAuthorization: Bearer ${secret}\nRuntimeError: invalid config`;
    },
    async destroy() { destroyed = true; },
  };

  await assert.rejects(
    provisionHermes({ async create() { return machine; } }, ownerId, {
      url: 'https://gateway.example.com/v1', scopedToken: secret,
    }),
    error => {
      assert.ok(error instanceof HermesProvisionError);
      assert.equal(error.message, 'HERMES_PROVISION_FAILED:readiness');
      assert.equal(error.stage, 'readiness');
      assert.match(error.diagnostic ?? '', /RuntimeError: invalid config/);
      assert.doesNotMatch(error.diagnostic ?? '', new RegExp(secret));
      assert.match(error.diagnostic ?? '', /\[REDACTED\]/);
      return true;
    },
  );
  assert.equal(destroyed, true);
});

test('gateway diagnostic sanitizer strips credentials and control characters and bounds output', () => {
  const diagnostic = sanitizeHermesDiagnostic(
    `api_key = abcdefghijklmnopqrstuvwxyz123456\u0000\nBearer abcdefghijklmnopqrstuvwxyz123456\n${'x'.repeat(8_000)}`,
  );
  assert.doesNotMatch(diagnostic, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(diagnostic, /\u0000/);
  assert.ok(diagnostic.length <= 4_000);
});

test('runtime sandbox rejects provider success without a private ingress token', async () => {
  const originalCreate = Sandbox.create;
  let killed = false;
  Object.defineProperty(Sandbox, 'create', {
    configurable: true,
    value: async () => ({
      sandboxId: 'sandbox-id', trafficAccessToken: undefined,
      files: { write: async () => undefined }, commands: { run: async () => ({ exitCode: 0 }) },
      getHost: () => '8642-sandbox-id.e2b.app',
      getInfo: async () => ({ network: { allowOut: ['gateway.example.com'], denyOut: ['0.0.0.0/0'], allowPublicTraffic: false } }),
      kill: async () => { killed = true; return true; },
    }),
  });
  try {
    const factory = new HermesE2BFactory('api-key', 'template', 120_000, {
      version: 'runtime-v1', allowedHosts: ['gateway.example.com'],
    });
    await assert.rejects(factory.create(ownerId), /E2B_TRAFFIC_TOKEN_MISSING/);
    assert.equal(killed, true);
  } finally {
    Object.defineProperty(Sandbox, 'create', { configurable: true, value: originalCreate });
  }
});

test('quiescing waits for Hermes terminal state before pause and release', async () => {
  const module = await import('../src/server/execution/hermes-executor');
  const quiesce = (module as Record<string, unknown>).quiesceHermesRuntime;
  assert.equal(typeof quiesce, 'function');
  const events: string[] = [];
  const states = ['stopping', 'cancelled'];
  await (quiesce as (input: unknown) => Promise<void>)({
    client: {
      async stop() { events.push('stop'); return { state: 'stop_requested' }; },
      async read() { const state = states.shift() ?? 'cancelled'; events.push(`read:${state}`); return { run_id: 'remote', status: state }; },
    },
    remoteRunId: 'remote',
    alreadyTerminal: false,
    async wait() { events.push('wait'); },
    async pause() { events.push('pause'); },
    async release() { events.push('release'); },
  });
  assert.deepEqual(events, ['stop', 'read:stopping', 'wait', 'read:cancelled', 'pause', 'release']);
});

test('quiescing retains the fence when Hermes termination cannot be confirmed', async () => {
  const module = await import('../src/server/execution/hermes-executor');
  const quiesce = (module as Record<string, unknown>).quiesceHermesRuntime;
  assert.equal(typeof quiesce, 'function');
  const events: string[] = [];
  await assert.rejects((quiesce as (input: unknown) => Promise<void>)({
    client: {
      async stop() { events.push('stop'); throw new Error('transport failed'); },
      async read() { assert.fail('must not read after stop transport failure'); },
    },
    remoteRunId: 'remote', alreadyTerminal: false,
    async wait() { assert.fail('must not wait'); },
    async pause() { events.push('pause'); },
    async release() { events.push('release'); },
  }), /HERMES_STOP_UNCONFIRMED/);
  assert.deepEqual(events, ['stop']);
});

test('quiescing does not pause or release while Hermes stays nonterminal', async () => {
  const module = await import('../src/server/execution/hermes-executor');
  const quiesce = (module as Record<string, unknown>).quiesceHermesRuntime;
  assert.equal(typeof quiesce, 'function');
  const events: string[] = [];
  await assert.rejects((quiesce as (input: unknown) => Promise<void>)({
    client: {
      async stop() { events.push('stop'); return { state: 'stop_requested' }; },
      async read() { events.push('read'); return { run_id: 'remote', status: 'stopping' }; },
    },
    remoteRunId: 'remote', alreadyTerminal: false, maxPolls: 2,
    async wait() { events.push('wait'); },
    async pause() { events.push('pause'); },
    async release() { events.push('release'); },
  }), /HERMES_STOP_UNCONFIRMED/);
  assert.deepEqual(events, ['stop', 'read', 'wait', 'read']);
});

test('kill switch is part of the active-run authorization predicate', async () => {
  const module = await import('../src/server/execution/hermes-executor');
  const mayContinue = (module as Record<string, unknown>).hermesExecutionMayContinue;
  assert.equal(typeof mayContinue, 'function');
  const running = { state: 'RUNNING', cancel_requested: false, execution_version: 7 };
  assert.equal((mayContinue as (run: unknown, enabled: boolean, version: number) => boolean)(running, true, 7), true);
  assert.equal((mayContinue as (run: unknown, enabled: boolean, version: number) => boolean)(running, false, 7), false);
  assert.equal((mayContinue as (run: unknown, enabled: boolean, version: number) => boolean)({ ...running, cancel_requested: true }, true, 7), false);
});
