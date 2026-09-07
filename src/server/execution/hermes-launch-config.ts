import { z } from 'zod';

export const HERMES_LAUNCH_PATH = '/opt/blm-hermes-secrets/launch.json';
export const HERMES_GATEWAY_LOG_PATH = '/opt/blm-hermes-secrets/gateway.log';
export const HERMES_LAUNCH_COMMAND = `umask 077 && python3 /opt/blm-hermes-launch.py > ${HERMES_GATEWAY_LOG_PATH} 2>&1`;

export function hermesLaunchConfiguration(authority: { gatewayUrl: string; apiServerKey: string }, scopedToken: string) {
  const gateway = new URL(authority.gatewayUrl);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error('HERMES_GATEWAY_CONFIG_INVALID');
  }
  z.string().regex(/^[a-f0-9]{64}$/).parse(authority.apiServerKey);
  z.string().regex(/^[a-f0-9]{64}$/).parse(scopedToken);
  return {
    HERMES_HOME: '/opt/blm-hermes-state', API_SERVER_KEY: authority.apiServerKey, API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: '8642', OPENAI_BASE_URL: gateway.toString(),
    OPENAI_API_KEY: scopedToken, TERMINAL_CWD: '/workspace/shared', HERMES_WRITE_SAFE_ROOT: '/workspace', HOME: '/workspace',
  };
}
