# Authenticated conversation prewarm

Opening an owned bot conversation issues a best-effort authenticated request.
The server and database flags default off. Page load, signup and anonymous
visitors do not start preparation. Rendering, typing and admission never await
provider readiness.

The database serializes account admission and reserves 250,000 micros from
both the computer pool and the account allowance before provider access. It
leaves headroom for a normal run and applies a ten-minute cooldown; reopening
cannot extend or replace an outstanding intent. This reservation is retained
in full, including failures, and settlement labels it `reserved_upper_bound`.
It is not a measured provider invoice. Model billing remains on the real run.

A first account uses the existing Hermes template and provisioner. The intent
UUID is included in E2B metadata on the create request itself, and the returned
machine ID is persisted before configuring the guest. The temporary gateway
cannot authorize model calls. After verifying setup, pause/resume drops its
process while retaining disk. The real run rotates credentials and starts the
gateway normally. Existing accounts only resume their assigned VM.

Preparation has a fixed 120-second acceptance deadline; it cannot be extended
by reopen or retry. The worker is capped at 150 seconds and a newly created VM
has a 180-second automatic pause timeout. Recovery waits until five minutes
after intent creation so the original worker has stopped. An outstanding
intent prevents another create even after its deadline. An exact, bounded E2B
metadata scan finds creation whose response was lost; mismatches, truncated
inventory and provider failures retain the fence. Unknown creations are
destroyed; existing account workspaces are paused, preserving files.

Before READY, E2B's timeout is set to 60 seconds. READY also schedules a cleanup
task after 60 seconds. This is a bounded idle window, not an exact wall-clock
guarantee: transport and scheduler latency still exist. The five-minute
maintenance lane is a recovery fallback, not the primary idle limit.

Workspace claim atomically consumes READY ownership and settles the prewarm
reservation. Only then does the normal run connect renew its timeout. Cleanup
cannot pause a handed-off run; a cleanup winner fences subsequent claims until
provider completion. Pending sends remain durably queued and redispatch while
preparation/recovery owns the workspace. An ambiguous provider failure can
therefore delay execution, but cannot silently create a second VM. Cancellation
retains normal run semantics. Account deletion waits for unsettled intents so
the orphan lookup key cannot disappear first. Recovery operates with admission
disabled, and the normal post-run pause remains unchanged.

## Local evidence and release gates

PGlite tests cover reservation/dedupe, a first account without a fake run,
both handoff/expiry orderings, deadline/recovery, deletion fencing and grants.
Fake provider tests cover metadata before a lost create response, correlated
recovery, bounded inventory, foreign metadata and failed pause. These are
offline proofs, not concurrent PostgreSQL sessions or hosted provider evidence.

Before activation, review the full diff from c0c87ad; validate migrations and
real lock races in PostgreSQL; deploy matching web/Trigger code with flags off;
verify the delayed cleanup task and maintenance schedule; then perform an
explicitly authorized bounded E2B smoke for create-response loss, timeout
renewal, idle pause and deletion. No publication, migration, provider call or
paid smoke is authorized by this document. No latency threshold is promised.

For a bounded smoke, `HERMES_TEST_USER_ID` may name exactly one UUID. When it
is set, the prewarm route and prewarm worker fail closed for every other
account; normal message admission and normal chat workers are unchanged. It is
only a server-side prewarm test scope; leave all activation flags false by
default and use an isolated disposable account for paid validation.
