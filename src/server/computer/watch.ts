import { ComputerFoundationError, type Clock, systemClock } from './contracts';
import { FencedComputerSession } from './session';

export const watchLeaseMs = 60_000;

export type WatchLease = { id: string; ownerId: string; runId: string; expiresAt: Date; closedAt: Date | null };
export type WatchFrameObject = { objectPath: string };

export function assertActiveWatch(lease: WatchLease, ownerId: string, clock: Clock = systemClock) {
  if (lease.ownerId !== ownerId || lease.closedAt || lease.expiresAt.getTime() <= clock.now().getTime()) {
    throw new ComputerFoundationError('WATCH_EXPIRED');
  }
  return lease;
}

export interface ExpiredWatchRepository {
  claimExpired(now: Date): Promise<Array<{ lease: WatchLease; frames: WatchFrameObject[] }>>;
  finishExpiry(leaseId: string): Promise<void>;
}

export interface PrivateFrameStore { delete(objectPath: string): Promise<void>; }

export interface WatchLeaseRepository { current(watchId: string): Promise<WatchLease | null>; }
export interface WatchCaptureAuthorizer { authorize(ownerId: string, watchId: string): Promise<void>; }

/** Rechecks expiry before and after capture so an expired frame is discarded. */
export class WatchedComputerSession {
  constructor(
    private readonly watches: WatchLeaseRepository,
    private readonly computer: FencedComputerSession,
    private readonly authorizer: WatchCaptureAuthorizer,
    private readonly clock: Clock = systemClock,
  ) {}

  async capture(ownerId: string, watchId: string) {
    const before = await this.watches.current(watchId);
    if (!before) throw new ComputerFoundationError('WATCH_EXPIRED');
    assertActiveWatch(before, ownerId, this.clock);
    await this.authorizer.authorize(ownerId, watchId);
    const frame = await this.computer.captureFrame();
    const after = await this.watches.current(watchId);
    if (!after) throw new ComputerFoundationError('WATCH_EXPIRED');
    assertActiveWatch(after, ownerId, this.clock);
    return frame;
  }
}

export async function expireWatches(repository: ExpiredWatchRepository, store: PrivateFrameStore, clock: Clock = systemClock) {
  const expired = await repository.claimExpired(clock.now());
  for (const item of expired) {
    for (const frame of item.frames) await store.delete(frame.objectPath);
    await repository.finishExpiry(item.lease.id);
  }
  return expired.length;
}
