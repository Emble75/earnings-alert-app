"""VAT, and why a profit figure without it is wrong.

A seller on the standard scheme who sells an item for 319 EUR does not keep
319 EUR. The price a buyer pays is gross: 19/119 of it belongs to the tax
office. On the other side, the VAT inside the purchase price is reclaimable -
but only against a proper invoice, and only if the seller is on that scheme at
all.

The two German cases differ by roughly a fifth of the margin, which is more
than the entire minimum-profit threshold on a typical order. Getting this
wrong does not shade the answer; it reverses it:

    Sale 319.00, purchase 199.00, no other costs

    Kleinunternehmer (§19 UStG)   319.00 - 199.00            = 120.00
    Regelbesteuert, with invoice  268.07 - 167.23            = 100.84
    Regelbesteuert, no invoice    268.07 - 199.00            =  69.07

None of this is tax advice, and the system does not guess which case applies.
It asks once, applies the answer exactly, and shows the VAT as its own line so
the number can be checked.

Two deliberate conservatisms, both stated in the breakdown rather than hidden:

* Input VAT is reclaimed only where the operator has said it can be. An
  unticked box costs profit, which is the safe direction for a system whose
  job is to reject false positives.
* On a return, the input VAT on the goods stays written off along with the
  goods. In reality some of it is recoverable; assuming so would make returns
  look cheaper than they are.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.core.money import Money
from app.models.enums import VatScheme


def included_vat(gross: Money, rate_percent: Decimal) -> Money:
    """The VAT already contained in a gross amount.

    ``gross * rate / (100 + rate)`` - not ``gross * rate``, which is the
    classic error that overstates the tax by a fifth. At 19% the factor is
    19/119, never 19/100.
    """
    if rate_percent <= 0 or gross.is_zero():
        return Money.zero(gross.currency)
    return Money(
        gross.amount * rate_percent / (Decimal(100) + rate_percent), gross.currency
    )


def add_vat(net: Money, rate_percent: Decimal) -> Money:
    """The gross amount for a net one."""
    if rate_percent <= 0:
        return net
    return Money(net.amount * (Decimal(100) + rate_percent) / Decimal(100), net.currency)


@dataclass(frozen=True)
class VatTreatment:
    """How one seller is taxed. Defaults to the case that changes nothing.

    ``SMALL_BUSINESS`` is the default because it is the arithmetic the rest of
    the system already assumed: no VAT on the sale, no reclaim on the purchase,
    gross in and gross out.
    """

    scheme: VatScheme = VatScheme.SMALL_BUSINESS
    #: Percent, as a number: 19 means 19%. Germany's standard rate.
    rate: Decimal = Decimal("19")
    #: Amazon must have issued an invoice showing the VAT. A private-marketplace
    #: seller, or an order placed without a business account, will not have one.
    reclaim_on_purchase: bool = False
    #: Marketplace and payment fees. eBay invoices a German business seller
    #: under the reverse charge, in which case there is no input VAT to reclaim
    #: and this stays off.
    reclaim_on_fees: bool = False
    #: Outbound postage and packaging bought with a VAT invoice. Deutsche Post
    #: letter products are VAT-exempt; a DHL business contract is not.
    reclaim_on_costs: bool = False

    @property
    def charges_vat_on_sales(self) -> bool:
        return self.scheme is VatScheme.STANDARD and self.rate > 0

    def vat_in(self, gross: Money) -> Money:
        """VAT contained in a gross amount under this treatment."""
        if not self.charges_vat_on_sales:
            return Money.zero(gross.currency)
        return included_vat(gross, self.rate)

    def describe(self) -> str:
        if self.scheme is VatScheme.SMALL_BUSINESS:
            return (
                "Small-business scheme (§19 UStG): no VAT is charged on the sale and "
                "none is reclaimed on the purchase. Prices are taken as they are paid."
            )
        reclaims = [
            name
            for name, on in (
                ("the purchase", self.reclaim_on_purchase),
                ("marketplace fees", self.reclaim_on_fees),
                ("shipping and packaging", self.reclaim_on_costs),
            )
            if on
        ]
        detail = (
            f"Input VAT is reclaimed on {', '.join(reclaims)}."
            if reclaims
            else (
                "No input VAT is reclaimed anywhere, so the full gross purchase price "
                "is a cost. If you do hold VAT invoices, turn the reclaim on - this "
                "setting is costing you real margin."
            )
        )
        return f"Standard scheme: {self.rate}% VAT is due on the sale. {detail}"
