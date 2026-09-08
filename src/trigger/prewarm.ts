import { task } from '@trigger.dev/sdk';
import { z } from 'zod';
import { workerDatabase } from '../server/execution/database';
import { connectHermesE2B, hermesRuntimeNetworkPolicy } from '../server/execution/hermes-e2b';
import { hermesUsageConfiguration } from '../server/billing/hermes-usage';
import { randomBytes } from 'node:crypto';
import { provisionHermes } from '../server/execution/hermes-provision';
import { HermesE2BFactory } from '../server/execution/hermes-e2b';

const claimSchema = z.object({ status: z.enum(['disabled', 'unavailable', 'busy', 'preparing', 'ready']), lease_token: z.uuid().optional(), machine_id: z.string().min(1).max(200).optional() });

/** Best-effort warmup only: it has no run, no gateway token and no model call. */
export const prewarmTask = task({
  id: 'bot-messenger-prewarm', maxDuration: 60, retry: { maxAttempts: 1 },
  run: async (payload: { userId: string }) => {
    if (process.env.PREWARM_ENABLED !== 'true') return { skipped: 'disabled' as const };
    const userId = z.uuid().parse(payload.userId);
    const db = workerDatabase();
    const claimed = await db.rpc('claim_hermes_prewarm', { p_user_id: userId });
    if (claimed.error) throw new Error('PREWARM_CLAIM_FAILED');
    const lease = claimSchema.parse(claimed.data);
    if (lease.status !== 'preparing') return { skipped: lease.status };
    const apiKey = process.env.E2B_API_KEY;
    const gateway = process.env.HERMES_MODEL_GATEWAY_URL;
    if (!apiKey || !gateway || !lease.lease_token || !process.env.HERMES_TEMPLATE_ID) return { skipped: 'unconfigured' as const };
    try {
      const usage = hermesUsageConfiguration(process.env);
      const policy=hermesRuntimeNetworkPolicy(gateway, process.env.E2B_NETWORK_POLICY_VERSION, process.env.E2B_ALLOWED_HOSTS);
      let machineId=lease.machine_id;
      if(machineId) await connectHermesE2B(apiKey,machineId,policy,{cpuCount:usage.vcpuCount,memoryMib:usage.memoryMib});
      else {
        const created=await provisionHermes(new HermesE2BFactory(apiKey,process.env.HERMES_TEMPLATE_ID!,120_000,policy,{cpuCount:usage.vcpuCount,memoryMib:usage.memoryMib}),userId,{url:gateway,scopedToken:randomBytes(32).toString('hex')});
        machineId=created.machineId;
        const saved=await db.from('hermes_workspaces').update({machine_id:created.machineId,base_url:created.baseUrl,api_key:created.apiKey,revision:created.revision,provision_cleanup_required:false}).eq('user_id',userId).is('active_run',null).select('user_id').maybeSingle();
        if(saved.error||!saved.data) throw new Error('PREWARM_BINDING_FAILED');
      }
      const completed = await db.rpc('complete_hermes_prewarm', { p_user_id: userId, p_lease_token: lease.lease_token, p_machine_id: machineId });
      if (completed.error || completed.data !== true) return { skipped: 'fenced' as const };
      return { ready: true as const };
    } catch {
      // A failed warmup has no user-visible consequence; normal run admission remains independent.
      await db.rpc('abort_hermes_prewarm', { p_user_id: userId, p_lease_token: lease.lease_token });
      return { skipped: 'failed' as const };
    }
  },
});
