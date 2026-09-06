# PRD 1.7 implementation checkpoint

September 6, 2026. First development slice: durable team profiles and display pictures.

## Delivered locally

- Ten deterministic preset definitions matching the proposed role responsibilities. Existing three preset identities are retained when migrating. Existing user-edited names, instructions and portraits survive repeated onboarding. Exact Grok roster or capability parity is not claimed.
- Create/edit bot APIs with owner-scoped database functions, strict request schemas, body limits, idempotent creation, 20 custom bots per account and versioned instructions. Queued runs retain an instruction snapshot.
- One shared computer assignment per user, with provider metadata hidden from browser credentials. A legacy account with multiple actual providers requires explicit reconciliation; migration does not silently destroy computers.
- Admission supports up to three different bots per user while preserving one open run per bot and the USD 50 pilot allocation. This enables queue admission, not actual parallel provider execution.
- User and bot picture controls expose all 30 catalog assets. Source SHA-256 checksums are verified; separate PNG previews of GIFs support reduced motion. The demo preserves its 13 historical contacts with new portraits; authenticated onboarding provisions ten role presets plus custom bots.
- Profile forms call real APIs in authenticated mode; demo bot edits remain session-local and clearly labeled. Demo user-picture choice is stored separately from authenticated profiles.
- Read-only setup checker prints missing variable names without exposing secrets or contacting providers.

## Acceptance evidence and limits

| Requirement | Status |
|---|---|
| TEAM-01 | Database onboarding is idempotent for ten roles. Role capability benchmarks and exact roster confirmation remain pending. |
| TEAM-02 / INS-01 | API/database implementation complete; local Postgres tests cover ownership, repeated creation, editing and instruction snapshots. Hosted Auth/reload verification pending. |
| AVATAR-01 | Catalog rendering and selection implemented. Authenticated persistence is implemented in Postgres but not verified against hosted Supabase. |
| AVATAR-02 | Original checksums and all five still-preview files verified. Browser verified all 30 images loaded, changing the user picture, and creating a custom demo contact. Hosted persistence and reduced-motion interaction remain unverified in the browser. |
| TEAM-03 / TEAM-06 | Shared assignment and bounded concurrent admission implemented. Resource leases and real shared-computer scheduling remain pending. |
| I18N-01..04, DESK-01..02, NOTE-01..03 | Pending; this checkpoint does not claim localization or the new Notepad/shortcuts. |
| MEM-01, TEAM-04..05, TEAM-07 | Pending; bot instruction persistence is not learned memory or inter-bot collaboration. |
| F1 provider integration | Pending credentials, worker implementation, cost enforcement and a genuine paid smoke within the pilot budget. |

Local tests use PGlite with emulated auth.uid; they do not verify cloud services or multi-process worker behavior. Runtime remains disabled. No paid resources or public deployment were created.

## Next integration order

1. Create/configure the dedicated Supabase project and run the full migration chain; validate two-user sign-in and profile persistence.
2. Implement a bounded Responses/E2B vertical slice with one user-owned computer, actual cost accounting and export/pause/resume evidence.
3. Add durable dispatch, claims, resource leases and cancellation before enabling runtime admission.
4. Complete collaborating groups and inspectable memory, localization and the specified desktop/Notepad flows against the PRD acceptance criteria.
