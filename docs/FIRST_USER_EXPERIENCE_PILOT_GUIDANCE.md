# First-user experience: pilot guidance

Snapshot reviewed: `cf3a6bddc1735de4cab68c0386ab9b2dfc1647a2`.

## V1 surface

V1 presents direct bot conversations and bot customization. It does not present conversation export, computer Watch, groups, or bot-to-bot delegation. Delivered files appear on the assistant message and download through the authenticated artifact route. The UI and this guide make no claim that Hermes computer execution is pilot-ready.

## Implemented in this clone

1. **No silent dead-end when live runs are disabled.** The composer is explicitly unavailable and the conversation notice tells the user that real tasks are not enabled for the account and that the local demo is the available path.

2. **Pilot limits are disclosed before use.** The welcome guide states the server-enforced allowance of up to five chat tasks per account and is explicit that the remaining balance is not available in the UI.

3. **An accepted first send appears immediately.** After the server returns `202`, the committed user message is added to the local transcript before refresh. The canonical `messageId` prevents a duplicate if polling already loaded it.

4. **Failure states preserve a useful next step.** Failed runs explain that the submitted message remains saved and can be retried. Workspace-load failures expose the bounded diagnostic code `WORKSPACE_LOAD_FAILED` without leaking internal details.

## Pilot operator guidance

- Keep the authenticated pilot demo-only while runtime admission is disabled; do not invite users to test real chat until the runtime gate is verified open.
- Tell each tester that the account allowance is five chat tasks. Ask them to capture the exact on-screen message if admission is refused.
- Treat `WORKSPACE_LOAD_FAILED` as a retryable workspace-load report; it does not identify the underlying service failure.
- Do not describe computer monitoring, groups, delegation, or conversation export as V1 capabilities.

## Remaining backend contract

The frontend cannot show an accurate remaining allowance because no owner-scoped quota summary is provided. If that becomes a pilot requirement, the backend owner should expose a bounded value such as `{ chatUsed, chatLimit }`; the frontend should not derive it from the partial message/run history loaded for the workspace.

Security and backend hardening are evolving in parallel in the parent task; this review is limited to first-user experience and pilot communication.
