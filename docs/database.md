# Database

PostgreSQL 16, SQLAlchemy 2.0, Alembic. 28 tables.

## Money is stored as integer cents

The `MoneyCents` column type persists a signed `BIGINT` of cents and returns an
exact `Decimal`. The representation is identical on PostgreSQL and SQLite,
immune to float coercion by any driver, and safe to `SUM()` in SQL. Binding a
`float` raises `TypeError` at the column boundary.

`Ratio` stores margins, ROI and probabilities as `NUMERIC(18,6)`. `StringEnum`
persists enums by **value**, so reordering a Python enum can never silently
remap historical rows. `JSONDict` is `JSONB` on PostgreSQL.

## Tables

**Identity and configuration** — `users`, `settings`

**Products and matching** — `products`, `product_identifiers`,
`product_matches`

**Market observations** — `source_offers`, `target_listings`, `price_history`,
`inventory_snapshots`, `delivery_estimates`, `competition_snapshots`

**Decisions** — `opportunities`, `profit_calculations`, `risk_assessments`

**Orders and money** — `orders`, `order_events`, `source_orders`,
`capital_reservations`

**Fulfilment** — `fulfillment_orders`, `warehouse_receipts`, `inspections`,
`shipments`, `returns`

**Operations** — `audit_logs`, `notifications`, `idempotency_keys`,
`provider_health`, `compliance_checks`

## Constraints that enforce behaviour

These are load-bearing, not decoration:

| Constraint | What it prevents |
| --- | --- |
| `uq_order_external (provider, external_order_id)` | A redelivered sale webhook creating a second order |
| `uq_source_order_idempotency (idempotency_key)` | A retried worker buying the same item twice |
| `uq_shipment_idempotency (idempotency_key)` | A retry buying a second label |
| `uq_order_event_idempotency (order_id, idempotency_key)` | Duplicate history rows for one action |
| `uq_idempotency_scope_key (scope, key)` | Two callers both performing a once-only action |
| `uq_capital_reservation_order_purpose` | Re-approval double-counting capital |
| `uq_notification_dedupe (dedupe_key)` | The same alert being sent twice |
| `uq_product_identifier` | Duplicate identifiers on one product |

## Why brand and model are duplicated

`source_offers` and `target_listings` each store the brand and model **as
observed on that marketplace**, separately from the canonical `products` row.
Without this the matcher ends up comparing a product record with itself and
every match scores identically. The duplication is what makes the brand and
model checks mean anything.

## One deferred foreign key

`opportunities.target_listing_id` and `target_listings.opportunity_id` point at
each other. The second is created with `use_alter`, so the tables have no
circular dependency at DDL time. The initial migration emits that constraint
explicitly after both tables exist, because Alembic's autogenerate skips
`use_alter` foreign keys inside `create_table`.

## Migrations

```bash
cd backend
alembic upgrade head          # apply
alembic check                 # models and migrations agree?
alembic revision --autogenerate -m "description"
alembic downgrade base        # tear down
```

Migrations render the custom column types as plain DDL (`BIGINT`,
`NUMERIC(18,6)`, `TEXT`, `JSONB`) rather than importing `app.db.types`, so old
migrations keep working after those classes are refactored or moved.

Verified against PostgreSQL 16: clean upgrade from an empty database,
`alembic check` reports no drift, and `downgrade base` returns to zero tables.

## Freshness columns

`opportunities` carries `source_price_timestamp`, `target_price_timestamp`,
`inventory_timestamp`, `delivery_timestamp`, `match_timestamp`,
`risk_timestamp` and `profit_calculation_timestamp` as separate columns. They
are separate because they go stale at different rates and the revalidation
logic reports precisely which input aged out.
