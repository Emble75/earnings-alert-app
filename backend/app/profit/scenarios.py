"""Best / base / worst case profit scenarios.

The base case is the decision metric.  The worst case exists to answer one
question before the operator commits cash: *if the things that usually go
wrong go wrong, do I still come out whole?*  Each scenario records the exact
deltas that produced it, so the operator can inspect the arithmetic rather
than trust a label.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal

from app.core.money import Money
from app.models.enums import ScenarioType
from app.profit.engine import ProfitBreakdown, ProfitInputs, calculate_profit
from app.services.settings_service import BusinessConfig


@dataclass(frozen=True)
class ScenarioSet:
    best_case: ProfitBreakdown
    base_case: ProfitBreakdown
    worst_case: ProfitBreakdown
    deltas: dict[str, list[str]]

    def to_dict(self) -> dict:
        return {
            "best_case": self.best_case.to_dict(),
            "base_case": self.base_case.to_dict(),
            "worst_case": self.worst_case.to_dict(),
            "deltas": self.deltas,
        }


def _scale(amount: Money, percent: Decimal) -> Money:
    """Increase ``amount`` by ``percent`` percentage points."""
    return Money(amount.amount * (Decimal(100) + percent) / Decimal(100), amount.currency)


def build_scenarios(base_inputs: ProfitInputs, config: BusinessConfig) -> ScenarioSet:
    """Compute all three scenarios from one set of base inputs."""
    currency = base_inputs.currency
    base = calculate_profit(replace(base_inputs, scenario=ScenarioType.BASE_CASE))

    # -- worst case ---------------------------------------------------------
    worst_deltas: list[str] = []
    worst_sale = _scale(base_inputs.sale_price, -config.worst_case_sale_price_drop_percent)
    worst_deltas.append(
        f"Achievable sale price {config.worst_case_sale_price_drop_percent}% lower "
        f"({base_inputs.sale_price} -> {worst_sale})"
    )
    worst_source = _scale(base_inputs.source_unit_price, config.worst_case_source_price_rise_percent)
    worst_deltas.append(
        f"Source price {config.worst_case_source_price_rise_percent}% higher "
        f"({base_inputs.source_unit_price} -> {worst_source})"
    )
    base_outbound = base_inputs.outbound_shipping_cost or Money.zero(currency)
    worst_outbound = _scale(base_outbound, config.worst_case_shipping_increase_percent)
    base_source_shipping = base_inputs.source_shipping_cost or Money.zero(currency)
    worst_source_shipping = _scale(base_source_shipping, config.worst_case_shipping_increase_percent)
    worst_deltas.append(
        f"Shipping {config.worst_case_shipping_increase_percent}% higher on both legs"
    )
    extra_fees = Money(
        worst_sale.amount * config.worst_case_extra_fees_percent / Decimal(100), currency
    )
    worst_deltas.append(
        f"Additional marketplace fees of {config.worst_case_extra_fees_percent}% of revenue ({extra_fees})"
    )
    worst_deltas.append(f"Return probability raised to {config.worst_case_return_rate}")

    worst_inputs = replace(
        base_inputs,
        scenario=ScenarioType.WORST_CASE,
        sale_price=worst_sale,
        source_unit_price=worst_source,
        outbound_shipping_cost=worst_outbound,
        source_shipping_cost=worst_source_shipping,
        other_variable_costs=(base_inputs.other_variable_costs or Money.zero(currency)) + extra_fees,
        expected_return_rate=config.worst_case_return_rate,
    )
    worst = calculate_profit(worst_inputs)

    # -- best case ----------------------------------------------------------
    best_deltas: list[str] = []
    best_sale = _scale(base_inputs.sale_price, config.best_case_sale_price_uplift_percent)
    best_deltas.append(
        f"Sale price {config.best_case_sale_price_uplift_percent}% higher "
        f"({base_inputs.sale_price} -> {best_sale})"
    )
    best_deltas.append(f"Return probability {config.best_case_return_rate}")
    best_deltas.append("Risk reserve released (nothing went wrong)")
    best_inputs = replace(
        base_inputs,
        scenario=ScenarioType.BEST_CASE,
        sale_price=best_sale,
        expected_return_rate=config.best_case_return_rate,
        risk_reserve_percent=Decimal("0"),
        risk_reserve_override=Money.zero(currency),
    )
    best = calculate_profit(best_inputs)

    return ScenarioSet(
        best_case=best,
        base_case=base,
        worst_case=worst,
        deltas={
            "best_case": best_deltas,
            "base_case": ["Observed inputs, unmodified"],
            "worst_case": worst_deltas,
        },
    )
