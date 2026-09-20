"""Working the profit engine backwards.

Discovery starts on eBay, because eBay is where the demand is: a listing that
sells at a price is a fact, whereas a cheap Amazon offer for something nobody
buys is not an opportunity. That leaves one question per candidate - *what
would I have to pay on Amazon for this to be worth doing?*

This module answers it exactly. Given a sale price and the configured cost
model, it finds the highest source price at which the deal still clears every
threshold: the minimum net profit and the minimum margin, with fees, postage,
packaging, return exposure, the risk reserve and VAT all applied.

It does this by running the real engine, not by re-deriving the formula.
A second implementation of the arithmetic would be a second thing to keep
correct, and the two would drift. Net profit falls monotonically as the source
price rises, so a binary search over whole cents converges on the exact
threshold in about twenty evaluations - and the answer is the engine's own,
by construction.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal

from app.core.money import Money
from app.profit.engine import ProfitBreakdown, ProfitInputs, calculate_profit

#: One cent, the resolution of the answer.
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class BreakEven:
    """The most you could pay, and what happens if you pay it."""

    #: Highest source unit price that still clears every threshold, or None
    #: when no price does - including free.
    max_source_price: Money | None
    #: The breakdown at that price, so the answer can be checked.
    at_max: ProfitBreakdown | None
    #: Why it is impossible, when it is.
    impossible_reason: str | None = None

    @property
    def is_possible(self) -> bool:
        return self.max_source_price is not None


def clears(
    breakdown: ProfitBreakdown,
    *,
    minimum_net_profit: Decimal,
    minimum_profit_margin: Decimal,
) -> bool:
    """Both profitability thresholds, applied exactly as elsewhere."""
    if breakdown.net_profit.amount < minimum_net_profit:
        return False
    if breakdown.profit_margin is None:
        return False
    return breakdown.profit_margin >= minimum_profit_margin


def max_source_price(
    inputs: ProfitInputs,
    *,
    minimum_net_profit: Decimal,
    minimum_profit_margin: Decimal,
) -> BreakEven:
    """The highest source unit price that still clears both thresholds.

    ``inputs.source_unit_price`` is ignored - it is the unknown being solved
    for. Everything else in ``inputs`` is held fixed, so the answer reflects
    the operator's real cost model rather than a simplified one.
    """
    currency = inputs.currency

    def evaluate(price: Decimal) -> ProfitBreakdown:
        return calculate_profit(replace(inputs, source_unit_price=Money(price, currency)))

    # A free product is the best case. If that fails, no price succeeds: the
    # sale price cannot carry the fees and costs, whatever the goods cost.
    free = evaluate(Decimal("0"))
    if not clears(
        free,
        minimum_net_profit=minimum_net_profit,
        minimum_profit_margin=minimum_profit_margin,
    ):
        shortfall = free.net_profit.amount
        return BreakEven(
            max_source_price=None,
            at_max=None,
            impossible_reason=(
                "this cannot clear the thresholds at any purchase price: even free, "
                f"the sale leaves {shortfall} after fees and costs, against a "
                f"{minimum_net_profit} minimum"
            ),
        )

    # Upper bound: the sale price itself. Paying more than the item sells for
    # can never leave a profit, so the answer is below it.
    low = Decimal("0")
    high = (inputs.sale_price.amount / inputs.quantity).quantize(_CENT)

    # Binary search on whole cents. `low` always clears, `high` never does,
    # and the loop narrows the gap until they are adjacent.
    if clears(
        evaluate(high),
        minimum_net_profit=minimum_net_profit,
        minimum_profit_margin=minimum_profit_margin,
    ):
        # Only reachable with a cost model that pays us to buy; keep the
        # invariant honest rather than returning a price above the sale.
        return BreakEven(max_source_price=Money(high, currency), at_max=evaluate(high))

    while high - low > _CENT:
        middle = ((low + high) / 2).quantize(_CENT)
        if middle <= low or middle >= high:  # guards against a stuck midpoint
            break
        if clears(
            evaluate(middle),
            minimum_net_profit=minimum_net_profit,
            minimum_profit_margin=minimum_profit_margin,
        ):
            low = middle
        else:
            high = middle

    return BreakEven(max_source_price=Money(low, currency), at_max=evaluate(low))
