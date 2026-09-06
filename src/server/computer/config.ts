import 'server-only';
import { e2bUnavailableReasons, type E2BConfiguration } from './e2b-adapter';

export function computerConfiguration(env: NodeJS.ProcessEnv = process.env): E2BConfiguration {
  return {
    enabled: env.COMPUTER_ENABLED === 'true',
    apiKey: env.E2B_API_KEY,
    templateId: env.E2B_TEMPLATE_ID,
    templateVerified: env.E2B_TEMPLATE_VERIFIED === 'true',
    templateVersion: env.E2B_TEMPLATE_VERSION,
    networkPolicyVersion: env.E2B_NETWORK_POLICY_VERSION,
    allowedHosts: (env.E2B_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  };
}

export function requireComputerConfiguration() {
  const config = computerConfiguration();
  const reasons = e2bUnavailableReasons(config);
  if (reasons.length > 0) return { available: false as const, reasons };
  return { available: true as const, config };
}
