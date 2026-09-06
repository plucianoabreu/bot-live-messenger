import { ComputerFoundationError, type Clock, systemClock } from './contracts';
import { normalizeExportPath, type WorkspacePolicy } from './policy';

export type ResourceLease = {
  ownerId: string;
  runId: string;
  executionVersion: number;
  holderId: string;
  resourceKey: string;
  fencingToken: number;
  expiresAt: Date;
};

export type LeaseRequest = Omit<ResourceLease, 'fencingToken' | 'expiresAt'> & { ttlMs: number };

export interface ResourceLeaseRepository {
  acquire(request: LeaseRequest, now: Date): Promise<ResourceLease>;
  current(ownerId: string, resourceKey: string): Promise<ResourceLease | null>;
  release(lease: ResourceLease): Promise<boolean>;
}

export function desktopResource() { return 'desktop'; }
export function fileResource(relativePath: string, policy: WorkspacePolicy) {
  return `file:${normalizeExportPath(relativePath, policy)}`;
}

export class ResourceLeaseManager {
  constructor(private readonly repository: ResourceLeaseRepository, private readonly clock: Clock = systemClock) {}

  async acquire(request: LeaseRequest) {
    if (!request.ownerId || !request.runId || !request.holderId || request.executionVersion < 1 || request.ttlMs < 1 || request.ttlMs > 30_000) {
      throw new ComputerFoundationError('LEASE_LOST');
    }
    return this.repository.acquire(request, this.clock.now());
  }

  async assertCurrent(lease: ResourceLease) {
    const current = await this.repository.current(lease.ownerId, lease.resourceKey);
    if (!current || current.fencingToken !== lease.fencingToken || current.runId !== lease.runId ||
      current.executionVersion !== lease.executionVersion || current.holderId !== lease.holderId ||
      current.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new ComputerFoundationError('LEASE_LOST');
    }
  }

  release(lease: ResourceLease) { return this.repository.release(lease); }
}

/** Deterministic fake. Production must use the atomic database lease functions. */
export class InMemoryResourceLeaseRepository implements ResourceLeaseRepository {
  private readonly leases = new Map<string, ResourceLease>();
  private token = 0;
  private key(ownerId: string, resourceKey: string) { return `${ownerId}\0${resourceKey}`; }

  async acquire(request: LeaseRequest, now: Date) {
    const key = this.key(request.ownerId, request.resourceKey);
    const existing = this.leases.get(key);
    const sameHolder = existing && existing.runId === request.runId && existing.executionVersion === request.executionVersion && existing.holderId === request.holderId;
    if (existing && existing.expiresAt.getTime() > now.getTime() && !sameHolder) throw new ComputerFoundationError('RESOURCE_BUSY');
    const lease: ResourceLease = {
      ...request,
      fencingToken: sameHolder ? existing.fencingToken : ++this.token,
      expiresAt: new Date(now.getTime() + request.ttlMs),
    };
    delete (lease as ResourceLease & { ttlMs?: number }).ttlMs;
    this.leases.set(key, lease);
    return lease;
  }

  async current(ownerId: string, resourceKey: string) { return this.leases.get(this.key(ownerId, resourceKey)) ?? null; }
  async release(lease: ResourceLease) {
    const key = this.key(lease.ownerId, lease.resourceKey);
    const current = this.leases.get(key);
    if (!current || current.fencingToken !== lease.fencingToken) return false;
    this.leases.delete(key);
    return true;
  }
}
