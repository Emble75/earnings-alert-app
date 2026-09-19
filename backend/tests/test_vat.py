"""VAT: the correction that decides whether a deal is a deal.

The numbers in this file are arithmetic, checked by hand. They are not tax
advice, and the system never picks a scheme on the operator's behalf.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.money import Money
from app.models.enums import ScenarioType, VatScheme
from app.profit.engine import ProfitInputs, calculate_profit
from app.profit.vat import VatTreatment, add_vat, included_vat
from app.services.settings_service import BusinessConfig

EUR = "EUR"


def bare(**overrides) -> ProfitInputs:
    """A sale with no costs but the goods, so the VAT is the only variable."""
    return ProfitInputs(
        sale_price=Money("319.00", EUR),
        source_unit_price=Money("199.00", EUR),
        scenario=ScenarioType.BASE_CASE,
        **overrides,
    )


# -- the arithmetic ---------------------------------------------------------
def test_vat_is_the_fraction_inside_the_price_not_a_percent_on_top():
    """19/119, never 19/100. The second is the classic error and overstates
    the tax by a fifth."""
    assert included_vat(Money("319.00", EUR), Decimal("19")) == Money("50.93", EUR)
    assert included_vat(Money("119.00", EUR), Decimal("19")) == Money("19.00", EUR)
    assert included_vat(Money("100.00", EUR), Decimal("19")) != Money("19.00", EUR)


def test_adding_and_extracting_vat_are_inverses():
    net = Money("100.00", EUR)
    gross = add_vat(net, Decimal("19"))
    assert gross == Money("119.00", EUR)
    assert gross - included_vat(gross, Decimal("19")) == net


def test_a_zero_rate_and_a_zero_amount_produce_no_vat():
    assert included_vat(Money("319.00", EUR), Decimal("0")).is_zero()
    assert included_vat(Money("0", EUR), Decimal("19")).is_zero()
    assert add_vat(Money("100.00", EUR), Decimal("0")) == Money("100.00", EUR)


def test_rounding_is_half_up_to_the_cent():
    # 0.07 * 19/119 = 0.011764..., which is a cent after rounding.
    assert included_vat(Money("0.07", EUR), Decimal("19")) == Money("0.01", EUR)
    assert isinstance(included_vat(Money("319.00", EUR), Decimal("19")).amount, Decimal)


# -- the three cases that differ ---------------------------------------------
def test_the_small_business_scheme_changes_nothing():
    """The default. No VAT charged, none reclaimed, gross in and gross out -
    which is the arithmetic the rest of the system already assumed."""
    result = calculate_profit(bare())
    assert result.net_vat.is_zero()
    assert result.net_profit == Money("120.00", EUR)
    assert result.vat_lines == []


def test_the_standard_scheme_without_an_invoice_is_the_expensive_case():
    """No purchase invoice means no reclaim: the full gross purchase price is
    a cost, while a fifth of the sale still goes to the tax office."""
    result = calculate_profit(
        bare(vat=VatTreatment(scheme=VatScheme.STANDARD, rate=Decimal("19")))
    )
    assert result.net_vat == Money("50.93", EUR)
    assert result.net_profit == Money("69.07", EUR)


def test_the_standard_scheme_with_an_invoice_reclaims_the_input_tax():
    result = calculate_profit(
        bare(
            vat=VatTreatment(
                scheme=VatScheme.STANDARD, rate=Decimal("19"), reclaim_on_purchase=True
            )
        )
    )
    # 50.93 due on the sale, 31.77 reclaimed on the purchase.
    assert result.net_vat == Money("19.16", EUR)
    assert result.net_profit == Money("100.84", EUR)


def test_the_tax_position_can_flip_the_verdict():
    """Why this is worth a settings field rather than a footnote: the same
    order clears the 20 EUR threshold under one scheme and fails under the
    other. Without this, half the verdicts on thin deals are wrong."""
    threshold = BusinessConfig().minimum_net_profit
    deal = {"sale_price": Money("100.00", EUR), "source_unit_price": Money("72.00", EUR)}

    small = calculate_profit(ProfitInputs(**deal)).net_profit
    standard = calculate_profit(
        ProfitInputs(**deal, vat=VatTreatment(scheme=VatScheme.STANDARD))
    ).net_profit

    assert small == Money("28.00", EUR)
    assert standard == Money("12.03", EUR)
    assert small.amount >= threshold > standard.amount


# -- the breakdown stays checkable -------------------------------------------
def test_both_halves_of_the_vat_are_shown_separately():
    result = calculate_profit(
        bare(vat=VatTreatment(scheme=VatScheme.STANDARD, reclaim_on_purchase=True))
    )
    labels = [line["label"] for line in result.vat_lines]
    assert any("due on the sale" in label for label in labels)
    assert any("reclaimed on the purchase" in label for label in labels)
    # The reclaim is shown as what it is: a negative amount.
    reclaim = next(line for line in result.vat_lines if "reclaimed" in line["label"])
    assert reclaim["amount"].startswith("-")
    # And the two halves add up to the single net line.
    assert sum(Decimal(line["amount"]) for line in result.vat_lines) == result.net_vat.amount


def test_the_tax_position_is_stated_in_the_assumptions():
    result = calculate_profit(bare(vat=VatTreatment(scheme=VatScheme.STANDARD)))
    joined = " ".join(result.assumptions)
    assert "Standard scheme" in joined
    # And it says plainly that the reclaim is switched off.
    assert "costing you real margin" in joined


def test_a_small_business_breakdown_does_not_talk_about_vat():
    """Noise on every line for a setting that does not apply to you."""
    result = calculate_profit(bare())
    assert not any("VAT" in assumption for assumption in result.assumptions)


def test_the_net_vat_line_is_part_of_total_costs():
    result = calculate_profit(bare(vat=VatTreatment(scheme=VatScheme.STANDARD)))
    lines = dict(result.cost_lines())
    assert lines["VAT (net of input tax)"] == result.net_vat
    assert sum((amount for amount in lines.values()), Money.zero(EUR)) == result.total_costs


# -- reclaim switches -------------------------------------------------------
def test_each_reclaim_switch_is_independent():
    inputs = {
        "sale_price": Money("319.00", EUR),
        "source_unit_price": Money("199.00", EUR),
        "marketplace_fee_override": Money("40.00", EUR),
        "outbound_shipping_cost": Money("5.99", EUR),
        "packaging_cost": Money("1.00", EUR),
    }
    standard = VatScheme.STANDARD
    none = calculate_profit(ProfitInputs(**inputs, vat=VatTreatment(scheme=standard)))
    fees = calculate_profit(
        ProfitInputs(**inputs, vat=VatTreatment(scheme=standard, reclaim_on_fees=True))
    )
    costs = calculate_profit(
        ProfitInputs(**inputs, vat=VatTreatment(scheme=standard, reclaim_on_costs=True))
    )
    # 40.00 gross fees contain 6.39; 6.99 of shipping and packaging contain 1.12.
    assert (none.net_vat - fees.net_vat) == Money("6.39", EUR)
    assert (none.net_vat - costs.net_vat) == Money("1.12", EUR)


def test_nothing_is_reclaimed_under_the_small_business_scheme():
    """The switches are meaningless there, and must not fire by accident."""
    result = calculate_profit(
        bare(
            vat=VatTreatment(
                scheme=VatScheme.SMALL_BUSINESS,
                reclaim_on_purchase=True,
                reclaim_on_fees=True,
                reclaim_on_costs=True,
            )
        )
    )
    assert result.net_vat.is_zero()
    assert result.net_profit == Money("120.00", EUR)


# -- it flows through the configured model -----------------------------------
def test_the_configured_scheme_reaches_the_engine():
    from app.profit.engine import inputs_from_config

    config = BusinessConfig(
        vat_scheme=VatScheme.STANDARD,
        vat_rate_percent=Decimal("19"),
        reclaim_input_vat_on_purchase=True,
    )
    inputs = inputs_from_config(
        config, sale_price=Money("319.00", EUR), source_unit_price=Money("199.00", EUR)
    )
    assert inputs.vat.scheme is VatScheme.STANDARD
    assert inputs.vat.reclaim_on_purchase is True


def test_the_default_configuration_is_the_one_that_assumes_nothing():
    config = BusinessConfig()
    assert config.vat_scheme is VatScheme.SMALL_BUSINESS
    assert config.reclaim_input_vat_on_purchase is False
    assert config.vat_treatment().charges_vat_on_sales is False


@pytest.mark.parametrize("bad", [Decimal("0.19"), Decimal("1.19"), Decimal("-1"), Decimal("119")])
def test_a_rate_that_is_not_a_percentage_is_rejected(bad):
    """0.19 and 1.19 are the two ways this gets entered wrong, and both would
    silently produce a wrong profit on every order."""
    with pytest.raises(ValueError):
        BusinessConfig(vat_rate_percent=bad)
