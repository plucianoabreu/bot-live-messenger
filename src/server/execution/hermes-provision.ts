import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const HERMES_REVISION = '233757037df1f03f9fe1cfddc097acd5ad7f7510';

export type HermesProvisionStage =
  | 'revision' | 'identity' | 'config' | 'credentials' | 'launcher' | 'start' | 'readiness';

export class HermesProvisionError extends Error {
  readonly name = 'HermesProvisionError';

  constructor(
    readonly stage: HermesProvisionStage,
    readonly diagnostic?: string,
  ) {
    super(`HERMES_PROVISION_FAILED:${stage}`);
  }
}

/** Removes likely credentials before a diagnostic leaves the provider boundary. */
export function sanitizeHermesDiagnostic(input: string) {
  return input
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9._~-]{32,}/g, '[REDACTED]')
    .slice(-4_000);
}

/** Infrastructure boundary. The provider must create one isolated machine, not a shared process. */
export interface HermesMachine {
  id: string;
  trafficAccessToken: string;
  write(path: string, contents: string): Promise<void>;
  run(command: string): Promise<void>;
  start(command: string): Promise<void>;
  diagnose?(): Promise<string>;
  endpoint(port: number): string;
  destroy(): Promise<void>;
}

export interface HermesMachineFactory {
  create(ownerId: string): Promise<HermesMachine>;
}

/** Build into a credential-free snapshot once, then create isolated account VMs from it. */
export async function installHermesImage(machine: HermesMachine) {
  await machine.run("id -u blm-hermes >/dev/null 2>&1 || useradd --system --home-dir /workspace --shell /usr/sbin/nologin blm-hermes");
  await machine.run('install -d -o blm-hermes -g blm-hermes -m 700 /workspace /workspace/shared /workspace/exports /opt/blm-hermes-state');
  await machine.run('install -d -o root -g root -m 700 /opt/blm-hermes-secrets');
  await machine.run('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv git ca-certificates');
  await machine.run('python3 -m venv /opt/blm-bootstrap && /opt/blm-bootstrap/bin/pip install uv==0.9.26');
  await machine.run(`git clone https://github.com/NousResearch/hermes-agent.git /opt/blm-hermes && git -C /opt/blm-hermes checkout --detach ${HERMES_REVISION}`);
  await machine.run('cd /opt/blm-hermes && /opt/blm-bootstrap/bin/uv sync --frozen --no-dev --extra messaging --python 3.11');
  await machine.run('chown -R root:root /opt/blm-hermes /opt/blm-bootstrap && chmod -R go-w /opt/blm-hermes /opt/blm-bootstrap');
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
  let stage: HermesProvisionStage = 'revision';
  try {
    await machine.run(`test "$(git -C /opt/blm-hermes rev-parse HEAD)" = '${HERMES_REVISION}'`);
    stage = 'identity';
    await machine.run('test "$(id -u blm-hermes)" -ne 0 && install -d -o root -g root -m 700 /opt/blm-hermes-secrets');
    stage = 'config';
    await machine.write('/opt/blm-hermes-state/config.yaml', [
      'model:', '  provider: openai-api', '  api_mode: chat_completions', '  streaming: false',
      'agent:', '  max_turns: 8', '  run_budget_seconds: 80',
      // Arbitrary shell remains disabled: Hermes local terminal commands share the
      // gateway OS identity and therefore are not a privilege boundary.
      'platform_toolsets:', '  api_server: [file]', '',
    ].join('\n'));
    // Only an account-scoped proxy token enters the runtime, never the provider or Supabase key.
    stage = 'credentials';
    await machine.write('/opt/blm-hermes-secrets/launch.json', JSON.stringify({
      HERMES_HOME: '/opt/blm-hermes-state', API_SERVER_KEY: apiKey, API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: '8642',
      OPENAI_BASE_URL: gateway.toString(), OPENAI_API_KEY: modelGateway.scopedToken,
      TERMINAL_CWD: '/workspace/shared', HERMES_WRITE_SAFE_ROOT: '/workspace', HOME: '/workspace',
    }));
    await machine.run('chown root:root /opt/blm-hermes-secrets/launch.json && chmod 600 /opt/blm-hermes-secrets/launch.json');
    stage = 'launcher';
    await machine.write('/opt/blm-hermes-launch.py', [
      'import json, os, pwd',
      'with open("/opt/blm-hermes-secrets/launch.json", encoding="utf-8") as f:',
      '    os.environ.update(json.load(f))',
      'identity = pwd.getpwnam("blm-hermes")',
      'os.chdir("/workspace/shared")',
      'os.setgroups([])',
      'os.setgid(identity.pw_gid)',
      'os.setuid(identity.pw_uid)',
      'os.umask(0o077)',
      'os.execv("/opt/blm-hermes/.venv/bin/python", ["/opt/blm-hermes/.venv/bin/python", "-m", "gateway.run"])',
      '',
    ].join('\n'));
    await machine.run('chown root:root /opt/blm-hermes-launch.py && chmod 700 /opt/blm-hermes-launch.py');
    stage = 'start';
    await machine.start('umask 077 && python3 /opt/blm-hermes-launch.py > /opt/blm-hermes-state/gateway.log 2>&1');
    // Check the local authenticated endpoint without printing the server key or response.
    stage = 'readiness';
    await machine.write('/opt/blm-hermes-ready.py', [
      'import json, time, urllib.request',
      'with open("/opt/blm-hermes-secrets/launch.json") as f: key = json.load(f)["API_SERVER_KEY"]',
      'for attempt in range(45):',
      '    try:',
      '        payloads = {}',
      '        for path in ("/v1/capabilities", "/v1/toolsets"):',
      '            req = urllib.request.Request("http://127.0.0.1:8642" + path, headers={"Authorization": "Bearer " + key})',
      '            with urllib.request.urlopen(req, timeout=2) as response:',
      '                payloads[path] = json.load(response)',
      '            if response.status != 200: raise RuntimeError("HERMES_NOT_READY")',
      '        enabled = {item.get("name") for item in payloads["/v1/toolsets"].get("data", []) if item.get("enabled")}',
      '        if enabled != {"file"}: raise RuntimeError("HERMES_TOOL_POLICY_INVALID")',
      '        break',
      '    except Exception: time.sleep(1)',
      'else: raise SystemExit("HERMES_NOT_READY")',
      '',
    ].join('\n'));
    await machine.run('python3 /opt/blm-hermes-ready.py');
    return {
      ownerId, machineId: machine.id, baseUrl: machine.endpoint(8642), apiKey,
      trafficAccessToken: machine.trafficAccessToken, revision: HERMES_REVISION,
    };
  } catch {
    let diagnostic: string | undefined;
    try {
      const rawDiagnostic = await machine.diagnose?.();
      diagnostic = rawDiagnostic ? sanitizeHermesDiagnostic(rawDiagnostic) : undefined;
    } catch { /* diagnostics must not block cleanup */ }
    try { await machine.destroy(); } catch { throw new Error('HERMES_PROVISION_CLEANUP_REQUIRED'); }
    throw new HermesProvisionError(stage, diagnostic);
  }
}
