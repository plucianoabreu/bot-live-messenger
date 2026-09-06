import { ComputerFoundationError, type ComputerAction, type ComputerIdentity, type ComputerProvider } from './contracts';
import { validateComputerAction } from './policy';
import { ResourceLeaseManager, type ResourceLease } from './resources';

export type ComputerOperationKind = 'action' | 'export';
export type ComputerOperationOutcome = 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';
export type ComputerOperationAuthorization = { id: string; deadline: Date };
export interface ComputerOperationAuthorizer {
  begin(lease: ResourceLease, kind: ComputerOperationKind): Promise<ComputerOperationAuthorization>;
  finish(operation: ComputerOperationAuthorization, outcome: ComputerOperationOutcome): Promise<void>;
}

/**
 * The worker uses a short-lived session for every provider operation. It checks
 * the fencing token again after the call so a stale result is never persisted.
 */
export class FencedComputerSession {
  constructor(
    private readonly provider: ComputerProvider,
    private readonly computer: ComputerIdentity,
    private readonly lease: ResourceLease,
    private readonly leases: ResourceLeaseManager,
    private readonly authorizer: ComputerOperationAuthorizer,
  ) {}

  private async fenced<T>(kind: ComputerOperationKind, operation: () => Promise<T>) {
    await this.leases.assertCurrent(this.lease);
    const authorization = await this.authorizer.begin(this.lease, kind);
    try {
      await this.leases.assertCurrent(this.lease);
    } catch (error) {
      await this.authorizer.finish(authorization, 'FAILED');
      throw error;
    }
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      // Without provider-side action fencing, a thrown transport result may
      // have produced a side effect. Reconciliation must resolve it.
      await this.authorizer.finish(authorization, 'UNCERTAIN');
      throw error;
    }
    await this.authorizer.finish(authorization, 'SUCCEEDED');
    await this.leases.assertCurrent(this.lease);
    return result;
  }

  action(untrustedAction: ComputerAction) {
    if (this.lease.resourceKey !== 'desktop') {
      throw new ComputerFoundationError('LEASE_LOST');
    }
    const action = validateComputerAction(untrustedAction);
    return this.fenced('action', () => this.provider.act(this.computer, action));
  }

  captureFrame() {
    if (this.lease.resourceKey !== 'desktop') throw new ComputerFoundationError('LEASE_LOST');
    return this.fenced('action', () => this.provider.captureFrame(this.computer));
  }

  readExport(normalizedPath: string) {
    if (this.lease.resourceKey !== `file:${normalizedPath}`) throw new ComputerFoundationError('LEASE_LOST');
    return this.fenced('export', () => this.provider.readExport(this.computer, normalizedPath));
  }
}
