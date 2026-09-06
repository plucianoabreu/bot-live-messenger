import type { Clock, ComputerIdentity, ComputerProvider } from './contracts';
import { systemClock } from './contracts';

export const computerIdleMs = 15_000;

export type IdleSnapshot = {
  state: 'READY' | 'PAUSED' | 'NOT_CREATED' | 'UNAVAILABLE';
  lastUsedAt: Date | null;
  activeComputerRuns: number;
  activeResourceLeases: number;
  activeWatchLeases: number;
};

export function shouldPauseComputer(snapshot: IdleSnapshot, now: Date, idleMs = computerIdleMs) {
  return snapshot.state === 'READY' && snapshot.lastUsedAt !== null &&
    now.getTime() - snapshot.lastUsedAt.getTime() >= idleMs &&
    snapshot.activeComputerRuns === 0 && snapshot.activeResourceLeases === 0 && snapshot.activeWatchLeases === 0;
}

export type PauseClaim = { ownerId: string; version: number; computer: ComputerIdentity };
export interface IdleComputerRepository {
  claimIdle(cutoff: Date): Promise<PauseClaim | null>;
  finishPause(claim: PauseClaim, paused: boolean): Promise<void>;
}

export async function pauseOneIdleComputer(
  repository: IdleComputerRepository,
  provider: ComputerProvider,
  clock: Clock = systemClock,
  idleMs = computerIdleMs,
) {
  const claim = await repository.claimIdle(new Date(clock.now().getTime() - idleMs));
  if (!claim) return false;
  try {
    await provider.pause(claim.computer);
    await repository.finishPause(claim, true);
    return true;
  } catch (error) {
    await repository.finishPause(claim, false);
    throw error;
  }
}
