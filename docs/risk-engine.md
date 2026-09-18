# Risk engine

A deterministic weighted sum of twelve factors, producing a score from 0 (very
low operational risk) to 100 (extremely high), a level, a per-factor
explanation, and a list of hard blockers.

## Two rules make it trustworthy

**Determinism.** No model, no sampling, no clock-dependent behaviour beyond
the data ages passed in. The same `RiskInputs` always produce the same score -
`test_the_same_inputs_always_produce_the_same_score` runs it 25 times and
asserts a single result. That is what `risk_model_version` promises: a stored
decision can be reproduced exactly.

**Blockers override the number.** A factor may raise a hard blocker. A blocked
assessment can never be actioned, however low the weighted score happens to
be. `within(maximum)` requires both no blockers *and* a score under the limit.

An LLM may narrate this output. It may not produce it.

## Factors and weights

| Factor | Weight | Blocks when |
| --- | --- | --- |
| `product_match_risk` | 0.18 | Match is BLOCKED/UNKNOWN/REVIEW, or below the confidence minimum |
| `inventory_risk` | 0.14 | Out of stock, stock UNKNOWN (configurable), stale, or insufficient quantity |
| `delivery_risk` | 0.12 | Source delivery plus handling exceeds the buyer's expectation, or no estimate |
| `source_price_risk` | 0.10 | No observation, or older than `MAX_PRICE_AGE` |
| `target_price_risk` | 0.10 | Target/source ratio at or above the anomaly threshold |
| `competition_risk` | 0.07 | — |
| `return_risk` | 0.07 | — |
| `price_volatility_risk` | 0.06 | — |
| `capital_risk` | 0.06 | Over the per-order limit, or exposure over the total limit |
| `fulfillment_risk` | 0.05 | — |
| `compliance_risk` | 0.03 | Compliance returned BLOCK or REJECT |
| `operational_risk` | 0.02 | — |

Levels: `LOW` <20, `MODERATE` <40, `ELEVATED` <60, `HIGH` <80, `CRITICAL` ≥80.
Default ceiling: `MAXIMUM_RISK_SCORE = 35`.

## Why the price anomaly is a blocker

A target price 2.5× the source price (configurable) produces a **blocker**,
not a deduction.

During development the demo catalogue's deliberate trap - a watch at €139
against a €479 observed listing - scored 24/100 when the anomaly was only a
weighted deduction, and would have been presented to the operator as a €141
opportunity at acceptable risk. A gap that size is almost never free money; it
is a variant, a bundle, a used unit, a regional model, a wrong pack size or a
stale observation. Diluting that signal through a 0.10 weight was exactly the
false positive the system exists to prevent, so it now blocks and goes to
review.

## Explanation

Every factor returns a sentence. The stored assessment keeps all twelve,
ordered by contribution:

```
Risk Score: 14 (LOW)

Reasons:
- delivery risk: arrives in 3d against a 5d expectation, 2d of slack (observed speed FAST) (16/100)
- fulfillment risk: manual fulfilment depends on the operator being available to ship (25/100)
- inventory risk: stock status IN_STOCK (10/100)
- capital risk: 27% of the per-order capital limit (16/100)
- product match risk: identifier-verified match at 99 confidence (6/100)
...
```

## Missing data raises risk

An empty `RiskInputs` scores above 50 and blocks. Absent information is never
treated as favourable - that is the single most important behaviour in the
engine, and it is tested directly.
