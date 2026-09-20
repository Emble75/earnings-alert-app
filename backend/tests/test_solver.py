"""The engine, run backwards: what may I pay and still clear every threshold?

Every expectation here is checked against the forward engine, so the two can
never disagree: a claimed maximum must pass, and one cent more must fail.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from app.core.money import Money
from app.models.enums import VatScheme
from app.profit.engine import ProfitInputs, calculate_profit, inputs_from_config
from app.profit.solver import clears, max_source_price
from app.profit.vat import VatTreatment
from app.services.settings_service import BusinessConfig

EUR = "EUR"


def solve(inputs: ProfitInputs, config: BusinessConfig | None = None):
    config = config or BusinessConfig()
    return max_source_price(
        inputs,
        minimum_net_profit=config.minimum_net_profit,
        minimum_profit_margin=config.minimum_profit_margin,
    )


def at(inputs: ProfitInputs, price: Decimal):
    return calculate_profit(replace(inputs, source_unit_price=Money(price, EUR)))


def bare(sale: str = "319.00", **overrides) -> ProfitInputs:
    """Sale price and nothing else, so the maths is inspectable by hand."""
    return ProfitInputs(
        sale_price=Money(sale, EUR), source_unit_price=Money("0", EUR), **overrides
    )


# -- the defining property ---------------------------------------------------
def test_the_answer_passes_and_one_cent_more_fails():
    """The only property that matters: it is the *maximum*.

    Checked against the forward engine rather than a recomputed formula, so a
    change to any cost cannot quietly invalidate this.
    """
    config = BusinessConfig()
    inputs = inputs_from_config(
        config, sale_price=Money("319.00", EUR), source_unit_price=Money("0", EUR)
    )
    answer = solve(inputs, config)
    assert answer.is_possible

    price = answer.max_source_price.amount
    passes = at(inputs, price)
    fails = at(inputs, price + Decimal("0.01"))

    kwargs = {
        "minimum_net_profit": config.minimum_net_profit,
        "minimum_profit_margin": config.minimum_profit_margin,
    }
    assert clears(passes, **kwargs) is True
    assert clears(fails, **kwargs) is False


@pytest.mark.parametrize("sale", ["45.00", "99.99", "319.00", "1250.00"])
def test_the_maximum_holds_at_every_price_point(sale):
    config = BusinessConfig()
    inputs = inputs_from_config(
        config, sale_price=Money(sale, EUR), source_unit_price=Money("0", EUR)
    )
    answer = solve(inputs, config)
    if not answer.is_possible:
        # Then even free must genuinely fail - not merely be reported as such.
        assert not clears(
            at(inputs, Decimal("0")),
            minimum_net_profit=config.minimum_net_profit,
            minimum_profit_margin=config.minimum_profit_margin,
        )
        return
    kwargs = {
        "minimum_net_profit": config.minimum_net_profit,
        "minimum_profit_margin": config.minimum_profit_margin,
    }
    assert clears(at(inputs, answer.max_source_price.amount), **kwargs)
    assert not clears(at(inputs, answer.max_source_price.amount + Decimal("0.01")), **kwargs)


def test_the_returned_breakdown_is_the_one_at_that_price():
    """So the operator can check the answer instead of trusting it."""
    inputs = bare()
    answer = solve(inputs)
    assert answer.at_max.source_purchase_cost == answer.max_source_price


# -- the impossible case ------------------------------------------------------
def test_a_sale_too_small_to_carry_its_costs_is_reported_as_impossible():
    """Not a maximum of zero, which would read as "free and it works"."""
    config = BusinessConfig()
    inputs = inputs_from_config(
        config, sale_price=Money("12.00", EUR), source_unit_price=Money("0", EUR)
    )
    answer = solve(inputs, config)

    assert answer.is_possible is False
    assert answer.max_source_price is None
    assert "at any purchase price" in answer.impossible_reason


def test_free_goods_that_do_work_give_a_maximum_not_an_error():
    inputs = bare("60.00")
    answer = solve(inputs)
    assert answer.is_possible
    assert answer.max_source_price.is_positive()


# -- it answers with the operator's real cost model --------------------------
def test_higher_costs_lower_the_price_you_can_pay():
    cheap = solve(bare(outbound_shipping_cost=Money("0", EUR)))
    dear = solve(bare(outbound_shipping_cost=Money("9.99", EUR)))
    assert dear.max_source_price < cheap.max_source_price


def test_the_tax_position_lowers_it_too():
    """The same listing supports a much lower buy price under VAT - which is
    the whole reason the scheme is a setting rather than an assumption."""
    small = solve(bare())
    standard = solve(bare(vat=VatTreatment(scheme=VatScheme.STANDARD)))
    assert standard.max_source_price < small.max_source_price


def test_a_stricter_threshold_lowers_it():
    inputs = bare()
    lenient = max_source_price(
        inputs, minimum_net_profit=Decimal("20"), minimum_profit_margin=Decimal("0.15")
    )
    strict = max_source_price(
        inputs, minimum_net_profit=Decimal("50"), minimum_profit_margin=Decimal("0.30")
    )
    assert strict.max_source_price < lenient.max_source_price


def test_whichever_threshold_binds_is_the_one_that_decides():
    """With a high margin floor the margin binds; with a high profit floor the
    profit does. Both must be respected, not just the first."""
    inputs = bare()
    margin_bound = max_source_price(
        inputs, minimum_net_profit=Decimal("1"), minimum_profit_margin=Decimal("0.40")
    )
    profit_bound = max_source_price(
        inputs, minimum_net_profit=Decimal("150"), minimum_profit_margin=Decimal("0.01")
    )
    assert margin_bound.at_max.profit_margin >= Decimal("0.40")
    assert profit_bound.at_max.net_profit.amount >= Decimal("150")


def test_the_price_is_per_unit_when_buying_several():
    single = solve(bare())
    triple = solve(bare(quantity=3))
    # Three units share one sale price, so each may cost around a third.
    assert triple.max_source_price < single.max_source_price
    assert triple.at_max.source_purchase_cost.amount == triple.max_source_price.amount * 3


# -- exactness ---------------------------------------------------------------
def test_the_answer_is_a_whole_number_of_cents():
    answer = solve(bare())
    assert answer.max_source_price.amount == answer.max_source_price.amount.quantize(
        Decimal("0.01")
    )


def test_the_answer_never_exceeds_the_sale_price():
    """Paying more than it sells for cannot leave a profit."""
    for sale in ("30.00", "319.00", "2000.00"):
        answer = solve(bare(sale))
        if answer.is_possible:
            assert answer.max_source_price.amount <= Decimal(sale)
