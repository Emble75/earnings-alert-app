"""The profit engine.

Design rules, in priority order:

1. **Exactness.** Every amount is :class:`~app.core.money.Money` over
   ``Decimal``.  No floats, ever.
2. **Every cost is visible.** The breakdown lists each component separately;
   nothing is netted off silently.
3. **Cash only.** The model contains exactly the costs that leave the bank
   account.  Manual fulfilment in v1 costs the operator time, and time is not
   a cash cost: there is no labour rate, no handling charge, no warehouse
   allocation and no opportunity cost anywhere in this module.
4. **Pessimism on missing data.** Absent information is never treated as
   favourable; callers must supply costs or accept the configured defaults.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.core.money import Money, quantize_ratio
from app.models.enums import ScenarioType
from app.profit.fees import FeeResult, calculate_fees
from app.services.settings_service import BusinessConfig, FeeModel

PROFIT_MODEL_VERSION = "1.0.0"


@dataclass(frozen=True)
class ProfitInputs:
    """Everything needed to price one order. All amounts are per order."""

    sale_price: Money
    source_unit_price: Money
    quantity: int = 1
    buyer_shipping_paid: Money | None = None
    source_shipping_cost: Money | None = None
    outbound_shipping_cost: Money | None = None
    packaging_cost: Money | None = None
    fulfillment_cost: Money | None = None
    other_variable_costs: Money | None = None

    marketplace_fee_model: FeeModel | None = None
    payment_fee_model: FeeModel | None = None
    #: Actual invoiced fees, used for realized profit and for the documented
    #: scenarios where the marketplace tells us the exact amount.
    marketplace_fee_override: Money | None = None
    payment_fee_override: Money | None = None

    expected_return_rate: Decimal = Decimal("0")
    return_shipping_cost: Money | None = None
    return_value_recovery_rate: Decimal = Decimal("0")
    #: Fees the marketplace keeps even when an order is refunded.
    non_refundable_fee_on_return: Money | None = None

    risk_reserve_percent: Decimal = Decimal("0")
    risk_reserve_override: Money | None = None

    scenario: ScenarioType = ScenarioType.BASE_CASE

    @property
    def currency(self) -> str:
        return self.sale_price.currency

    def zero(self) -> Money:
        return Money.zero(self.currency)


@dataclass(frozen=True)
class ProfitBreakdown:
    """An itemised, reproducible profit calculation."""

    scenario: ScenarioType
    currency: str
    quantity: int

    sale_revenue: Money
    buyer_shipping_paid: Money

    source_purchase_cost: Money
    source_shipping_cost: Money
    marketplace_fees: Money
    payment_fees: Money
    fulfillment_cost: Money
    outbound_shipping_cost: Money
    packaging_cost: Money
    expected_return_cost: Money
    risk_reserve: Money
    other_variable_costs: Money

    total_costs: Money
    net_profit: Money
    profit_margin: Decimal | None
    roi: Decimal | None
    capital_required: Money

    fee_lines: list[dict] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    profit_model_version: str = PROFIT_MODEL_VERSION
    fee_model_version: str = "1.0.0"

    # -- presentation -------------------------------------------------------
    def cost_lines(self) -> list[tuple[str, Money]]:
        """The breakdown in display order, as shown on the approval screen."""
        return [
            ("Source purchase cost", self.source_purchase_cost),
            ("Source -> operator shipping", self.source_shipping_cost),
            ("Marketplace fees", self.marketplace_fees),
            ("Payment fees", self.payment_fees),
            ("Fulfillment cost", self.fulfillment_cost),
            ("Operator -> customer shipping", self.outbound_shipping_cost),
            ("Packaging", self.packaging_cost),
            ("Expected return cost", self.expected_return_cost),
            ("Risk reserve", self.risk_reserve),
            ("Other variable costs", self.other_variable_costs),
        ]

    def to_dict(self) -> dict:
        return {
            "scenario": self.scenario.value,
            "currency": self.currency,
            "quantity": self.quantity,
            "sale_revenue": str(self.sale_revenue.amount),
            "buyer_shipping_paid": str(self.buyer_shipping_paid.amount),
            "costs": {
                label.lower().replace(" ", "_").replace("->", "to"): str(amount.amount)
                for label, amount in self.cost_lines()
            },
            "total_costs": str(self.total_costs.amount),
            "net_profit": str(self.net_profit.amount),
            "profit_margin": str(self.profit_margin) if self.profit_margin is not None else None,
            "roi": str(self.roi) if self.roi is not None else None,
            "capital_required": str(self.capital_required.amount),
            "fee_lines": self.fee_lines,
            "assumptions": self.assumptions,
            "profit_model_version": self.profit_model_version,
            "fee_model_version": self.fee_model_version,
        }


def _resolve(value: Money | None, currency: str) -> Money:
    return value if value is not None else Money.zero(currency)


def calculate_profit(inputs: ProfitInputs) -> ProfitBreakdown:
    """Compute the full profit breakdown for one order.

    ``NET_PROFIT = SALE_REVENUE - SOURCE_PURCHASE_COST - SOURCE_SHIPPING
    - MARKETPLACE_FEES - PAYMENT_FEES - FULFILLMENT_COST - OUTBOUND_SHIPPING
    - PACKAGING - EXPECTED_RETURN_COST - RISK_RESERVE - OTHER_COSTS``
    """
    if inputs.quantity < 1:
        raise ValueError("quantity must be >= 1")
    currency = inputs.currency
    assumptions: list[str] = []

    revenue = inputs.sale_price
    buyer_shipping = _resolve(inputs.buyer_shipping_paid, currency)

    source_cost = inputs.source_unit_price * inputs.quantity
    source_shipping = _resolve(inputs.source_shipping_cost, currency)
    outbound_shipping = _resolve(inputs.outbound_shipping_cost, currency)
    packaging = _resolve(inputs.packaging_cost, currency)
    fulfillment = _resolve(inputs.fulfillment_cost, currency)
    other = _resolve(inputs.other_variable_costs, currency)

    if fulfillment.is_zero():
        assumptions.append(
            "Fulfillment cost is 0: manual fulfilment by the operator incurs no "
            "external fee. Operator time is deliberately not priced."
        )

    # -- fees ---------------------------------------------------------------
    fee_lines: list[dict] = []
    fee_model_version = "override"
    if inputs.marketplace_fee_override is not None:
        marketplace_fees = inputs.marketplace_fee_override
        fee_lines.append(
            {"label": "marketplace fees (actual)", "amount": str(marketplace_fees.amount), "rate": None}
        )
    elif inputs.marketplace_fee_model is not None:
        result: FeeResult = calculate_fees(
            inputs.marketplace_fee_model,
            item_price=revenue,
            buyer_shipping_paid=buyer_shipping,
            quantity=inputs.quantity,
        )
        marketplace_fees = result.total
        fee_lines.extend(result.to_dicts())
        fee_model_version = result.model_version
    else:
        marketplace_fees = Money.zero(currency)
        assumptions.append("No marketplace fee model supplied; marketplace fees treated as 0.")

    if inputs.payment_fee_override is not None:
        payment_fees = inputs.payment_fee_override
        fee_lines.append(
            {"label": "payment fees (actual)", "amount": str(payment_fees.amount), "rate": None}
        )
    elif inputs.payment_fee_model is not None:
        payment_result = calculate_fees(
            inputs.payment_fee_model,
            item_price=revenue,
            buyer_shipping_paid=buyer_shipping,
            quantity=inputs.quantity,
        )
        payment_fees = payment_result.total
        fee_lines.extend(payment_result.to_dicts())
    else:
        payment_fees = Money.zero(currency)

    # -- gross profit before return exposure and reserve ---------------------
    gross_costs = (
        source_cost
        + source_shipping
        + marketplace_fees
        + payment_fees
        + fulfillment
        + outbound_shipping
        + packaging
        + other
    )
    gross_profit = revenue + buyer_shipping - gross_costs

    # -- expected return cost ----------------------------------------------
    # Exact expected value. If p is the return probability, then
    #   E[profit] = (1-p)*gross_profit + p*(-loss_given_return)
    #             = gross_profit - p*(gross_profit + loss_given_return)
    # so the expected return cost is p*(gross_profit + loss_given_return).
    # Modelling it this way means a return costs us the margin we did not
    # earn *and* the cash we cannot recover - not just the postage.
    return_rate = inputs.expected_return_rate
    if return_rate < 0 or return_rate > 1:
        raise ValueError("expected_return_rate must be between 0 and 1")
    if return_rate > 0:
        recovery = inputs.return_value_recovery_rate
        if recovery < 0 or recovery > 1:
            raise ValueError("return_value_recovery_rate must be between 0 and 1")
        unrecovered_goods = source_cost * (Decimal(1) - recovery)
        loss_given_return = (
            unrecovered_goods
            + source_shipping
            + outbound_shipping
            + packaging
            + _resolve(inputs.return_shipping_cost, currency)
            + _resolve(inputs.non_refundable_fee_on_return, currency)
        )
        expected_return_cost = (gross_profit + loss_given_return) * return_rate
        if expected_return_cost.is_negative():
            expected_return_cost = Money.zero(currency)
        assumptions.append(
            f"Expected return cost assumes a {return_rate} return probability, "
            f"{recovery} of the goods value recovered, and the outbound shipping, "
            "packaging and return postage written off."
        )
    else:
        expected_return_cost = Money.zero(currency)

    # -- risk reserve --------------------------------------------------------
    if inputs.risk_reserve_override is not None:
        risk_reserve = inputs.risk_reserve_override
    elif inputs.risk_reserve_percent:
        risk_reserve = Money(
            (revenue.amount + buyer_shipping.amount) * inputs.risk_reserve_percent / Decimal(100),
            currency,
        )
        assumptions.append(
            f"Risk reserve is {inputs.risk_reserve_percent}% of gross sale revenue."
        )
    else:
        risk_reserve = Money.zero(currency)

    total_costs = gross_costs + expected_return_cost + risk_reserve
    net_profit = revenue + buyer_shipping - total_costs

    # -- capital: cash that must leave the account before the payout arrives -
    # Marketplace and payment fees are withheld from the payout rather than
    # paid up front, so they are not capital. Everything else is.
    capital_required = source_cost + source_shipping + outbound_shipping + packaging + fulfillment + other

    gross_revenue = revenue + buyer_shipping
    margin = net_profit.ratio_to(gross_revenue)
    roi = net_profit.ratio_to(capital_required) if capital_required.is_positive() else None

    return ProfitBreakdown(
        scenario=inputs.scenario,
        currency=currency,
        quantity=inputs.quantity,
        sale_revenue=revenue,
        buyer_shipping_paid=buyer_shipping,
        source_purchase_cost=source_cost,
        source_shipping_cost=source_shipping,
        marketplace_fees=marketplace_fees,
        payment_fees=payment_fees,
        fulfillment_cost=fulfillment,
        outbound_shipping_cost=outbound_shipping,
        packaging_cost=packaging,
        expected_return_cost=expected_return_cost,
        risk_reserve=risk_reserve,
        other_variable_costs=other,
        total_costs=total_costs,
        net_profit=net_profit,
        profit_margin=quantize_ratio(margin) if margin is not None else None,
        roi=quantize_ratio(roi) if roi is not None else None,
        capital_required=capital_required,
        fee_lines=fee_lines,
        assumptions=assumptions,
        fee_model_version=fee_model_version,
    )


def inputs_from_config(
    config: BusinessConfig,
    *,
    sale_price: Money,
    source_unit_price: Money,
    quantity: int = 1,
    buyer_shipping_paid: Money | None = None,
    source_shipping_cost: Money | None = None,
    outbound_shipping_cost: Money | None = None,
    packaging_cost: Money | None = None,
    fulfillment_cost: Money | None = None,
    scenario: ScenarioType = ScenarioType.BASE_CASE,
) -> ProfitInputs:
    """Build :class:`ProfitInputs` from the operator's configured cost model.

    Any cost not explicitly supplied falls back to the configured value; the
    fulfilment cost defaults to zero because manual fulfilment has no external
    fee.
    """
    currency = sale_price.currency
    return ProfitInputs(
        sale_price=sale_price,
        source_unit_price=source_unit_price,
        quantity=quantity,
        buyer_shipping_paid=buyer_shipping_paid or Money.zero(currency),
        source_shipping_cost=source_shipping_cost
        if source_shipping_cost is not None
        else Money(config.source_to_operator_shipping_cost, currency),
        outbound_shipping_cost=outbound_shipping_cost
        if outbound_shipping_cost is not None
        else Money(config.operator_to_customer_shipping_cost, currency),
        packaging_cost=packaging_cost
        if packaging_cost is not None
        else Money(config.packaging_cost, currency),
        fulfillment_cost=fulfillment_cost if fulfillment_cost is not None else Money.zero(currency),
        other_variable_costs=Money(config.other_variable_costs, currency),
        marketplace_fee_model=config.marketplace_fee_model,
        payment_fee_model=config.payment_fee_model,
        expected_return_rate=config.expected_return_rate,
        return_shipping_cost=Money(config.return_shipping_cost, currency),
        return_value_recovery_rate=config.return_value_recovery_rate,
        risk_reserve_percent=config.risk_reserve_percent,
        scenario=scenario,
    )
