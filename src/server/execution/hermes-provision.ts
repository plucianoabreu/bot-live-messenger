import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  HERMES_EXPORT_HELPER_PATH,
  hermesExportHelperSource,
} from './hermes-export-reader';
import {
  HERMES_LAUNCH_COMMAND,
  HERMES_LAUNCH_PATH,
  hermesLaunchConfiguration,
} from './hermes-launch-config';

export const HERMES_REVISION = '233757037df1f03f9fe1cfddc097acd5ad7f7510';

export type HermesProvisionStage =
  | 'network' | 'revision' | 'identity' | 'config' | 'credentials' | 'launcher' | 'start' | 'readiness' | 'binding';

export class HermesProvisionError extends Error {
  readonly name = 'HermesProvisionError';

  constructor(
    readonly stage: HermesProvisionStage,
    readonly diagnostic?: string,
    readonly machineId?: string,
    readonly cleanupConfirmed = false,
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
  await machine.run('install -d -o root -g root -m 700 /opt/blm-hermes-secrets /opt/blm-hermes-export');
  await machine.write(HERMES_EXPORT_HELPER_PATH, hermesExportHelperSource());
  await machine.run(`chown root:root ${HERMES_EXPORT_HELPER_PATH} && chmod 700 ${HERMES_EXPORT_HELPER_PATH}`);
  await machine.run('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv git ca-certificates');
  await machine.run('python3 -m venv /opt/blm-bootstrap && /opt/blm-bootstrap/bin/pip install uv==0.9.26');
  await machine.run('install -d -o root -g root -m 755 /opt/blm-python');
  await machine.run('UV_PYTHON_INSTALL_DIR=/opt/blm-python /opt/blm-bootstrap/bin/uv python install 3.11 --managed-python');
  await machine.run(`git clone https://github.com/NousResearch/hermes-agent.git /opt/blm-hermes && git -C /opt/blm-hermes checkout --detach ${HERMES_REVISION}`);
  await machine.run('managed_python="$(UV_PYTHON_INSTALL_DIR=/opt/blm-python /opt/blm-bootstrap/bin/uv python find 3.11 --managed-python)" && case "$managed_python" in /opt/blm-python/*) ;; *) exit 1 ;; esac && cd /opt/blm-hermes && UV_PYTHON_INSTALL_DIR=/opt/blm-python /opt/blm-bootstrap/bin/uv sync --frozen --no-dev --extra messaging --python "$managed_python"');
  await machine.run('chown -R root:root /opt/blm-hermes /opt/blm-bootstrap /opt/blm-python && chmod -R a+rX /opt/blm-hermes /opt/blm-bootstrap /opt/blm-python && chmod -R go-w /opt/blm-hermes /opt/blm-bootstrap /opt/blm-python');
  await machine.run('resolved_python="$(readlink -f /opt/blm-hermes/.venv/bin/python)" && case "$resolved_python" in /opt/blm-python/*) ;; *) exit 1 ;; esac && runuser -u blm-hermes -- /opt/blm-hermes/.venv/bin/python -c "import sys; assert sys.version_info[:2] == (3, 11)" && runuser -u blm-hermes -- sh -c "test ! -w /opt/blm-python && test ! -w /opt/blm-hermes && test ! -w /opt/blm-bootstrap"');
}

/** Call only while holding the account provisioning lease. Persist returned binding server-side. */
export async function provisionHermes(
  factory: HermesMachineFactory,
  ownerId: string,
  modelGateway: { url: string; scopedToken: string },
) {
  z.uuid().parse(ownerId);
  const apiKey = randomBytes(32).toString('hex');
  const launchConfiguration = hermesLaunchConfiguration({ gatewayUrl: modelGateway.url, apiServerKey: apiKey }, modelGateway.scopedToken);
  const machine = await factory.create(ownerId);
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
    await machine.write(HERMES_LAUNCH_PATH, JSON.stringify(launchConfiguration));
    await machine.run(`chown root:root ${HERMES_LAUNCH_PATH} && chmod 600 ${HERMES_LAUNCH_PATH}`);
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
    await machine.start(HERMES_LAUNCH_COMMAND);
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
    let cleanupConfirmed = false;
    try {
      await machine.destroy();
      cleanupConfirmed = true;
    } catch { /* caller can recover the exposed machine id */ }
    throw new HermesProvisionError(stage, diagnostic, machine.id, cleanupConfirmed);
  }
}
