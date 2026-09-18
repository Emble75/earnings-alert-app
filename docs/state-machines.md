# State machines

Every transition is declared. Anything undeclared raises
`InvalidTransitionError`. There is no "just set the column" path in any
service, which is what stops a crashed worker or a replayed webhook from
teleporting an order into `APPROVED`.

## Opportunity

```
DISCOVERED -> MATCH_PENDING -> MATCH_VERIFIED -> PRICE_PENDING
           -> PROFITABLE -> RISK_REVIEW -> ACTIONABLE
           -> LISTING_CANDIDATE -> LISTED
           -> SALE_RECEIVED -> REVALIDATION_REQUIRED -> APPROVAL_REQUIRED
           -> APPROVED -> EXECUTING -> FULFILLMENT_PENDING -> FULFILLED
           -> COMPLETED
```

Plus `REJECTED`, `EXPIRED`, `FAILED`, `CANCELLED`, `BLOCKED`.

Notable edges:

- `ACTIONABLE -> RISK_REVIEW` and `LISTING_CANDIDATE -> RISK_REVIEW`
  ("re-evaluated"). The monitors re-check settled opportunities on every
  sweep; returning them to `RISK_REVIEW` keeps the re-check visible in the
  audit trail instead of mutating the row in place.
- `BLOCKED -> MATCH_PENDING` and `BLOCKED -> REVALIDATION_REQUIRED`: a block
  can be cleared and the opportunity re-evaluated.
- There is no shortcut from `DISCOVERED` to `ACTIONABLE`. Every gate runs.

Terminal: `COMPLETED`, `REJECTED`, `EXPIRED`, `FAILED`, `CANCELLED`.

## Order — the sell-first invariant

```
SALE_RECEIVED -> VALIDATING -> REVALIDATION_REQUIRED -> APPROVAL_REQUIRED
              -> APPROVED -> SOURCE_PURCHASE_PENDING -> SOURCE_PURCHASED
              -> SOURCE_SHIPPING -> SOURCE_RECEIVED -> INSPECTION
              -> FULFILLMENT -> OUTBOUND_SHIPPING -> SHIPPED
              -> DELIVERED -> COMPLETED
```

The invariant the whole design rests on, asserted by
`test_a_sale_cannot_reach_approved_without_revalidation`:

- `SALE_RECEIVED -> APPROVED` does not exist.
- `SALE_RECEIVED -> APPROVAL_REQUIRED` does not exist.
- `VALIDATING -> APPROVED` does not exist.
- `APPROVAL_REQUIRED` is reachable **only** from `REVALIDATION_REQUIRED`.
- `SOURCE_PURCHASE_PENDING` has exactly one predecessor: `APPROVED`.

So an approval screen can never be built from pre-sale numbers, and a purchase
can never happen without an approval. Not "should not" - cannot.

Recovery edges: `SOURCE_PURCHASE_PENDING -> REVALIDATION_REQUIRED` when the
price or stock moved at purchase time, and `BLOCKED -> REVALIDATION_REQUIRED`
when a block is cleared.

## Shipment

```
PENDING -> LABEL_CREATED -> SHIPPED -> IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED
```

with `EXCEPTION` reachable from every in-transit state and recoverable back to
`IN_TRANSIT` or forward to `DELIVERED`, `LOST` or `RETURNED`.
`PENDING -> DELIVERED` does not exist: a parcel cannot be delivered before a
label exists.

## Return

```
RETURN_REQUESTED -> RETURN_AUTHORIZED -> RETURN_IN_TRANSIT -> RETURN_RECEIVED
                 -> INSPECTION_REQUIRED -> REFUND_REQUIRED -> REFUNDED -> CLOSED
```

`RETURN_REQUESTED -> REFUNDED` does not exist: a refund follows receipt and
inspection.

## Every transition is recorded

Each order transition writes one `order_events` row (from, to, actor,
message, timestamp, idempotency key) and one `audit_logs` row. The event key
is scoped per event type, so two distinct events arising from the same
underlying operation - dispatching a purchase and recording its confirmation -
do not collide.
