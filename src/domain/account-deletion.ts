import { z } from 'zod';

export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE MY ACCOUNT';

export const accountDeletionInput = z.object({
  password: z.string().min(6).max(128),
  confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION),
}).strict();

export const accountDeletionStatus = z.object({
  id: z.uuid(),
  state: z.enum(['PENDING', 'CLEANING', 'FAILED', 'COMPLETED']),
  requested_at: z.string(),
});

export type AccountDeletionStatus = z.infer<typeof accountDeletionStatus>;

const cleanupRequirements = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ARTIFACT_BUCKET',
  'WATCH_FRAME_BUCKET',
] as const;

export function accountCleanupReadiness(env: NodeJS.ProcessEnv = process.env) {
  const reasons: string[] = [];
  if (env.ACCOUNT_CLEANUP_ENABLED !== 'true') reasons.push('ACCOUNT_CLEANUP_DISABLED');
  if (env.ACCOUNT_CLEANUP_WORKER_CONFIGURED !== 'true') reasons.push('ACCOUNT_CLEANUP_WORKER_UNVERIFIED');
  if (env.ACCOUNT_CLEANUP_COMPUTER_DESTROYER_CONFIGURED !== 'true') reasons.push('COMPUTER_DESTROYER_UNVERIFIED');
  for (const key of cleanupRequirements) if (!env[key]?.trim()) reasons.push(`${key}_MISSING`);
  return { ready: reasons.length === 0, reasons } as const;
}

