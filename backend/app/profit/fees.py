"""Marketplace and payment fee calculation.

Fee schedules are modelled as *marginal* percentage bands plus fixed
components, because that is how real final-value fees work.  A single
hardcoded percentage would silently misprice every order above a band
boundary, and mispricing is the one thing this system must not do.

Rounding: bands are summed in unrounded :class:`~decimal.Decimal` and the
total is quantised once.  Rounding each band separately would accumulate
sub-cent drift that does not match any marketplace invoice.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.core.money import Money
from app.services.settings_service import FeeModel


@dataclass(frozen=True)
class FeeLine:
    """One component of a fee total, kept for the UI and the audit trail."""

    label: str
    basis: str
    rate: Decimal | None
    amount: Money

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "basis": self.basis,
            "rate": str(self.rate) if self.rate is not None else None,
            "amount": str(self.amount.amount),
            "currency": self.amount.currency,
        }


@dataclass(frozen=True)
class FeeResult:
    total: Money
    lines: list[FeeLine] = field(default_factory=list)
    model_name: str = "default"
    model_version: str = "1.0.0"
    capped: bool = False

    def to_dicts(self) -> list[dict]:
        return [line.to_dict() for line in self.lines]


def calculate_fees(
    model: FeeModel,
    *,
    item_price: Money,
    buyer_shipping_paid: Money | None = None,
    quantity: int = 1,
) -> FeeResult:
    """Apply ``model`` to an order and return the total with its breakdown."""
    if quantity < 1:
        raise ValueError("quantity must be >= 1")
    currency = item_price.currency
    shipping = buyer_shipping_paid or Money.zero(currency)
    base = item_price + shipping if model.includes_shipping_in_base else item_price

    lines: list[FeeLine] = []
    raw_total = Decimal("0")
    remaining = base.amount
    lower = Decimal("0")

    for band in model.bands:
        if remaining <= 0:
            break
        upper = band.up_to
        portion = remaining if upper is None else min(remaining, max(Decimal("0"), upper - lower))
        if portion <= 0:
            lower = upper if upper is not None else lower
            continue
        amount = portion * band.percent / Decimal(100)
        raw_total += amount
        label = (
            f"final value fee {band.percent}% up to {upper}"
            if upper is not None
            else f"final value fee {band.percent}% above {lower}"
        )
        lines.append(
            FeeLine(
                label=label,
                basis=f"{portion} of {base.amount}",
                rate=band.percent,
                amount=Money(amount, currency),
            )
        )
        remaining -= portion
        lower = upper if upper is not None else lower

    if model.additional_percent:
        amount = base.amount * model.additional_percent / Decimal(100)
        raw_total += amount
        lines.append(
            FeeLine(
                label=f"additional fee {model.additional_percent}%",
                basis=str(base.amount),
                rate=model.additional_percent,
                amount=Money(amount, currency),
            )
        )

    if model.fixed_per_order:
        raw_total += model.fixed_per_order
        lines.append(
            FeeLine(
                label="fixed per-order fee",
                basis="order",
                rate=None,
                amount=Money(model.fixed_per_order, currency),
            )
        )

    if model.fixed_per_item:
        amount = model.fixed_per_item * Decimal(quantity)
        raw_total += amount
        lines.append(
            FeeLine(
                label=f"fixed per-item fee x{quantity}",
                basis=f"{quantity} items",
                rate=None,
                amount=Money(amount, currency),
            )
        )

    capped = False
    if model.cap is not None and raw_total > model.cap:
        lines.append(
            FeeLine(
                label=f"cap applied at {model.cap}",
                basis="cap",
                rate=None,
                amount=Money(model.cap - raw_total, currency),
            )
        )
        raw_total = model.cap
        capped = True

    return FeeResult(
        total=Money(raw_total, currency),
        lines=lines,
        model_name=model.name,
        model_version=model.version,
        capped=capped,
    )
