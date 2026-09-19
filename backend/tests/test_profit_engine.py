"""Profit engine tests.

The first test is the one named in the specification: it must produce exactly
25.00 EUR, using Decimal arithmetic end to end.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.money import Money
from app.models.enums import ScenarioType
from app.profit.engine import ProfitInputs, calculate_profit, inputs_from_config
from app.profit.fees import calculate_fees
from app.profit.scenarios import build_scenarios
from app.services.settings_service import BusinessConfig, FeeBand, FeeModel


def _spec_inputs() -> ProfitInputs:
    """The worked example from the specification.

    eBay sale 159.99, Amazon purchase 100.00, eBay fees 24.00, payment 0.00,
    inbound shipping 0.00, packaging 1.00, outbound shipping 5.99, risk
    reserve 4.00  ->  expected net profit 25.00.
    """
    return ProfitInputs(
        sale_price=Money("159.99"),
        source_unit_price=Money("100.00"),
        marketplace_fee_override=Money("24.00"),
        payment_fee_override=Money("0.00"),
        source_shipping_cost=Money("0.00"),
        packaging_cost=Money("1.00"),
        outbound_shipping_cost=Money("5.99"),
        fulfillment_cost=Money("0.00"),
        risk_reserve_override=Money("4.00"),
        expected_return_rate=Decimal("0"),
    )


def test_critical_case_yields_exactly_twenty_five_euro():
    result = calculate_profit(_spec_inputs())

    assert result.sale_revenue == Money("159.99")
    assert result.source_purchase_cost == Money("100.00")
    assert result.marketplace_fees == Money("24.00")
    assert result.payment_fees == Money("0.00")
    assert result.source_shipping_cost == Money("0.00")
    assert result.packaging_cost == Money("1.00")
    assert result.outbound_shipping_cost == Money("5.99")
    assert result.risk_reserve == Money("4.00")
    assert result.total_costs == Money("134.99")
    assert result.net_profit == Money("25.00")
    assert result.net_profit.amount == Decimal("25.00")
    assert isinstance(result.net_profit.amount, Decimal)


def test_critical_case_margin_and_roi():
    result = calculate_profit(_spec_inputs())
    # 25.00 / 159.99 = 0.15626... -> 0.1563 at four decimal places
    assert result.profit_margin == Decimal("0.1563")
    # Capital is the full cash outlay: 100.00 + 1.00 + 5.99
    assert result.capital_required == Money("106.99")
    assert result.roi == Decimal("0.2337")


def test_fees_are_computed_from_the_model_when_no_override_is_given():
    result = calculate_profit(
        ProfitInputs(
            sale_price=Money("159.99"),
            source_unit_price=Money("100.00"),
            marketplace_fee_model=FeeModel(bands=[FeeBand(percent=Decimal("15"))]),
            packaging_cost=Money("1.00"),
            outbound_shipping_cost=Money("5.99"),
            risk_reserve_override=Money("4.00"),
        )
    )
    # 15 % of 159.99 is 23.9985, which rounds half-up to 24.00
    assert result.marketplace_fees == Money("24.00")
    assert result.net_profit == Money("25.00")


def test_no_labour_or_handling_cost_exists_in_the_model():
    """Manual fulfilment costs the operator time, not cash.

    The model must have no field that prices that time, and fulfilment cost
    must default to zero.
    """
    result = calculate_profit(_spec_inputs())
    assert result.fulfillment_cost == Money("0.00")

    forbidden = {"labor", "labour", "wage", "handling_time", "hourly", "opportunity_cost", "salary"}
    fields = set(result.to_dict()["costs"])
    assert not any(any(word in field for word in forbidden) for field in fields)
    assert any("no external fee" in note for note in result.assumptions)


def test_every_cost_component_is_reported_separately():
    result = calculate_profit(_spec_inputs())
    labels = [label for label, _ in result.cost_lines()]
    assert labels == [
        "Source purchase cost",
        "Source -> operator shipping",
        "Marketplace fees",
        "Payment fees",
        "Fulfillment cost",
        "Operator -> customer shipping",
        "Packaging",
        "Expected return cost",
        "Risk reserve",
        "Other variable costs",
        "VAT (net of input tax)",
    ]
    # The components must reconcile to the total exactly.
    total = sum((amount.amount for _, amount in result.cost_lines()), Decimal("0"))
    assert total == result.total_costs.amount


def test_tiered_fee_bands_are_marginal():
    model = FeeModel(
        bands=[FeeBand(up_to=Decimal("990"), percent=Decimal("12.5")), FeeBand(percent=Decimal("2.35"))],
        fixed_per_order=Decimal("0.35"),
    )
    # 990 * 12.5 % = 123.75, (1500 - 990) * 2.35 % = 11.985, + 0.35 = 136.085
    assert calculate_fees(model, item_price=Money("1500.00")).total == Money("136.09")


def test_fee_cap_is_applied():
    model = FeeModel(bands=[FeeBand(percent=Decimal("15"))], cap=Decimal("10.00"))
    result = calculate_fees(model, item_price=Money("1000.00"))
    assert result.total == Money("10.00")
    assert result.capped is True


def test_buyer_shipping_is_part_of_the_fee_base_when_configured():
    model = FeeModel(bands=[FeeBand(percent=Decimal("10"))], includes_shipping_in_base=True)
    assert calculate_fees(
        model, item_price=Money("100.00"), buyer_shipping_paid=Money("10.00")
    ).total == Money("11.00")

    model_excl = FeeModel(bands=[FeeBand(percent=Decimal("10"))], includes_shipping_in_base=False)
    assert calculate_fees(
        model_excl, item_price=Money("100.00"), buyer_shipping_paid=Money("10.00")
    ).total == Money("10.00")


def test_expected_return_cost_prices_the_forgone_margin_too():
    """A return costs the margin we did not earn as well as the cash."""
    without = calculate_profit(_spec_inputs())
    from dataclasses import replace

    with_returns = calculate_profit(
        replace(
            _spec_inputs(),
            expected_return_rate=Decimal("0.10"),
            return_shipping_cost=Money("5.99"),
            return_value_recovery_rate=Decimal("0.60"),
        )
    )
    assert with_returns.expected_return_cost.is_positive()
    assert with_returns.net_profit < without.net_profit
    # 10 % of (gross profit 29.00 + loss given return 52.98) = 8.20
    assert with_returns.expected_return_cost == Money("8.20")


def test_return_rate_outside_zero_to_one_is_refused():
    from dataclasses import replace

    with pytest.raises(ValueError):
        calculate_profit(replace(_spec_inputs(), expected_return_rate=Decimal("1.5")))


def test_scenarios_are_ordered_and_explained():
    config = BusinessConfig()
    inputs = inputs_from_config(
        config, sale_price=Money("159.99"), source_unit_price=Money("100.00")
    )
    scenarios = build_scenarios(inputs, config)

    assert scenarios.worst_case.net_profit < scenarios.base_case.net_profit
    assert scenarios.base_case.net_profit < scenarios.best_case.net_profit
    assert scenarios.base_case.scenario is ScenarioType.BASE_CASE
    assert scenarios.deltas["worst_case"], "worst case must explain its deltas"
    assert any("lower" in d for d in scenarios.deltas["worst_case"])


def test_quantity_scales_the_source_cost():
    from dataclasses import replace

    result = calculate_profit(replace(_spec_inputs(), quantity=3))
    assert result.source_purchase_cost == Money("300.00")


def test_zero_quantity_is_refused():
    from dataclasses import replace

    with pytest.raises(ValueError):
        calculate_profit(replace(_spec_inputs(), quantity=0))
