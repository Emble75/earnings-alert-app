"""Finding candidates instead of being handed them.

The direction matters. Searching Amazon for cheap things and then asking
whether eBay wants them finds plenty of cheap things nobody buys. Starting on
eBay inverts it: a listing at a price, with competitors at similar prices, is
evidence of demand. The remaining question is only ever *what would I have to
pay on Amazon for this to work*, and that has an exact answer.

So a scan produces a **worklist**, not a verdict. Each row is a real product
with a real eBay price and a maximum Amazon price, computed by the profit
engine through the configured cost model, VAT included. The operator opens the
Amazon link and compares one number. There is no step at which the system
invents an Amazon price it does not have.

Two costs shape the design. eBay's call budget is finite - a few thousand a
day - and a summary page returns 200 listings for one call while the product
codes needed for matching cost one call each. So listings are grouped by
eBay's catalogue id first, and only one representative per product is looked
up. And the median of a product's competing listings is used as the sale
price, never the highest: the highest is one seller's hope.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.logging import get_logger
from app.core.marketplace_links import amazon_url, ebay_offer_url, ebay_sold_url
from app.core.money import Money
from app.matching.text import normalize_key
from app.models.enums import ScenarioType
from app.profit.engine import inputs_from_config
from app.profit.solver import BreakEven, max_source_price
from app.providers.base import ListingSnapshot
from app.providers.registry import ProviderBundle
from app.services.settings_service import BusinessConfig

logger = get_logger(__name__)

#: Detail lookups per scan. Each costs one API call, and the daily budget is a
#: few thousand, so a scan must not be able to spend it all.
DEFAULT_DETAIL_BUDGET = 40

#: A product with only one listing tells us nothing about what it sells for.
#: Two competing sellers is the least evidence worth a lookup.
MIN_LISTINGS_FOR_A_PRICE = 2


@dataclass
class Candidate:
    """One product worth checking on Amazon, and the price that would do it."""

    title: str
    ebay_price: Money
    #: How many competing listings the price is a median of.
    listing_count: int
    lowest: Money
    highest: Money
    item_id: str
    item_url: str
    sold_url: str | None = None
    identifiers: dict[str, str] = field(default_factory=dict)
    brand: str | None = None
    model: str | None = None
    epid: str | None = None
    max_amazon_price: Money | None = None
    impossible_reason: str | None = None
    #: Where to go and look the Amazon price up.
    amazon_search_url: str | None = None

    @property
    def ean(self) -> str | None:
        return self.identifiers.get("EAN") or self.identifiers.get("GTIN")


@dataclass
class ScanResult:
    candidates: list[Candidate] = field(default_factory=list)
    listings_seen: int = 0
    products_found: int = 0
    detail_lookups: int = 0
    notes: list[str] = field(default_factory=list)


def _median(values: list[Money]) -> Money:
    """The middle price. Never the highest - that is one seller's hope."""
    ordered = sorted(values, key=lambda money: money.amount)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return Money(
        (ordered[middle - 1].amount + ordered[middle].amount) / Decimal(2),
        ordered[0].currency,
    )


def _group_key(listing: ListingSnapshot) -> str:
    """What makes two listings the same product.

    eBay's catalogue id when it has one, because that is eBay's own judgement
    and costs nothing. Otherwise the normalised title, which is weaker - it is
    only used to group listings for a price, never to claim a match with an
    Amazon offer. That claim still requires the matcher and a product code.
    """
    epid = (listing.attributes or {}).get("epid")
    if epid:
        return f"epid:{epid}"
    return f"title:{normalize_key(listing.title)[:80]}"


