# Pilot quota rebalance

## Fixed USD 50 envelope

| Bucket | Amount | Enforced use |
| --- | ---: | --- |
| Messaging | USD 30 | Chat-run model reservation of USD 0.02 each |
| Computer | USD 10 | Explicit computer runs and Hermes compute reservation of USD 0.25 each |
| Operator reserve | USD 10 | Infrastructure, tests, discrepancies, and no automatic runtime allocation |

The reserve is not a user allocation and the migration does not move it into either execution pool.

## Account limits and arithmetic

An account can create eight lifetime chat runs and one lifetime computer run, shared across bots, with no renewal. The account reservation ceiling is USD 2.41:

```
8 chats × (USD 0.02 model + USD 0.25 Hermes compute) +
1 computer run × USD 0.25 = USD 2.41
```

The USD 0.25 compute reservation is unchanged. It must cover the configured 120-second VM ceiling before Hermes starts, so lowering it merely to increase the number of chats would weaken the hard cost stop. Four accounts using every allowance reserve USD 9.00 of the USD 10 computer pool; the remaining USD 1.00 stays subject to the same atomic global and per-account checks.

`reserved_micros` is an admission ceiling, not a claim that the provider spent that amount. Hermes stores known measured model/compute cost when complete. Missing or ambiguous provider measurements produce a durable `unknown` settlement and retain the full reservation.

## Admission and migration behavior

- Matching idempotency retries return the original run and allocate nothing again.
- A denied admission rolls back before creating a run or reservation.
- An accepted run consumes its lifetime allowance and reservation even if later cancelled, fails, or expires. There is no automatic refund for ambiguous provider work.
- Existing allocations are never lowered. On upgrade, a computer allocation already above USD 10 remains the effective pool limit, so all additional computer reservations fail closed; no historical reservation or measured settlement is rewritten.
- Existing known and unknown Hermes settlements, usage intents, reservation rows, and idempotency identities remain unchanged.
