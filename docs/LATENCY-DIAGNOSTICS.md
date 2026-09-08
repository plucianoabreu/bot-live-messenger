# Latency diagnostics

Set `LATENCY_DIAGNOSTICS=true` in both the web deployment and the `bot-messenger-chat` Trigger worker after applying migration `20260908020000_chat_latency_observability.sql`. Redeploy both services, then use the separately authorized bounded browser smoke. Removing the variable disables new measurements. Activation creates no account and makes no provider call.

The measurements contain only fixed stage names, millisecond durations and the run relationship. They never contain a prompt, reply, identity, provider body, credential, model name, token hash or error detail.

`chat_latency_measurements` uses the worker's monotonic clock. It measures worker claim, history, memory, direct-provider start/end, Hermes cold provisioning or resume, remote Hermes execution, executor completion and successful persistence. A null stage is missing data, not zero duration.

`chat_latency_client_measurements` has separate clocks. Admission stages start at API request entry; browser stages start at submit and end at HTTP acceptance or an animation frame after the assistant DOM node exists. Do not subtract durations across these sources. `recorded_at` and `updated_at` can order database receipts, but do not establish an exact browser-to-worker duration.

Operators use `service_role` to inspect a known run:

```sql
select * from public.chat_latency_measurements where run_id = :run_id;
select * from public.chat_latency_client_measurements where run_id = :run_id;
```

The browser may not report a complete-visible answer when the page is closed, hidden or offline. Report those cases separately. The full visible-answer measure is `browser_answer_dom_ready_ms`; streaming or a persisted response alone does not satisfy it.
