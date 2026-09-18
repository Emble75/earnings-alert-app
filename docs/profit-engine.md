# Profit engine

## The rule

```
NET_PROFIT = SALE_REVENUE
           - SOURCE_PURCHASE_COST
           - SOURCE_SHIPPING_COST
           - MARKETPLACE_FEES
           - PAYMENT_FEES
           - FULFILLMENT_COST
           - OUTBOUND_SHIPPING_COST
           - PACKAGING_COST
           - EXPECTED_RETURN_COST
           - RISK_RESERVE
           - OTHER_ACTUAL_VARIABLE_COSTS
```

Every component is stored and displayed separately. Nothing is netted off
silently, and the components always reconcile to the total exactly - a test
asserts it.

## Worked example

The case from the specification, reproduced exactly by
`tests/test_profit_engine.py::test_critical_case_yields_exactly_twenty_five_euro`:

```
eBay sale price:                    €159.99
Amazon purchase price:             -€100.00
eBay fees:                          -€24.00
Payment fees:                        -€0.00
Amazon -> operator shipping:         -€0.00
Fulfillment cost:                    -€0.00
Packaging:                           -€1.00
Operator -> customer shipping:       -€5.99
Expected return cost:                -€0.00
Risk reserve:                        -€4.00
------------------------------------------
Total costs:                        €134.99
Expected net profit:                 €25.00
Margin:                               15.63%
```

## No labour cost. At all.

Version 1 fulfils by hand: the operator receives the Amazon parcel, checks the
item, repacks it if needed and posts it. That takes time. It does **not** take
cash, and the model does not pretend otherwise.

There is no field anywhere in this engine for a labour rate, an hourly wage, a
handling-time charge, a warehouse allocation, an internal transfer price or an
opportunity cost, and `test_no_labour_or_handling_cost_exists_in_the_model`
fails if one is ever added. `FULFILLMENT_COST` is `0` under manual fulfilment
and only becomes non-zero when an external provider charges a real fee.

If the operator spends twenty minutes on a parcel, the net cash profit is
still €25.00. The system reports one profit number, and it is a cash number.

The operational exposure that manual fulfilment *does* create - one person has
to be available to ship - is scored by the risk engine as `fulfillment_risk`.
That is the honest place for it: it affects the probability of things going
wrong, not the cash that leaves the account.

## Fees

Fee schedules are modelled as **marginal percentage bands** plus fixed
components, because that is how real final-value fees work:

```python
FeeModel(
    bands=[FeeBand(up_to="990", percent="12.5"), FeeBand(percent="2.35")],
    fixed_per_order="0.35",
    fixed_per_item="0",
    additional_percent="0",       # e.g. a regulatory operating fee
    includes_shipping_in_base=True,
    cap=None,
)
```

On a €1500 order: `990 × 12.5% + 510 × 2.35% + 0.35 = €136.09`.

A single hardcoded percentage would misprice every order above a band
boundary. Bands are summed in unrounded `Decimal` and the total is quantised
once; rounding each band separately would produce sub-cent drift that matches
no marketplace invoice.

The shipped default is an eBay-*shaped* placeholder, not a fact about your
account. **Set the schedule your own account and category actually incur.**

The payment fee model defaults to zero, because on managed-payments
marketplaces the payment fee is already inside the final value fee. Charging
it twice would understate profit and hide real opportunities.

## Expected return cost

A return does not just cost postage - it costs the margin you did not earn.
With return probability `p`:

```
E[profit] = (1-p)·gross_profit + p·(−loss_given_return)
          = gross_profit − p·(gross_profit + loss_given_return)
```

so the expected return cost is `p · (gross_profit + loss_given_return)`, where

```
loss_given_return = source_cost × (1 − recovery_rate)
                  + source_shipping + outbound_shipping + packaging
                  + return_shipping + non_refundable_fees
```

This is an exact expected value, computed after the gross profit is known.

## Risk reserve

A cash haircut, `risk_reserve_percent` of gross revenue, scaled by the
assessed risk score: `reserve = base% × (1 + score/50)`. A zero-risk
opportunity carries the base reserve; a 100-score one carries three times it.

The reserve is money held back, not money spent. When nothing goes wrong it is
released, which is the main reason realized profit usually *exceeds* the
approved expectation.

## Capital and ROI

```
CAPITAL_REQUIRED = source cost + source shipping + outbound shipping
                 + packaging + fulfilment cost + other variable costs
PROFIT_MARGIN    = NET_PROFIT / (sale price + buyer-paid shipping)
ROI              = NET_PROFIT / CAPITAL_REQUIRED
```

Marketplace and payment fees are withheld from the payout rather than paid up
front, so they are not capital.

**A deviation worth stating:** the specification's illustrative opportunity
card shows ROI as 25.00% on a €25.00 profit, i.e. against the €100.00 source
cost alone. This implementation divides by the **full cash outlay** (€106.99 in
the worked example, giving 23.37%), because packaging and outbound postage are
money that genuinely leaves the account before the payout arrives. The same
figure is used for the capital limits, so exposure and ROI are consistent. If
you prefer the source-cost-only convention, change `capital_required` in
`app/profit/engine.py`; be aware it will also loosen the capital limits.

## Scenarios

| Scenario | Purpose | Deltas |
| --- | --- | --- |
| `BEST_CASE` | The upside | Sale price uplift, no returns, reserve released |
| `BASE_CASE` | **The decision metric** | Observed inputs, unmodified |
| `WORST_CASE` | Can we survive it? | Lower sale price, higher source price, higher shipping on both legs, extra fees, elevated return rate |

Every delta is stored as text alongside the calculation, so the operator can
inspect exactly how a scenario was produced rather than trusting the label.

## Realized profit

After completion, realized figures are computed from what actually happened -
the source order's real total, the real shipping paid, the real return costs -
and compared against the approved expectation. The variance is stored on the
order and aggregated in `/analytics`.
