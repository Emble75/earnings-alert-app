# Architecture

## What this system is

A sell-first arbitrage platform. It finds products that can be bought on a
source marketplace (Amazon) and sold on a target marketplace (eBay), lists
them **before** buying, and only commits money once a sale has actually
happened and every input has been re-checked against live data.

The ordering matters. A conventional "buy cheap, hope it sells" tool carries
inventory risk. This one carries *supply* risk instead: the moment a buyer
commits, the system re-verifies that we can still source the item at a price
that leaves a profit, and asks the operator for one approval before spending
anything.

```
Discover -> Match -> Price -> Profit -> Risk -> Compliance -> ACTIONABLE
   -> Listing candidate -> (revalidate) -> LISTED
      -> SALE -> mandatory live revalidation -> APPROVAL_REQUIRED
         -> one approval -> purchase -> receive -> inspect -> repack
            -> ship -> tracking -> delivered -> realized profit
```

## Design commitments

These are the things the code refuses to compromise on. Each one is enforced
by a mechanism, not by convention.

**Money is exact.** Every amount is a `Decimal` inside a `Money` value object
and is persisted as integer cents. `Money` raises `TypeError` on a `float`,
and so does the `MoneyCents` column type. There is no path by which a float
reaches a price. (`app/core/money.py`, `app/db/types.py`)

**Manual fulfilment costs nothing.** The operator's own time is not a cash
cost and is not modelled as one. There is no labour rate, handling charge,
warehouse allocation or opportunity cost anywhere in the profit engine, and a
test asserts that no such field exists. Operational exposure from depending on
one person is accounted for in the *risk* engine, which is where it belongs.

**Nothing irreversible runs on stale data.** Every observation carries a
timestamp; every commitment re-reads them. Missing data counts as stale, never
as fine.

**A purchase requires an approval.** `APPROVAL_REQUIRED` is reachable only
from `REVALIDATION_REQUIRED`, and `APPROVED` only from `APPROVAL_REQUIRED`.
The state machine makes an unapproved purchase unreachable rather than merely
discouraged, and a test asserts that `SOURCE_PURCHASE_PENDING` has exactly one
predecessor.

**Absent or contradictory information blocks.** The system prefers `UNKNOWN`,
`REVIEW` or `BLOCKED` to an optimistic guess. A price gap large enough to look
like free money is treated as a defect in the data, not a windfall.

**Determinism where money is decided.** Matching, profit and risk are pure
functions of stored inputs, versioned, and reproducible. No language model
participates in any of them.

## Layout

```
backend/app/
  core/            money, config, clock, errors, logging, security, ids
  db/              declarative base, session, custom column types
  models/          ORM models and the domain enums
  schemas/         API request/response models
  state_machines/  opportunity, order, shipment, return
  matching/        identifier validation, normalisation, the matcher
  profit/          fee models, the profit engine, scenarios
  risk/            risk factors and the scoring engine
  compliance/      rules and the gating service
  listing/         the sell-first listing engine
  fulfillment/     the FulfillmentProvider interface and the manual provider
  shipping/        shipping provider
  providers/       source/target provider interfaces, demo and live adapters
  services/        orchestration (opportunity, order, capital, market, ...)
  analytics/       dashboard analytics and backtesting
  workers/         Celery application and scheduled tasks
  api/routes/      FastAPI routers
frontend/          Next.js operator console
```

## Dependency direction

```
api ──► services ──► engines (profit, risk, matching, compliance)
          │                │
          ▼                ▼
      providers        models / db
```

The engines never import a provider, and the providers never import a service.
"Add another source marketplace" is a new adapter behind `SourceProvider`;
"switch to a 3PL" is a new implementation of `FulfillmentProvider`. Neither
touches the arbitrage logic.

## Operating modes

| Mode | Set by | Behaviour |
| --- | --- | --- |
| `DEMO` | `DEMO_MODE=true`, or any missing provider credential | Demo providers, a deterministic catalogue, no external calls |
| `SIMULATION` | Credentials present, `SIMULATION_MODE=true` | Full workflow, nothing committed externally |
| `LIVE` | Credentials present, `SIMULATION_MODE=false` | Real marketplace calls |

A half-configured system degrades to `DEMO`. It never silently reaches a live
marketplace because one credential was missing.

## Automation levels

`AUTOMATION_LEVEL` (0-4, default 2):

| Level | Behaviour |
| --- | --- |
| 0 | Manual research and execution |
| 1 | Automatic discovery and analysis |
| 2 | Adds listing candidates and one-click purchase approval (default) |
| 3 | Approved orders are executed by the worker without a second prompt |
| 4 | Higher automation, still inside the risk, capital and compliance limits |

Levels above 2 require explicit activation. Compliance and capital limits
apply at every level; no automation level can bypass them.

## Reliability

Crash recovery rests on four mechanisms:

1. **Idempotency keys** derived from the logical action (`purchase`, order
   reference, offer id, quantity). Unique constraints make the guarantee, not
   the code path.
2. **Validated state transitions.** A replayed webhook or a restarted worker
   cannot teleport an order forward.
3. **Transaction boundaries.** The capital check and its reservation happen in
   one transaction, so two concurrent approvals cannot both pass the same limit.
4. **Append-only history.** `order_events` and `audit_logs` record what
   happened, so state can be reconciled after a failure.

Celery runs with `acks_late` and `reject_on_worker_lost`: a worker that dies
mid-task has its message redelivered, which is only safe because the services
above are idempotent.

## Known limitations

Stated plainly, because a trading system that hides its limits is dangerous:

- **The live marketplace adapters are unproven.** They speak a documented JSON
  gateway contract (`docs/providers.md`), not Amazon SP-API or eBay Sell API
  wire formats. Mapping that contract to the real APIs is the remaining
  integration work, and it must be done with credentials in hand.
- **Fee schedules are defaults, not facts.** The shipped eBay-shaped schedule
  is a placeholder. Every operator must enter the fee model their own account
  and category actually incur before trusting a profit number.
- **Backtesting needs history.** It replays only recorded observations and
  reports itself unavailable below a minimum, rather than inventing data.
- **The learning system is versioning, not adaptation.** Models are versioned
  and decisions are reproducible; nothing automatically tunes a financial rule.
  That is deliberate.
- **Single-currency.** `Money` enforces currency at every operation, but there
  is no FX conversion; cross-currency arbitrage would need a rate provider.

## Technical risks

| Risk | Mitigation in place |
| --- | --- |
| Marketplace API changes break sourcing | Providers are isolated behind interfaces; failures degrade to blocked opportunities rather than bad purchases |
| Source price moves between approval and purchase | The purchase carries the approved price as a hard ceiling; the provider refuses above it |
| A rate limit or ban from over-polling | Token-bucket limiter, exponential backoff and a circuit breaker on every live call |
| Matching a near-identical variant | Identifier checksums, variant/condition/pack blocking, evidence ceilings |
| A price anomaly read as profit | Ratio threshold produces a hard blocker, not a deduction |
| Duplicate purchase after a crash | Idempotency keys with unique constraints |
| Fee model drift understating cost | Fees are configurable and versioned; each calculation stores the version it used |
