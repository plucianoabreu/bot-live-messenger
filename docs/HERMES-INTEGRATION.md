# Hermes integration

The Trigger chat task selects Hermes when `HERMES_ENABLED=true`. Each account has
one isolated E2B machine in the service-only `hermes_workspaces` table. All its
bots share `/workspace/shared`, with separate stable sessions and instructions.

Before creating or resuming a machine, the worker claims an account-wide fence
and reserves compute from the pilot pool. Remote run IDs are persisted. Results
return through the existing message flow. A filesystem-only pause stops every
process while preserving files and sessions; the next run starts a fresh gateway.

Only a scoped proxy token enters the VM. The OpenAI key stays in Vercel. The
root-owned token file is outside the writable workspace, and the gateway drops to
the dedicated `blm-hermes` OS user before starting Hermes. Each model request is
authorized against the active run, cancellation, lease expiry and cumulative cost
reservation. The server controls model, output limit and allowed request fields.
Unknown outcomes retain their reservations.

## Runtime boundaries

- Pinned revision: `233757037df1f03f9fe1cfddc097acd5ad7f7510`.
- Eight turns, 80-second agent budget and 120-second machine lifetime.
- File tools only, restricted for writes to `/workspace`; text-only model input.
  The local terminal tool is disabled because it would execute with the gateway
  OS identity and is not a separate privilege boundary in the pinned Hermes build.
- Runtime egress is deny-by-default. Exact destinations come from
  `E2B_ALLOWED_HOSTS`; the model gateway hostname must be in that set.
- E2B sandbox URLs use private ingress and require the per-sandbox traffic token.
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

Set `HERMES_ENABLED`, `HERMES_TEMPLATE_ID`, `HERMES_MODEL_GATEWAY_URL`,
`E2B_NETWORK_POLICY_VERSION` and `E2B_ALLOWED_HOSTS` on Trigger. The destination
list accepts exact DNS hostnames only: no IP literals, local names or wildcards.
It must include the hostname from `HERMES_MODEL_GATEWAY_URL`. Missing, malformed
or unverifiable policy state stops execution before compute is claimed.

Rebuild the Hermes snapshot before enabling this revision. A snapshot made by the
previous adapter ran Hermes as root and exposed the terminal tool. Existing
workspace machines also predate private ingress; resume reasserts egress but fails
closed when E2B still reports public ingress. Removing and reprovisioning those
machines is a separate operator-authorized cleanup action.

Vercel needs `HERMES_ENABLED=true`, the existing database service credential,
OpenAI key and model rates. Set `TRIGGER_PRODUCTION_SECRET_KEY` in Vercel Production
to switch the dispatcher without replacing the existing dev/preview key.
Apply the `hermes_runtime` migration before activating the worker.

## Local verification and required E2B proof

Deterministic tests cover network options, traffic-token forwarding, invalid
policies, non-root provisioning, terminal removal, cancellation ordering and fence
retention when stop cannot be confirmed. They do not prove E2B enforcement.

Before activation, record sanitized evidence from a newly built E2B snapshot that:

1. The build-time allowlist is sufficient for the pinned checkout and frozen
   dependency install. Add no destination without identifying why it is needed.
2. `getInfo()` reports the exact egress allowlist, `0.0.0.0/0` denial and private
   ingress after create and resume; an unlisted destination fails, an allowlisted
   destination works, unauthenticated port access is rejected, and the traffic-token
   request succeeds.
3. The gateway process has a nonzero UID, capabilities expose no terminal tool,
   file writes cannot escape `/workspace`, and the agent cannot read the root-owned
   launch credential.
4. User cancellation and the database kill switch both abort a long run; Hermes
   reaches a terminal status before the machine pauses and the account fence is
   released. An unconfirmed stop must leave the machine unpaused and fence retained
   for operator recovery.

The previously recorded snapshot/readiness smoke predates these controls and is not
evidence for this security revision. No paid E2B call or external cleanup was run as
part of the local change.

## References

- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- https://e2b.dev/docs/network/restrict-public-access
- https://e2b.dev/pricing
