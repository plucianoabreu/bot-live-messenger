import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const HERMES_REVISION = '233757037df1f03f9fe1cfddc097acd5ad7f7510';

/** Infrastructure boundary. The provider must create one isolated machine, not a shared process. */
export interface HermesMachine {
  id: string;
  write(path: string, contents: string): Promise<void>;
  run(command: string): Promise<void>;
  start(command: string): Promise<void>;
  endpoint(port: number): string;
  destroy(): Promise<void>;
}

export interface HermesMachineFactory {
  create(ownerId: string): Promise<HermesMachine>;
}

/** Build into a credential-free snapshot once, then create isolated account VMs from it. */
export async function installHermesImage(machine: HermesMachine) {
  await machine.run('mkdir -p /workspace/shared /workspace/exports /opt/blm-hermes-state');
  await machine.run('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv git ca-certificates');
  await machine.run('python3 -m venv /opt/blm-bootstrap && /opt/blm-bootstrap/bin/pip install uv==0.9.26');
  await machine.run(`git clone https://github.com/NousResearch/hermes-agent.git /opt/blm-hermes && git -C /opt/blm-hermes checkout --detach ${HERMES_REVISION}`);
  await machine.run('cd /opt/blm-hermes && /opt/blm-bootstrap/bin/uv sync --frozen --no-dev --extra messaging --python 3.11');
}

/** Call only while holding the account provisioning lease. Persist returned binding server-side. */
export async function provisionHermes(
  factory: HermesMachineFactory,
  ownerId: string,
  modelGateway: { url: string; scopedToken: string },
) {
  z.uuid().parse(ownerId);
  const gateway = new URL(modelGateway.url);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error('MODEL_GATEWAY_INVALID');
  }
  if (!modelGateway.scopedToken.trim()) throw new Error('MODEL_GATEWAY_TOKEN_MISSING');
  const machine = await factory.create(ownerId);
  const apiKey = randomBytes(32).toString('hex');
  try {
    await machine.run(`test "$(git -C /opt/blm-hermes rev-parse HEAD)" = '${HERMES_REVISION}'`);
    await machine.write('/opt/blm-hermes-state/config.yaml', [
      'model:', '  provider: openai', '  api_mode: chat_completions', '  streaming: false',
      'agent:', '  max_turns: 8', '  run_budget_seconds: 80',
      'platform_toolsets:', '  api_server: [terminal, file]',
      'terminal:', '  backend: local', '  cwd: /workspace/shared', '',
    ].join('\n'));
    // Only an account-scoped proxy token enters the runtime, never the provider or Supabase key.
    await machine.write('/opt/blm-hermes-state/launch.json', JSON.stringify({
      HERMES_HOME: '/opt/blm-hermes-state', API_SERVER_KEY: apiKey, API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: '8642',
      OPENAI_BASE_URL: gateway.toString(), OPENAI_API_KEY: modelGateway.scopedToken,
      TERMINAL_CWD: '/workspace/shared',
    }));
    await machine.run('chmod 600 /opt/blm-hermes-state/launch.json');
    await machine.write('/opt/blm-hermes-launch.py', [
      'import json, os',
      'with open("/opt/blm-hermes-state/launch.json", encoding="utf-8") as f:',
      '    os.environ.update(json.load(f))',
      'os.chdir("/workspace/shared")',
      'os.execv("/opt/blm-hermes/.venv/bin/python", ["/opt/blm-hermes/.venv/bin/python", "-m", "gateway.run"])',
      '',
    ].join('\n'));
    await machine.start('python3 /opt/blm-hermes-launch.py > /opt/blm-hermes-state/gateway.log 2>&1');
    // Check the local authenticated endpoint without printing the server key or response.
    await machine.write('/opt/blm-hermes-ready.py', [
      'import json, time, urllib.request',
      'with open("/opt/blm-hermes-state/launch.json") as f: key = json.load(f)["API_SERVER_KEY"]',
      'for attempt in range(45):',
      '    try:',
      '        req = urllib.request.Request("http://127.0.0.1:8642/v1/capabilities", headers={"Authorization": "Bearer " + key})',
      '        with urllib.request.urlopen(req, timeout=2) as response:',
      '            payload = json.load(response)',
      '        if response.status == 200: break',
      '    except Exception: time.sleep(1)',
      'else: raise SystemExit("HERMES_NOT_READY")',
      '',
    ].join('\n'));
    await machine.run('python3 /opt/blm-hermes-ready.py');
    return { ownerId, machineId: machine.id, baseUrl: machine.endpoint(8642), apiKey, revision: HERMES_REVISION };
  } catch {
    try { await machine.destroy(); } catch { throw new Error('HERMES_PROVISION_CLEANUP_REQUIRED'); }
    throw new Error('HERMES_PROVISION_FAILED');
  }
}
