import { task } from '@trigger.dev/sdk';

/** Connection smoke only: no model calls and no private data in the output. */
export const workerHealth = task({
  id: 'bot-messenger-health',
  maxDuration: 10,
  retry: { maxAttempts: 1 },
  run: async () => ({
    connected: true,
    chatAdmissionEnabled: process.env.RUNS_ENABLED === 'true',
    configuration: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      model: Boolean(process.env.OPENAI_MODEL),
      database: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  }),
});
