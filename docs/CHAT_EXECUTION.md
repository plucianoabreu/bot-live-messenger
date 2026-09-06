# Chat execution checkpoint

## Implemented locally

- Official OpenAI Node SDK and Responses API adapter.
- Text-only execution boundary with bot instructions and explicit conversation history.
- Authorization callback before every provider call; context and output bounds.
- Cancellation signal, 90-second provider timeout, and no automatic provider retries.
- Provider response ID and token usage returned to the future durable worker.
- Regression tests for denied budget, cancellation, context overflow, success and ambiguous failure.

## Not enabled

This module is not an end-to-end worker. Keep RUNS_ENABLED=false. No paid request
has been used to validate this checkpoint. The authorization callback must be
implemented with a database transaction, active lease fencing, and a verified
model price bound before production use. It must never be replaced by a no-op.

## Next integration

1. Configure the Trigger.dev backend secret locally (project and CLI connection verified below).
2. Add service-only database claim, call authorization, completion and reconciliation
   functions. Persist the instruction snapshot and owner-scoped history; do not
   accept owner IDs or instructions from a job payload.
3. Connect Trigger dispatch to committed queued runs. Handle duplicate delivery,
   expired leases, cancellation and ambiguous calls without automatic re-spend.
4. Select an account-accessible OpenAI model and verify its current token prices.
5. Run a bounded paid smoke and verify the saved assistant message in the UI.
6. Create E2B configuration for the separate computer execution path.

The public chat endpoint deliberately remains disabled until this integration
and its database concurrency tests pass. No UI redesign is required.

References: https://github.com/openai/openai-node and
https://developers.openai.com/api/docs/guides/text

## Trigger.dev development connection — 2026-09-06

- Project `proj_iuurzeceuzuvaoqmieae`; CLI and SDK 4.5.16.
- Configuration: `trigger.config.ts`; task: `src/trigger/health.ts`.
- Start with `npx trigger.dev@4.5.16 dev --env-file .env.local`.
- Dashboard confirmed the development server connected.
- Health run `run_06g7g8kpe91ptj7j2bq6nlpa01` succeeded (17 ms).
- No OpenAI call or production deployment was made.
- Development execution runs on the local machine; production durability is not yet verified.
- 13 local tests and TypeScript verification passed.
- Dependency audit reports 15 moderate and 1 high transitive findings in the
  current Trigger SDK dependency tree (OpenTelemetry and ws). Compatible automatic
  audit fix did not resolve them. Review upstream updates before production;
  do not force-downgrade the SDK to v3 as suggested by npm audit.

## Database worker integration — 2026-09-06

- Implemented `src/trigger/chat.ts` and recovery task `src/trigger/reconcile.ts`.
- Chat admission dispatches only a persisted run ID. Computer admission remains blocked.
- Migration `chat_worker` applied to the dedicated hosted Supabase project.
- Service-only claim, call reservation, fenced completion and stale-run recovery.
- One model call per run; unknown outcomes are never automatically replayed.
- Trigger development secret and Supabase server secret saved locally, not committed.
- 14 tests and TypeScript pass. The test database now models the service_role role.
- Still disabled: model/pricing configuration, live paid smoke, periodic recovery
  scheduling, production deployment and E2B. The development worker must restart
  to load changed environment variables. This is not a completed live chat release.
- Chat memory injection is independently gated by `MEMORY_ENABLED=false`. Enable it
  only after the collaboration migration and hosted owner-isolation checks pass.
  Disabled workers do not query collaboration tables; enabled query failures remain
  fail-closed before authorization or provider I/O.

## Model selection — 2026-09-06

- User selected `gpt-5.6-luna` with `reasoning.effort=high`.
- Account model listing confirmed access to this model identifier.
- Local pricing: USD 0.20 / million input tokens and USD 1.20 / million
  output tokens, verified against official OpenAI documentation.
- TypeScript passed after adding reasoning to the request contract.
- An earlier minimal smoke returned HTTP 429 `credit_balance_exhausted` before
  project credit was added.
- On September 6, 2026, a new bounded smoke completed with the configured
  `gpt-5.6-luna` model: 11 input tokens, 5 output tokens, two output characters.
  No personal content was sent and the response body was not logged.
- This proves model access only. Public admission remains disabled until the
  durable authenticated chat flow and hosted release gates are verified.

## Account lifecycle and operator-readiness checkpoint — 2026-09-06

- Added a local-only, service-private account cleanup ledger with leased claims, bounded error codes and retry timing.
- Added an authenticated account deletion endpoint that requires the current password and exact destructive confirmation. It returns 202 with `PENDING`/`CLEANING` state and explicitly does not claim immediate deletion.
- The request transaction cancels every active run, propagates root cancellation through the existing trigger, closes Watch, releases resource leases and moves a provisioned computer to `DESTROYING`.
- The cleanup processor validates every private object path against the owner prefix, verifies both Storage buckets are private, renews its leased claim before each external operation and records a durable receipt after every stage. Retries skip completed stages; the database refuses `COMPLETED` while the Auth user exists or a receipt is missing.
- The endpoint fails closed unless the operator has explicitly enabled cleanup, verified a running worker and computer destroyer, and configured service credentials and both private buckets.
- `npm run diagnose:runtime` provides read-only JSON diagnostics for admission state, failed/stale runs, suspicious computers and pending deletion requests without logging message bodies, screenshots, document content or credentials.
- Local database and unit tests cover cancellation, cross-user hiding, service-only claims, resource inventory, Auth cascade, retained completion evidence, retries, confirmation, reauthentication ordering and failure-stage reporting.

Not enabled: the account cleanup migration has not been applied to the hosted project, no cleanup worker is scheduled, no concrete provider destroyer is wired, and no disposable hosted-account deletion has been observed. Keep all account cleanup flags false. Production account deletion, retention communication and OPS-01 reconciliation evidence remain externally blocked until those steps receive explicit operational authorization and are verified in the target environment.
