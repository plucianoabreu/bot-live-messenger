# Hermes integration

The Trigger chat task selects Hermes when `HERMES_ENABLED=true`. Each account has
one isolated E2B machine in the service-only `hermes_workspaces` table. All its
bots share `/workspace/shared`, with separate stable sessions and instructions.

Before creating or resuming a machine, the worker claims an account-wide fence
and reserves compute from the pilot pool. Remote run IDs are persisted. Results
return through the existing message flow. A filesystem-only pause stops every
process while preserving files and sessions; the next run starts a fresh gateway.

Only a scoped proxy token enters the VM. The OpenAI key stays in Vercel. Each model
request is authorized against the active run, cancellation, lease expiry and
cumulative cost reservation. The server controls model, output limit and allowed
request fields. Unknown outcomes retain their reservations.

## Runtime boundaries

- Pinned revision: `233757037df1f03f9fe1cfddc097acd5ad7f7510`.
- Eight turns, 80-second agent budget and 120-second machine lifetime.
- Terminal and file tools; text-only model input.
- Different accounts execute independently; bots in one account take turns.
- Unexpected worker death retains the fence for operator recovery.
- Live screen streaming, vision, attachment delivery and automatic recovery of
  abandoned fences are not implemented by this adapter.

## Provisioning

Run `node --env-file=.env.local --import tsx scripts/build-hermes-image.ts`.
The script creates a credential-free snapshot, writes its reference to the ignored
`.local-setup/hermes-image.json` and removes the build machine.

Set `HERMES_ENABLED`, `HERMES_TEMPLATE_ID` and `HERMES_MODEL_GATEWAY_URL` on Trigger.
Vercel needs `HERMES_ENABLED=true`, the existing database service credential,
OpenAI key and model rates. The web dispatcher must use a Production Trigger key.
Apply the `hermes_runtime` migration before activating the worker.

## Verified infrastructure

An E2B snapshot was built. An isolated instance passed authenticated internal and
external API readiness checks and was removed. The Supabase migration was applied;
anonymous and authenticated roles cannot read workspace credentials or authorize
model calls. The local suite (91 tests) and Next.js production build passed in an
isolated checkout. Hosted end-to-end activation is a separate release check.

## References

- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- https://e2b.dev/pricing