class DiscoveryService:
    """Scan a marketplace for candidates worth pricing."""

    def __init__(
        self, session: Session, config: BusinessConfig, providers: ProviderBundle
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency

    # -- availability --------------------------------------------------------
    def can_scan(self) -> tuple[bool, str | None]:
        """Whether there is a real marketplace behind this, and why not."""
        target = self.providers.target
        live = getattr(target, "reads_live_data", getattr(target, "is_live", False))
        if not live:
            return False, (
                "Scanning needs live eBay access. Add EBAY_CLIENT_ID and "
                "EBAY_CLIENT_SECRET from your eBay developer account. Until then, "
                "check products one at a time under Research."
            )
        inner = getattr(target, "inner", target)
        if not hasattr(inner, "scan_listings"):
            return False, (
                "The configured eBay provider cannot scan a category. This needs "
                "the Browse API adapter."
            )
        return True, None

    # -- the scan ------------------------------------------------------------
    def scan(
        self,
        *,
        category_ids: list[str] | None = None,
        query: str = "",
        min_price: Decimal | None = None,
        max_price: Decimal | None = None,
        pages: int = 1,
        detail_budget: int = DEFAULT_DETAIL_BUDGET,
    ) -> ScanResult:
        possible, reason = self.can_scan()
        result = ScanResult()
        if not possible:
            result.notes.append(reason or "scanning is unavailable")
            return result

        target = self.providers.target
        inner = getattr(target, "inner", target)

        # The upper bound defaults to what the operator may actually spend on
        # one order: a 900 EUR listing is not a candidate for a 400 EUR limit.
        if max_price is None:
            max_price = self.config.max_capital_per_order

        listings: list[ListingSnapshot] = []
        for page in range(max(1, pages)):
            try:
                batch = inner.scan_listings(
                    category_ids=category_ids,
                    query=query,
                    min_price=min_price,
                    max_price=max_price,
                    offset=page * 200,
                    limit=200,
                )
            except (AppError, ValueError) as exc:
                result.notes.append(f"eBay stopped the scan: {exc}")
                break
            listings.extend(batch)
            if len(batch) < 200:
                break  # the last page

        result.listings_seen = len(listings)
        if not listings:
            result.notes.append("eBay returned no fixed-price listings for that scan.")
            return result

        # Group into products, so one lookup answers for many listings.
        groups: dict[str, list[ListingSnapshot]] = {}
        for listing in listings:
            groups.setdefault(_group_key(listing), []).append(listing)
        result.products_found = len(groups)

        # Spend the lookup budget where the evidence is strongest: the most
        # competing listings, which is where a median price means something.
        ranked = sorted(
            (group for group in groups.values() if len(group) >= MIN_LISTINGS_FOR_A_PRICE),
            key=len,
            reverse=True,
        )
        thin = result.products_found - len(ranked)
        if thin:
            result.notes.append(
                f"{thin} product(s) had only one listing, which is not enough to "
                "tell what they sell for, so they were left out."
            )

        for group in ranked[:detail_budget]:
            candidate = self._candidate(group, inner)
            result.detail_lookups += 1
            if candidate is not None:
                result.candidates.append(candidate)

        if len(ranked) > detail_budget:
            result.notes.append(
                f"Stopped after {detail_budget} products to stay inside the eBay call "
                f"budget; {len(ranked) - detail_budget} more matched the scan."
            )

        # Best first: the most headroom between the eBay price and what you
        # would have to pay is the deal most likely to survive contact with a
        # real Amazon price.
        result.candidates.sort(
            key=lambda c: (c.max_amazon_price.amount if c.max_amazon_price else Decimal("-1")),
            reverse=True,
        )
        logger.info(
            "scan_complete",
            listings=result.listings_seen,
            products=result.products_found,
            lookups=result.detail_lookups,
            candidates=len(result.candidates),
        )
        return result

    # -- one product ---------------------------------------------------------
    def _candidate(self, group: list[ListingSnapshot], provider) -> Candidate | None:
        prices = [listing.price for listing in group if listing.price is not None]
        if not prices:
            return None

        # The representative is the listing nearest the median, so the item we
        # look up is a typical one rather than the cheapest or the dearest.
        median = _median(prices)
        representative = min(
            group,
            key=lambda listing: abs((listing.price or median).amount - median.amount),
        )

        # One detail call: this is where the product codes come from, and they
        # are what lets the matcher confirm an Amazon offer later.
        identifiers = dict(representative.identifiers)
        brand, model = representative.brand, representative.model
        try:
            detail = provider.get_listing_status(representative.external_id)
        except AppError as exc:
            logger.warning("detail_lookup_failed", item=representative.external_id, error=str(exc))
            detail = None
        if detail is not None:
            identifiers.update(detail.identifiers)
            brand = detail.brand or brand
            model = detail.model or model

        break_even = self._break_even(median)
        return Candidate(
            title=representative.title,
            ebay_price=median,
            listing_count=len(group),
            lowest=min(prices, key=lambda m: m.amount),
            highest=max(prices, key=lambda m: m.amount),
            item_id=representative.external_id,
            item_url=representative.url or ebay_offer_url(representative.external_id),
            sold_url=ebay_sold_url(brand=brand, model=model, title=representative.title),
            identifiers=identifiers,
            brand=brand,
            model=model,
            epid=(representative.attributes or {}).get("epid"),
            max_amazon_price=break_even.max_source_price,
            impossible_reason=break_even.impossible_reason,
            amazon_search_url=amazon_url(
                identifier=identifiers.get("EAN") or identifiers.get("GTIN"),
                title=representative.title,
            ),
        )

    def _break_even(self, sale_price: Money) -> BreakEven:
        """The most this could be bought for and still clear every threshold."""
        inputs = inputs_from_config(
            self.config,
            sale_price=sale_price,
            source_unit_price=Money.zero(sale_price.currency),
            scenario=ScenarioType.BASE_CASE,
        )
        return max_source_price(
            inputs,
            minimum_net_profit=self.config.minimum_net_profit,
            minimum_profit_margin=self.config.minimum_profit_margin,
        )
