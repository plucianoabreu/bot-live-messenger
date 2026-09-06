# Bot Live Messenger PRD 1.7 execution plan

Source of truth: `docs/PRD.md`. This plan advances the implementation without enabling public execution until the release gates are proven.

## Global constraints

- Preserve the approved Messenger 2009 interface and existing user-visible copy unless a task explicitly integrates a real state.
- Fail closed when provider configuration is absent.
- Keep secrets server-side and never log message bodies, screenshots, files, or credentials.
- Keep `RUNS_ENABLED=false` until hosted identity, worker, quota, and cancellation checks pass.
- Do not deploy, publish, purchase, or create external resources without explicit authorization.
- New database changes must be additive migrations and include deterministic tests.

## Task 1: durable real chat and live updates

Complete the authenticated text-chat vertical slice: owner-scoped run reads and event pagination, canonical polling/reconnect behavior, durable message refresh, cancellation feedback, and clear run states in the approved UI. Preserve Trigger.dev idempotency and server-enforced quotas. Add tests for all new boundaries.

## Task 2: safe computer, watch, and artifact foundation

Add a provider-neutral computer harness with an E2B adapter boundary, workspace/path/network policies, leases, idle lifecycle, watch-frame leases, private artifact metadata, and fail-closed APIs. E2B is not enabled without credentials and a verified template. Add tests using deterministic fakes.

## Task 3: durable memory, groups, and delegation foundation

Add owner-scoped inspect/update/delete memory, persistent groups and membership, durable attributed handoff records, cycle/depth/budget guards, and APIs. Do not implement provider actions that increase authorization. Add RLS/database tests and API/domain tests.

## Task 4: integration and product completion

Integrate Tasks 1-3 into the approved UI, reconcile migrations and shared types, complete Notepad behaviors required by the PRD, improve setup diagnostics, and keep unavailable features honest. Run the complete test/typecheck/build suite and document verified versus externally blocked acceptance criteria.

## Task 5: release review

Perform security, concurrency, failure-recovery, accessibility, and production-readiness review. Fix load-bearing findings. Produce a final implementation report without claiming deployment or live provider evidence that was not observed.
