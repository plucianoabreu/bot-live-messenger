# Local setup for the first authenticated slice

The app stays at http://127.0.0.1:3000. Do not enable paid execution yet.

1. Create a dedicated Supabase project in a free organization, without selecting paid add-ons. If the account requires a paid plan, stop and review it against the USD 50 total pilot budget.
2. Put the project URL and publishable key in `.env.local` under `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Keep `APP_URL=http://127.0.0.1:3000` and `RUNS_ENABLED=false`. Do not paste secrets into chats or commit this file.
3. Configure email/password Auth, email delivery, and the app's callback/recovery URLs. The current recovery flow uses `/auth/callback?flow=recovery`; allow the exact localhost URLs used by the application.
4. Apply all numbered files in `supabase/migrations/` in order to this dedicated project. Review the target before executing remote SQL. Never apply these migrations to an unrelated product.
5. Restart Next.js. Create two test accounts, check that each receives ten presets, and verify creation/editing/avatar changes survive sign-out and return without exposing the other account's data.
6. Run `npm run check:setup`. Identity and execution configuration are reported independently. Missing execution credentials are expected at this stage; the checker makes no provider calls.

## Account deletion and operator diagnostics

Migration `20260906230000_account_cleanup.sql` is local and reviewable only. It has not been applied to the hosted project. Do not enable the deletion endpoint until the complete cleanup path is deployed and tested against disposable accounts.

The authenticated endpoint is `POST /api/account/deletion`. It requires the current password and the exact confirmation `DELETE MY ACCOUNT`; only the server-only RPC can create the durable request, so a browser JWT cannot bypass reauthentication by calling Supabase directly. Before creating the request, the server verifies that both configured Storage buckets exist and are private. A successful response is HTTP 202 and means only that a durable cleanup request exists. It does not mean the account or remote resources have already been deleted. The request transaction marks active runs cancelled, closes Watch access, releases computer leases and fences the user's computer for destruction. The cleanup processor renews its claim before each external operation and records durable receipts after artifact removal, frame removal, computer destruction and Auth deletion. Retries skip recorded stages. `COMPLETED` is rejected while the Auth user still exists or any stage receipt is missing; successful completion erases the user UUID from the cleanup ledger. Failed stages retain a bounded error code and retry state.

Keep these values false until their behavior is verified in the target environment:

```dotenv
ACCOUNT_CLEANUP_ENABLED=false
ACCOUNT_CLEANUP_WORKER_CONFIGURED=false
ACCOUNT_CLEANUP_COMPUTER_DESTROYER_CONFIGURED=false
```

The deletion API also requires the service-role key and both private bucket names. It returns 503 when any cleanup requirement is missing. Before changing the flags, verify an idempotent computer destroyer, a scheduled worker calling `processOneAccountDeletion`, private Storage deletion, Auth Admin deletion, retry monitoring and the retention notice. Provider-not-found responses must be handled as an idempotent success only after that behavior is verified for the configured provider.

Run `npm run diagnose:runtime` for a read-only structured report. It prints missing configuration, admission switches, failed or stale run IDs, nonterminal account cleanup request IDs and suspicious computer/provider IDs. It never prints message bodies, object contents or credential values and performs no reconciliation or mutation. A nonzero exit means configuration or database inspection failed. Pause admissions through the existing `runtime_config` kill switch only under an explicitly authorized operator procedure; after pausing, rerun diagnostics and let the existing run reconciler classify stale work before touching provider resources.

The service-role key and OpenAI/E2B/Trigger credentials are only needed for the next worker slice. They must remain server-only. A configured key is not evidence of a tested integration, and enabling an environment flag cannot replace the missing worker.

## Hosted database checkpoint — September 6, 2026

The three initial migrations were applied through the Supabase plugin to the dedicated project. Verified: 10 presets, 30 pictures, RLS enabled on all 12 public tables, and paid runtime disabled. Remote migration versions are 20260906181153, 20260906181201, and 20260906181209. Later checkpoints document additional hosted migrations individually; `20260906230000_account_cleanup.sql` is explicitly not among them. Do not replay the initial SQL bundle. Auth redirect configuration, email delivery, two-user end-to-end verification and account-cleanup deployment remain pending. Security advisor notices concern intentionally restricted internal tables and authenticated security-definer RPCs; this is not a completed production security audit.
