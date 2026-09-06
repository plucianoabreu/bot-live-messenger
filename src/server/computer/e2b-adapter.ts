import {
  ComputerFoundationError,
  type CapturedFrame,
  type ComputerAction,
  type ComputerIdentity,
  type ComputerProvider,
  type ComputerState,
  type ExportedFile,
} from './contracts';
import { validateComputerAction, validateDestination, type WorkspacePolicy } from './policy';

export type E2BConfiguration = {
  enabled: boolean;
  apiKey?: string;
  templateId?: string;
  templateVerified: boolean;
  templateVersion?: string;
  networkPolicyVersion?: string;
  allowedHosts: readonly string[];
};

export function e2bUnavailableReasons(config: E2BConfiguration) {
  const reasons: string[] = [];
  if (!config.enabled) reasons.push('COMPUTER_DISABLED');
  if (!config.apiKey) reasons.push('E2B_API_KEY_MISSING');
  if (!config.templateId) reasons.push('E2B_TEMPLATE_ID_MISSING');
  if (!config.templateVerified) reasons.push('E2B_TEMPLATE_UNVERIFIED');
  if (!config.templateVersion) reasons.push('E2B_TEMPLATE_VERSION_MISSING');
  if (!config.networkPolicyVersion) reasons.push('NETWORK_POLICY_UNVERIFIED');
  if (config.allowedHosts.length === 0) reasons.push('DESTINATION_SET_EMPTY');
  return reasons;
}

export function e2bAvailable(config: E2BConfiguration) {
  return e2bUnavailableReasons(config).length === 0;
}

export interface E2BTransport {
  create(input: { apiKey: string; templateId: string }): Promise<{ sandboxId: string }>;
  state(input: { apiKey: string; sandboxId: string }): Promise<ComputerState>;
  resume(input: { apiKey: string; sandboxId: string }): Promise<void>;
  pause(input: { apiKey: string; sandboxId: string }): Promise<void>;
  destroy(input: { apiKey: string; sandboxId: string }): Promise<void>;
  act(input: { apiKey: string; sandboxId: string; action: ComputerAction }): Promise<void>;
  captureFrame(input: { apiKey: string; sandboxId: string }): Promise<CapturedFrame>;
  readExport(input: { apiKey: string; sandboxId: string; path: string; noFollow: true }): Promise<ExportedFile>;
}

export type DestinationResolver = (hostname: string) => Promise<readonly string[]>;

/** The transport is injected so the foundation can be tested without paid calls. */
export class E2BComputerAdapter implements ComputerProvider {
  constructor(
    private readonly config: E2BConfiguration,
    private readonly transport: E2BTransport,
    private readonly resolveDestination?: DestinationResolver,
  ) {}

  private credentials() {
    if (!e2bAvailable(this.config)) throw new ComputerFoundationError('INTEGRATION_UNAVAILABLE');
    return { apiKey: this.config.apiKey!, templateId: this.config.templateId! };
  }

  async ensure(userId: string) {
    const credentials = this.credentials();
    if (!userId) throw new ComputerFoundationError('INTEGRATION_UNAVAILABLE');
    const result = await this.transport.create(credentials);
    return { providerReference: result.sandboxId, templateVersion: this.config.templateVersion! };
  }

  state(computer: ComputerIdentity) { return this.transport.state({ apiKey: this.credentials().apiKey, sandboxId: computer.providerReference }); }
  resume(computer: ComputerIdentity) { return this.transport.resume({ apiKey: this.credentials().apiKey, sandboxId: computer.providerReference }); }
  pause(computer: ComputerIdentity) { return this.transport.pause({ apiKey: this.credentials().apiKey, sandboxId: computer.providerReference }); }
  destroy(computer: ComputerIdentity) { return this.transport.destroy({ apiKey: this.credentials().apiKey, sandboxId: computer.providerReference }); }
  async act(computer: ComputerIdentity, untrustedAction: ComputerAction) {
    const credentials = this.credentials();
    const action = validateComputerAction(untrustedAction);
    if (action.type === 'navigate') {
      if (!this.resolveDestination) throw new ComputerFoundationError('UNSAFE_DESTINATION');
      let url: URL;
      try { url = new URL(action.url); } catch { throw new ComputerFoundationError('UNSAFE_DESTINATION'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !this.config.allowedHosts.includes(url.hostname.toLowerCase())) {
        throw new ComputerFoundationError('UNSAFE_DESTINATION');
      }
      const policy: WorkspacePolicy = {
        workspaceRoot: '/workspace', exportRoot: '/workspace/exports', maxExportBytes: 10 * 1024 * 1024,
        allowedHosts: new Set(this.config.allowedHosts), maxRedirects: 3,
      };
      validateDestination(action.url, await this.resolveDestination(url.hostname), 0, policy);
    }
    return this.transport.act({ apiKey: credentials.apiKey, sandboxId: computer.providerReference, action });
  }
  captureFrame(computer: ComputerIdentity) { return this.transport.captureFrame({ apiKey: this.credentials().apiKey, sandboxId: computer.providerReference }); }
  readExport(computer: ComputerIdentity, normalizedPath: string) {
    return this.transport.readExport({ apiKey: this.credentials().apiKey, sandboxId: computer.providerReference, path: normalizedPath, noFollow: true });
  }
}
