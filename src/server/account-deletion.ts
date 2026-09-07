import { accountCleanupReadiness, accountDeletionStatus, type AccountDeletionStatus } from '@/domain/account-deletion';
import { workerDatabase } from '@/server/execution/database';
import { verifyPrivateStorageBucket, type BucketInspector } from '@/server/computer/storage-policy';

export type AccountDeletionErrorCode =
  | 'REAUTHENTICATION_FAILED'
  | 'ACCOUNT_MISMATCH'
  | 'REQUEST_FAILED'
  | 'CLEANUP_UNAVAILABLE'
  | 'SESSION_REVOCATION_FAILED';

export class AccountDeletionError extends Error {
  constructor(readonly code: AccountDeletionErrorCode) { super(code); }
}

type AuthClient = {
  auth: {
    signInWithPassword(input: { email: string; password: string }): Promise<{ data: { user: { id: string } | null }; error: unknown }>;
    signOut(input: { scope: 'global' }): Promise<{ error: unknown }>;
  };
};

export async function requestAccountDeletion(input: {
  db: AuthClient;
  currentUser: { id: string; email?: string | null };
  password: string;
  persist(userId: string): Promise<unknown>;
}): Promise<AccountDeletionStatus> {
  if (!input.currentUser.email) throw new AccountDeletionError('REAUTHENTICATION_FAILED');
  const reauthenticated = await input.db.auth.signInWithPassword({ email: input.currentUser.email, password: input.password });
  if (reauthenticated.error || !reauthenticated.data.user) throw new AccountDeletionError('REAUTHENTICATION_FAILED');
  if (reauthenticated.data.user.id !== input.currentUser.id) throw new AccountDeletionError('ACCOUNT_MISMATCH');

  const parsed = accountDeletionStatus.safeParse(await input.persist(input.currentUser.id));
  if (!parsed.success) throw new AccountDeletionError('REQUEST_FAILED');

  const signedOut = await input.db.auth.signOut({ scope: 'global' });
  if (signedOut.error) throw new AccountDeletionError('SESSION_REVOCATION_FAILED');
  return parsed.data;
}

async function verifyCleanupBuckets(db: BucketInspector, env: NodeJS.ProcessEnv) {
  try {
    await Promise.all([
      verifyPrivateStorageBucket(env.ARTIFACT_BUCKET, db),
      verifyPrivateStorageBucket(env.WATCH_FRAME_BUCKET, db),
    ]);
  } catch {
    throw new AccountDeletionError('CLEANUP_UNAVAILABLE');
  }
}

export async function persistSupabaseAccountDeletion(userId: string, env: NodeJS.ProcessEnv = process.env) {
  const db = workerDatabase();
  await verifyCleanupBuckets(db, env);
  const result = await db.rpc('request_account_deletion', { p_user_id: userId });
  if (result.error) throw new AccountDeletionError('REQUEST_FAILED');
  return result.data;
}

export type AccountCleanupClaim = {
  request_id: string;
  user_id: string;
  claim_token: string;
  artifact_paths: string[];
  watch_paths: string[];
  computer_provider_ids?: string[];
  computer_provider_id?: string | null;
  artifacts_deleted: boolean;
  watch_deleted: boolean;
  computer_destroyed: boolean;
  auth_deleted: boolean;
};

export type AccountCleanupStage = 'ARTIFACTS_DELETED' | 'WATCH_DELETED' | 'COMPUTER_DESTROYED' | 'AUTH_DELETED';

export type CleanupFailureCode =
  | 'ARTIFACT_CLEANUP_FAILED'
  | 'WATCH_CLEANUP_FAILED'
  | 'COMPUTER_CLEANUP_FAILED'
  | 'AUTH_DELETE_FAILED'
  | 'FINALIZATION_FAILED'
  | 'UNKNOWN_CLEANUP_FAILURE';

export type AccountCleanupDependencies = {
  claim(): Promise<AccountCleanupClaim | null>;
  renew(claimToken: string): Promise<boolean>;
  recordStage(claimToken: string, stage: AccountCleanupStage): Promise<boolean>;
  recordComputerReceipt(claimToken: string, providerId: string): Promise<boolean>;
  removeArtifacts(paths: string[]): Promise<void>;
  removeWatchFrames(paths: string[]): Promise<void>;
  destroyComputer(providerId: string): Promise<void>;
  deleteAuthUser(userId: string): Promise<void>;
  finish(claimToken: string): Promise<boolean>;
  fail(claimToken: string, code: CleanupFailureCode): Promise<void>;
};

function assertOwnedPaths(userId: string, paths: readonly string[]) {
  const prefix = `${userId}/`;
  if (paths.some(path => !path.startsWith(prefix) || path.includes('..') || path.includes('\\') || /[\u0000-\u001f]/u.test(path))) {
    throw new Error('UNSAFE_PATH');
  }
}

