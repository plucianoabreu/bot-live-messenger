# Hermes integration

The Trigger chat task selects Hermes when `HERMES_ENABLED=true`. Each account has
one isolated E2B machine in the service-only `hermes_workspaces` table. All its
bots share `/workspace/shared`, with separate stable sessions and instructions.

Before creating or resuming a machine, the worker claims an account-wide fence
and reserves compute from the pilot pool. Remote run IDs are persisted. Results
return through the existing message flow. A filesystem-only pause stops every
process while preserving files and sessions; the next run starts a fresh gateway.

Only a run-and-execution-version-scoped proxy token enters the VM. The OpenAI key
stays in Vercel. The root-owned token file is outside the writable workspace, and
the gateway drops to the dedicated `blm-hermes` OS user. A resume replaces the
previous token before the gateway starts, and the database rejects the previous
token. Each model request is authorized against that exact run/version,
cancellation, lease expiry, both runtime flags and cumulative cost reservation.
The server controls model, output limit and allowed request fields. Unknown
outcomes retain their reservations.

Production also requires an operator-verified versioned rate card and exact E2B
resource shape. Before provider work, the executor proves that the configured
120-second compute worst case fits the reserved ceiling. Every claimed execution
then writes one idempotent settlement with observed model tokens and active
duration. Missing usage retains the full reservation and never creates a refund.

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
- Unexpected worker death retains the fence. A later worker may clear it only
  after the provider confirms the persisted machine is paused and the database
  accepts the exact recovery token, run and execution version. The production
  maintenance schedule reclaims an abandoned recovery token after five minutes;
  lease expiry alone never releases or transfers the fence.
- Live screen streaming and vision are outside this adapter.

## Artifact delivery and deletion

Hermes outputs are eligible for delivery only from `/workspace/exports`. The
worker must authorize the exact normalized path against the current account/run
fence, read without following symlinks, enforce the configured byte limit, then
copy the bytes to the private artifact bucket. Delivery metadata includes the
run, filename, MIME type, byte size and SHA-256 checksum; the database announces
the artifact only after Storage upload and a second current-fence check.

The executor uses a per-execution delivery contract. When a user requests a file,
Hermes writes at most one file below `/workspace/exports/<run-id>/<version>/`
and declares its basename with `[[artifact:filename]]`. The worker validates the
declaration, derives the path itself, and uses the existing authorized, symlink-safe
export seam before announcing delivery. Ordinary replies do not export files.
The global `HERMES_EXPORT_PATH` setting is no longer used.

Account cleanup inventories both provider-neutral computers and
`hermes_workspaces`, stores a destruction receipt for each provider ID, and deletes
Auth only after all receipts and storage cleanup stages are durable. A Trigger
Production schedule runs one bounded attempt for account, artifact-intent and
watch-frame cleanup plus Hermes recovery every five minutes; one failing lane
does not skip the others.

## Provisioning

Run `node --env-file=.env.local --import tsx scripts/build-hermes-image.ts`.
The script creates a credential-free snapshot, writes its reference to the ignored
`.local-setup/hermes-image.json` and removes the build machine.

Set `HERMES_ENABLED`, `HERMES_TEMPLATE_ID`, `HERMES_MODEL_GATEWAY_URL`,
`HERMES_RATE_CARD_ID`, `E2B_VCPU_COUNT`, `E2B_MEMORY_MIB`, both
`E2B_COMPUTE_MICROS_PER_*` rates, `E2B_NETWORK_POLICY_VERSION` and
`E2B_ALLOWED_HOSTS` on Trigger. The destination
list accepts exact DNS hostnames only: no IP literals, local names or wildcards.
It must include the hostname from `HERMES_MODEL_GATEWAY_URL`. Missing, malformed
or unverifiable policy state stops execution before compute is claimed.

Set the account-cleanup flags and bucket variables on Trigger Production, not
only on Vercel. The cleanup task needs the service-role and E2B credentials in the
worker environment to remove private objects and destroy account machines.

Rebuild the Hermes snapshot before enabling this revision. A snapshot made by the
previous adapter ran Hermes as root and exposed the terminal tool. Existing
workspace machines also predate private ingress; resume reasserts egress but fails
closed when E2B still reports public ingress. Removing and reprovisioning those
machines is a separate operator-authorized cleanup action.

Vercel needs `HERMES_ENABLED=true`, the existing database service credential,
OpenAI key and model rates. Set `TRIGGER_PRODUCTION_SECRET_KEY` in Vercel Production
to switch the dispatcher without replacing the existing dev/preview key.
Apply every migration in filename order, including the Hermes lifecycle and
usage-settlement migrations, before activating the worker.

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
evidence for this security revision. The security/recovery migration remains a
deployment gate; hosted end-to-end activation is a separate release check. No
paid E2B call or external cleanup was run as part of the local change.

## References

- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- https://e2b.dev/docs/network/restrict-public-access
- https://e2b.dev/pricing
