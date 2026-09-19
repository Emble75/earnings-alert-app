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
           - NET_VAT
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

## VAT

A profit figure that ignores VAT is wrong for anyone on the standard scheme,
and wrong by enough to reverse the verdict. Same product, same prices, the
only difference being the tax position:

| | Net profit | Margin | Verdict |
| --- | --- | --- | --- |
| Small business (§19 UStG) | 57.93 | 18.16% | **Worth doing** |
| Standard scheme, VAT reclaimed on the purchase | 39.34 | 12.33% | **Not worth it** |

*(Sony WH-1000XM5: buy 199.00, sell 319.00, with the default fee model,
postage, packaging, return exposure and risk reserve.)*

The system does not guess which applies. `vat_scheme` defaults to
`SMALL_BUSINESS`, which charges nothing and reclaims nothing - the arithmetic
the engine used before VAT existed in it - so an operator who has never opened
Settings is never shown a number that silently assumes a tax position they are
not in.

### How it is computed

VAT contained in a gross amount is `gross x rate / (100 + rate)`. At 19% that
is 19/119, **not** 19/100: the prices entered are what is actually paid, not
net prices. Computing it the other way overstates the tax by a fifth, and it
is the most common way to get this wrong.

Input VAT is deducted only where the operator has ticked it, because the
reclaim depends on holding an invoice that permits it:

| Setting | When to turn it on |
| --- | --- |
| `reclaim_input_vat_on_purchase` | Amazon issues an invoice stating the VAT |
| `reclaim_input_vat_on_fees` | Your eBay invoices show German VAT (they often do not - reverse charge) |
| `reclaim_input_vat_on_costs` | Postage and packaging bought with a VAT invoice |

All three default to off. An unticked box costs profit, which is the safe
direction for a system whose job is to reject false positives - and the
breakdown says so in as many words rather than leaving it to be discovered.

Two conservatisms, both stated in the breakdown:

- The rate is validated as a percentage. `0.19` and `1.19` are rejected, since
  no real VAT rate sits between 0 and 3 and both are ways this gets typed
  wrong - silently, on every order.
- On a return the goods are written off gross of input VAT. Some of that tax
  is in practice still deductible, so the modelled return cost is the
  pessimistic one.

`net_vat` is signed and stored per calculation. It is negative when more input
tax was deductible than was charged on the sale, which is a refund, and the
interface shows it as a credit rather than a cost.

**None of this is tax advice.** It is arithmetic applied to an answer the
operator supplies.

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