function computerProviderIds(claim: AccountCleanupClaim) {
  const values = [
    ...(claim.computer_provider_ids ?? []),
    ...(claim.computer_provider_id ? [claim.computer_provider_id] : []),
  ];
  if (values.some(value => typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new Error('INVALID_PROVIDER_ID');
  }
  return [...new Set(values)];
}

/** Processes at most one leased request. Provider operations must be idempotent. */
export async function processOneAccountDeletion(dependencies: AccountCleanupDependencies) {
  const claim = await dependencies.claim();
  if (!claim) return { processed: false as const };
  let stage: CleanupFailureCode = 'UNKNOWN_CLEANUP_FAILURE';
  try {
    assertOwnedPaths(claim.user_id, claim.artifact_paths);
    assertOwnedPaths(claim.user_id, claim.watch_paths);
    const providerIds = computerProviderIds(claim);
    const runStage = async (receipt: boolean, failure: CleanupFailureCode, durableStage: AccountCleanupStage, action: () => Promise<void>) => {
      if (receipt) return;
      stage = failure;
      if (!await dependencies.renew(claim.claim_token)) throw new Error('STALE_CLEANUP_LEASE');
      await action();
      if (!await dependencies.recordStage(claim.claim_token, durableStage)) throw new Error('STALE_CLEANUP_LEASE');
    };
    await runStage(claim.artifacts_deleted, 'ARTIFACT_CLEANUP_FAILED', 'ARTIFACTS_DELETED', async () => {
      if (claim.artifact_paths.length > 0) await dependencies.removeArtifacts(claim.artifact_paths);
    });
    await runStage(claim.watch_deleted, 'WATCH_CLEANUP_FAILED', 'WATCH_DELETED', async () => {
      if (claim.watch_paths.length > 0) await dependencies.removeWatchFrames(claim.watch_paths);
    });
    await runStage(claim.computer_destroyed, 'COMPUTER_CLEANUP_FAILED', 'COMPUTER_DESTROYED', async () => {
      for (const providerId of providerIds) {
        await dependencies.destroyComputer(providerId);
        if (!await dependencies.recordComputerReceipt(claim.claim_token, providerId)) {
          throw new Error('STALE_CLEANUP_LEASE');
        }
      }
    });
    await runStage(claim.auth_deleted, 'AUTH_DELETE_FAILED', 'AUTH_DELETED', () => dependencies.deleteAuthUser(claim.user_id));
    stage = 'FINALIZATION_FAILED';
    if (!await dependencies.renew(claim.claim_token)) throw new Error('STALE_CLEANUP_LEASE');
    if (!await dependencies.finish(claim.claim_token)) throw new Error('STALE_CLEANUP_LEASE');
    return { processed: true as const, requestId: claim.request_id, state: 'COMPLETED' as const };
  } catch {
    await dependencies.fail(claim.claim_token, stage);
    return { processed: true as const, requestId: claim.request_id, state: 'FAILED' as const, errorCode: stage };
  }
}

export function supabaseAccountCleanupDependencies(
  destroyComputer: (providerId: string) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): AccountCleanupDependencies {
  const readiness = accountCleanupReadiness(env);
  if (!readiness.ready) throw new Error('ACCOUNT_CLEANUP_UNAVAILABLE');
  const db = workerDatabase();
  const artifactBucket = env.ARTIFACT_BUCKET!;
  const watchBucket = env.WATCH_FRAME_BUCKET!;
  return {
    claim: async () => {
      const result = await db.rpc('claim_account_deletion');
      if (result.error) throw new Error('ACCOUNT_CLEANUP_CLAIM_FAILED');
      return result.data as AccountCleanupClaim | null;
    },
    renew: async claimToken => {
      const result = await db.rpc('renew_account_deletion_claim', { p_claim_token: claimToken });
      if (result.error) throw new Error('ACCOUNT_CLEANUP_RENEW_FAILED');
      return result.data === true;
    },
    recordStage: async (claimToken, stage) => {
      const result = await db.rpc('record_account_deletion_stage', { p_claim_token: claimToken, p_stage: stage });
      if (result.error) throw new Error('ACCOUNT_CLEANUP_STAGE_FAILED');
      return result.data === true;
    },
    recordComputerReceipt: async (claimToken, providerId) => {
      const result = await db.rpc('record_account_deletion_computer_receipt', {
        p_claim_token: claimToken,
        p_provider_id: providerId,
      });
      if (result.error) throw new Error('ACCOUNT_CLEANUP_RECEIPT_FAILED');
      return result.data === true;
    },
    removeArtifacts: async paths => {
      await verifyCleanupBuckets(db, env);
      const result = await db.storage.from(artifactBucket).remove(paths);
      if (result.error) throw new Error('ARTIFACT_CLEANUP_FAILED');
    },
    removeWatchFrames: async paths => {
      await verifyCleanupBuckets(db, env);
      const result = await db.storage.from(watchBucket).remove(paths);
      if (result.error) throw new Error('WATCH_CLEANUP_FAILED');
    },
    destroyComputer,
    deleteAuthUser: async userId => {
      const current = await db.auth.admin.getUserById(userId);
      if (current.error && current.error.status !== 404) throw new Error('AUTH_DELETE_FAILED');
      if (!current.data.user) return;
      const result = await db.auth.admin.deleteUser(userId);
      if (result.error) throw new Error('AUTH_DELETE_FAILED');
    },
    finish: async claimToken => {
      const result = await db.rpc('finish_account_deletion', { p_claim_token: claimToken });
      if (result.error) throw new Error('FINALIZATION_FAILED');
      return result.data === true;
    },
    fail: async (claimToken, code) => {
      const result = await db.rpc('fail_account_deletion', { p_claim_token: claimToken, p_error_code: code });
      if (result.error) throw new Error('ACCOUNT_CLEANUP_FAILURE_RECORD_FAILED');
    },
  };
}
