# Fulfilment

## Version 1: the operator is the warehouse

```
Amazon -> operator receives the parcel -> inspects it
       -> repacks if needed -> applies the correct address and return details
       -> ships to the buyer -> uploads tracking -> delivered
```

Each step is recorded: `warehouse_receipts`, `inspections`,
`fulfillment_orders`, `shipments`. Not because v1 needs the ceremony, but
because recording it is what makes a later 3PL a provider swap rather than a
rewrite.

## The cost model

Manual fulfilment's external fee schedule is **all zeros**:

```python
{"receiving_fee": 0, "storage_fee": 0, "pick_fee": 0, "pack_fee": 0,
 "handling_fee": 0, "outbound_fee": 0, "return_fee": 0}
```

The only costs are real cash:

| Configurable | Default | What it is |
| --- | --- | --- |
| `PACKAGING_COST` | €1.00 | Box, tape, label, charged only when repacking |
| `SOURCE_TO_OPERATOR_SHIPPING_COST` | €0.00 | Inbound postage, if the source charges it |
| `OPERATOR_TO_CUSTOMER_SHIPPING_COST` | €5.99 | Outbound postage |
| `RETURN_SHIPPING_COST` | €5.99 | Return postage |

The operator's time is not on this list and will not be added to it. See
[profit-engine.md](profit-engine.md) for why, and where the operational
exposure is accounted for instead.

## Inspection

`inspect_product()` verifies the identifier, quantity, condition and
accessories. The verification helpers **fail closed**: with nothing to compare
against, `verify_sku` returns `False` rather than assuming a pass, and an
`UNKNOWN` observed condition never satisfies an expected one. Unverifiable is
not the same as verified.

A failed inspection fails the order. Compliance blocks dispatch until an
inspection has passed, so an unchecked item cannot be sent to a buyer.

## Packaging and origin

Tracked: `original_package`, `received_condition`, `repack_required`,
`packaging_type`, dimensions, weight, `outbound_label`, `tracking_number`.

Repacking here means ordinary shipping preparation: a suitable box, the
correct address, the correct return details. It does not include, and this
codebase must not gain, any capability to misrepresent the seller, the origin
of the goods or the product itself. Compliance blocks a tracking upload that
does not name the carrier actually holding the parcel.

## Idempotency

Shipments are keyed on `("shipment", order_reference, "outbound")` with a
unique constraint. A retried worker reuses the existing shipment instead of
buying a second label - asserted by
`test_a_second_shipment_is_not_created_on_retry`.

## Moving to a 3PL

1. Implement `FulfillmentProvider`.
2. Return the provider's real fees from `fee_schedule()` - receiving, storage,
   pick, pack, handling, outbound, return. They flow into `FULFILLMENT_COST`
   and therefore into every profit calculation automatically.
3. Register it in `build_fulfillment_provider()`.
4. Set `FULFILLMENT_MODE = EXTERNAL_3PL`.

The opportunity, order and profit engines do not change. An unimplemented mode
raises `NotImplementedError` rather than silently falling back to manual,
because fulfilling through the wrong provider would mis-state costs on every
order.
