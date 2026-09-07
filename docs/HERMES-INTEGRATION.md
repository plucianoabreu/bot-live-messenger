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

## Artifact delivery and deletion

Hermes outputs are eligible for delivery only from `/workspace/exports`. The
worker must authorize the exact normalized path against the current account/run
fence, read without following symlinks, enforce the configured byte limit, then
copy the bytes to the private artifact bucket. Delivery metadata includes the
run, filename, MIME type, byte size and SHA-256 checksum; the database announces
the artifact only after Storage upload and a second current-fence check.

The reusable export seam is implemented in `src/server/computer/hermes-artifacts.ts`.
The Hermes executor still needs to call it before clearing `active_run`; this
change does not claim attachment delivery is enabled in hosted execution.

Account cleanup now inventories both provider-neutral computers and
`hermes_workspaces`, destroys every distinct machine before Auth deletion, and
uses cascading foreign keys only after the tracked destruction receipt exists.

## Provisioning

Run `node --env-file=.env.local --import tsx scripts/build-hermes-image.ts`.
The script creates a credential-free snapshot, writes its reference to the ignored
`.local-setup/hermes-image.json` and removes the build machine.

Set `HERMES_ENABLED`, `HERMES_TEMPLATE_ID` and `HERMES_MODEL_GATEWAY_URL` on Trigger.
Vercel needs `HERMES_ENABLED=true`, the existing database service credential,
OpenAI key and model rates. Set `TRIGGER_PRODUCTION_SECRET_KEY` in Vercel Production
to switch the dispatcher without replacing the existing dev/preview key.
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
