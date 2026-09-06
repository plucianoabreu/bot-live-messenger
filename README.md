# Bot Live Messenger web

Implementation started from the approved Messenger-inspired prototype and the [final PRD](docs/PRD.md). This is the local foundation, not the integrated V0 or a deployment.

## Run locally

Node 22 or later is required.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000. The homepage and `/preview` render the Messenger 2009 markup, CSS and interaction controller directly inside Next.js, without an iframe. The explicitly labeled demonstration includes the full 13-contact catalog, mock replies, signup/login, independent 2009 chat windows, menus and appearance controls. Those simulated behaviors are never used for authenticated runs. The original interactive prototype remains in `../agent-messenger` on its existing server.

## Revised product target

[PRD v1.7](docs/PRD.md) now requires at least ten specialized presets, custom Bot creation, persistent preferences and role memory, one shared computer per user, parallel Bot execution, direct handoffs and group chats. These are requirements, not implemented capabilities. The exact Grok default roster is still unverified; the PRD lists a sourced proposed selection. The first implementation slice adds ten presets, custom profile APIs, versioned instructions, user-owned computer assignments and bounded concurrent admission. Group conversations, learned memory, resource coordination and actual execution remain pending. See [implementation status](docs/IMPLEMENTATION-1.7.md).

## Implemented

- Next.js App Router, strict TypeScript, React and original Messenger CSS/assets.
- Email/password login, signup, recovery, PKCE callback, server session validation and sign-out through Supabase SSR, retaining the approved forms.
- Protected workspace with per-user presets and persisted conversation reads.
- Message and cancellation API handlers with validation and same-origin checks.
- Postgres schema with ownership RLS, server-only computer records, atomic message/run creation, matching-payload idempotency, one open run per bot and up to three per user, lifetime welcome quotas, atomic global budget reservations and cancellation.
- Database and application kill switches default off. A queued run is a persisted outbox record; no worker currently consumes it.
- Domain tests and executable Postgres migration/authorization tests using PGlite.

## Configuration and remaining integration

Copy `.env.example` to `.env.local` and use a dedicated Supabase project. Never commit credentials. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `APP_URL`. Configure email/password auth and email delivery in Supabase Auth, and permit the exact `/auth/callback` and recovery callback URLs. Apply all migrations in `supabase/migrations/` in filename order only to that dedicated project after review.

Do not turn on `RUNS_ENABLED` or the database `runtime_config` switch yet. Before doing so, implement and verify:

1. Trigger.dev durable dispatch, worker claims with leases/fencing, global concurrency and reconciliation.
2. Responses API loop with a verified model, cancellation checkpoints, bounded calls, cost reservations and safe tool policies.
3. E2B Desktop secure creation/resume/pause, restricted network and controlled actions.
4. Private Storage artifacts, authorized downloads and viewer leases for real screenshots.
5. Private Realtime Broadcast and reconnect recovery. The foundation currently refreshes authoritative server data every five seconds; it is not the final realtime transport.
6. Paginated history (the initial query loads the most recent 300 messages across the workspace), observability and PRD launch gates.

The schema uses `bot_id` as the conversation identifier because the existing foundation models one conversation per bot; this must change for the revised group-chat requirements. Separate run and computer state avoids treating a paused PC as lost history. Provider IDs have no authenticated-user SELECT grant.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

Local tests verify migration execution, user A/B isolation, denied direct writes, hidden computer metadata, disabled-runtime admission, idempotency conflicts, no duplicate message, one open run, quota and queued cancellation. These tests run Postgres through PGlite with an emulated Supabase `auth.uid()`; they do not verify hosted OAuth, Supabase Storage/Realtime, provider SDKs, cross-process worker races or paid execution.

Browser checks include comparison against the approved prototype, the 13-contact demonstration, signup, independent conversations and window interactions. Build and eight tests passed on September 6, 2026. No cloud resources were created, migrations applied remotely, or deployment performed.

## Sources and decisions

- [PRD](docs/PRD.md)
- [Architecture conversation reference](docs/architecture-reference.md): archived proposal, not an implementation certification.
- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Supabase server-side clients](https://supabase.com/docs/guides/auth/server-side/creating-a-client)

Keep the original artwork and Selawik license bundled in `public/assets/fonts`.

## Approved interface implementation

`src/components/approved/markup.ts` holds trusted static application markup; `runtime.js` is the original controller scoped to a React-owned host, with timer and resize-listener cleanup and an authenticated API adapter. `globals.css` contains the reference stylesheet plus researched 2009 overrides; scoped selectors also support independent windows. React handles routes and backend data; the isolated controller owns its DOM descendants. No untrusted content enters the static markup. User messages continue to be escaped by the original renderer.

The design is not deferred scope. Changes to visual hierarchy, login method, window layout or established controls require a product decision, not an inferred architecture shortcut. Live integrations remain separately gated.

The [2009 research baseline](docs/MESSENGER-2009.md) supersedes the prior mixed 2009–2011 styling. Native conversation tabs are removed; conversations are independent windows with isolated drafts. The previous static prototype remains unchanged as historical project evidence.

The signed-in desktop now includes an original aurora wallpaper, movable contact and conversation windows, and a labeled advertising placement below What's New. Drag a title bar or focus it and use Alt + arrow keys (Shift for fine movement). The ad placement is local preview content, with no third-party ad network. The fullscreen login and absence of an OS taskbar are preserved.

## USD 50 pilot policy

Each account receives five chat messages and one computer task, shared across bots, with no automatic renewal. Chat admission reserves USD 0.02 from a USD 10 pool; computer admission reserves USD 0.25 from a USD 25 pool. USD 15 is held outside execution for infrastructure, tests and discrepancies. All runs are limited to 120 seconds by the execution contract.

The second migration serializes global allocation and account admission in one transaction. Matching retries return the original run without allocating again. Cancellation and failure retain the allowance and reservation conservatively. Global pools are private and cannot be changed by user JWTs. The API defaults to `kind: "chat"`; explicit `kind: "computer"` uses the separate allowance. Future workers must never provide computer tools to chat runs.

These are implemented admission controls, not a provider billing guarantee. The worker must enforce aggregate model, compute and screenshot costs against each reservation before enabling execution. Provider limits, taxes, subscriptions and charges outside this app require separate operator reconciliation. No paid plans or execution have been enabled. The demo remains isolated from these real-account quotas.

For the dedicated Supabase project, follow [local setup](docs/LOCAL_SETUP.md). `npm run check:setup` reports missing configuration without making provider calls.
