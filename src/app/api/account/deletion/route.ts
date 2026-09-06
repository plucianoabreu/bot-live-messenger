import { accountCleanupReadiness } from '@/domain/account-deletion';
import { persistSupabaseAccountDeletion, requestAccountDeletion } from '@/server/account-deletion';
import { createAccountDeletionHandlers } from '@/server/account-deletion-route';
import { boundedJson, requireUser, sameOrigin } from '@/server/http';

const handlers = createAccountDeletionHandlers({
  readiness: accountCleanupReadiness,
  authenticate: requireUser,
  readJson: boundedJson,
  originAllowed: sameOrigin,
  requestDeletion: requestAccountDeletion,
  persist: persistSupabaseAccountDeletion,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
