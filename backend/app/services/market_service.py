"""Persisting market observations.

Every write here also appends to the history tables.  The engines need the
history to tell a durable price from a momentary anomaly, and the operator
needs it to answer "was this ever really worth what we thought?".
"""

from __future__ import annotations

import statistics
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import Money
from app.models.enums import (
    IdentifierType,
    ListingState,
    PriceTrend,
    ProductCondition,
    StockStatus,
)
from app.models.market import (
    CompetitionSnapshot,
    DeliveryEstimate,
    InventorySnapshot,
    PriceHistory,
    SourceOffer,
    TargetListing,
)
from app.models.product import Product, ProductIdentifier
from app.providers.base import ListingSnapshot, MarketStats, OfferSnapshot


class MarketService:
    def __init__(self, session: Session, *, currency: str = "EUR") -> None:
        self.session = session
        self.currency = currency

    # -- products -----------------------------------------------------------
    def upsert_product(
        self,
        *,
        title: str,
        identifiers: dict[str, str],
        brand: str | None = None,
        manufacturer: str | None = None,
        model: str | None = None,
        category: str | None = None,
        condition: ProductCondition = ProductCondition.NEW,
        attributes: dict | None = None,
        image_urls: list[str] | None = None,
    ) -> Product:
        """Find a product by a strong identifier, or create it."""
        product: Product | None = None
        for id_type in (IdentifierType.EAN, IdentifierType.GTIN, IdentifierType.UPC, IdentifierType.ISBN):
            value = identifiers.get(id_type.value)
            if not value:
                continue
            stmt = (
                select(Product)
                .join(ProductIdentifier)
                .where(ProductIdentifier.identifier_type == id_type, ProductIdentifier.value == value)
            )
            product = self.session.execute(stmt).scalars().first()
            if product is not None:
                break

        if product is None:
            primary_type = next(
                (t for t in (IdentifierType.EAN, IdentifierType.GTIN, IdentifierType.UPC)
                 if identifiers.get(t.value)),
                None,
            )
            product = Product(
                title=title,
                brand=brand,
                manufacturer=manufacturer,
                model=model,
                category=category,
                condition=condition,
                attributes=attributes or {},
                image_urls=image_urls or [],
                primary_identifier_type=primary_type,
                primary_identifier_value=identifiers.get(primary_type.value) if primary_type else None,
            )
            self.session.add(product)
            self.session.flush()

        known = {(i.identifier_type, i.value) for i in product.identifiers}
        for raw_type, value in identifiers.items():
            if not value:
                continue
            try:
                id_type = IdentifierType(raw_type.upper())
            except ValueError:
                continue
            if (id_type, value) in known:
                continue
            self.session.add(
                ProductIdentifier(
                    product_id=product.id, identifier_type=id_type, value=value, source="provider"
                )
            )
        self.session.flush()
        return product

    # -- source offers ------------------------------------------------------
    def upsert_source_offer(
        self, snapshot: OfferSnapshot, *, provider: str, product: Product | None = None
    ) -> SourceOffer:
        stmt = select(SourceOffer).where(
            SourceOffer.provider == provider,
            SourceOffer.external_id == snapshot.external_id,
            SourceOffer.seller_id == snapshot.seller_id,
        )
        offer = self.session.execute(stmt).scalars().first()
        previous_price = offer.price if offer is not None else None

        if offer is None:
            offer = SourceOffer(provider=provider, external_id=snapshot.external_id)
            self.session.add(offer)

        offer.product_id = product.id if product is not None else offer.product_id
        offer.title = snapshot.title
        offer.brand = snapshot.brand
        offer.manufacturer = snapshot.manufacturer
        offer.model = snapshot.model
        offer.url = snapshot.url
        offer.seller_id = snapshot.seller_id
        offer.seller_name = snapshot.seller_name
        offer.sold_by_marketplace = snapshot.sold_by_marketplace
        offer.condition = snapshot.condition
        offer.currency = self.currency
        offer.price = snapshot.price.amount if snapshot.price else None
        offer.shipping_cost = snapshot.shipping_cost.amount
        offer.price_timestamp = snapshot.observed_at
        offer.conditional_price = (
            snapshot.conditional_price.amount if snapshot.conditional_price else None
        )
        offer.conditional_price_note = snapshot.conditional_price_note
        offer.stock_status = snapshot.stock_status
        offer.available_quantity = snapshot.available_quantity
        offer.stock_confidence = snapshot.stock_confidence
        offer.inventory_timestamp = snapshot.observed_at
        offer.max_order_quantity = snapshot.max_order_quantity
        offer.delivery_min_days = snapshot.delivery_min_days
        offer.delivery_max_days = snapshot.delivery_max_days
        offer.delivery_speed = snapshot.delivery_speed
        offer.delivery_timestamp = snapshot.observed_at
        offer.is_fast_shipping_eligible = snapshot.is_fast_shipping_eligible
        offer.attributes = dict(snapshot.attributes)
        offer.raw_payload = dict(snapshot.raw)
        offer.is_active = snapshot.stock_status is not StockStatus.OUT_OF_STOCK
        self.session.flush()

        self.session.add(
            PriceHistory(
                product_id=offer.product_id,
                entity_type="source_offer",
                entity_id=offer.id,
                provider=provider,
                currency=self.currency,
                price=offer.price,
                shipping_cost=offer.shipping_cost,
                observed_at=snapshot.observed_at,
            )
        )
        self.session.add(
            InventorySnapshot(
                source_offer_id=offer.id,
                stock_status=snapshot.stock_status,
                available_quantity=snapshot.available_quantity,
                stock_confidence=snapshot.stock_confidence,
                observed_at=snapshot.observed_at,
            )
        )
        self.session.add(
            DeliveryEstimate(
                source_offer_id=offer.id,
                min_days=snapshot.delivery_min_days,
                max_days=snapshot.delivery_max_days,
                speed=snapshot.delivery_speed,
                estimated_arrival=(
                    snapshot.observed_at + timedelta(days=snapshot.delivery_max_days)
                    if snapshot.delivery_max_days is not None
                    else None
                ),
                shipping_cost=snapshot.shipping_cost.amount,
                observed_at=snapshot.observed_at,
            )
        )
        self.session.flush()
        offer.raw_payload = {**offer.raw_payload, "previous_price": str(previous_price or "")}
        return offer

    # -- target listings ----------------------------------------------------
    def upsert_target_listing(
        self,
        snapshot: ListingSnapshot,
        *,
        provider: str,
        product: Product | None = None,
        is_own_listing: bool = False,
    ) -> TargetListing:
        stmt = select(TargetListing).where(
            TargetListing.provider == provider, TargetListing.external_id == snapshot.external_id
        )
        listing = self.session.execute(stmt).scalars().first()
        if listing is None:
            listing = TargetListing(provider=provider, external_id=snapshot.external_id)
            self.session.add(listing)

        listing.product_id = product.id if product is not None else listing.product_id
        listing.title = snapshot.title
        listing.brand = snapshot.brand
        listing.model = snapshot.model
        listing.url = snapshot.url
        listing.condition = snapshot.condition
        listing.currency = self.currency
        listing.price = snapshot.price.amount if snapshot.price else None
        listing.shipping_price = snapshot.shipping_price.amount
        listing.price_timestamp = snapshot.observed_at
        listing.quantity = snapshot.quantity
        listing.seller_id = snapshot.seller_id
        listing.category_id = snapshot.category_id
        listing.attributes = dict(snapshot.attributes)
        listing.raw_payload = dict(snapshot.raw)
        listing.is_own_listing = is_own_listing
        if not is_own_listing:
            listing.state = ListingState.PUBLISHED
        self.session.flush()

        self.session.add(
            PriceHistory(
                product_id=listing.product_id,
                entity_type="target_listing",
                entity_id=listing.id,
                provider=provider,
                currency=self.currency,
                price=listing.price,
                shipping_cost=listing.shipping_price,
                observed_at=snapshot.observed_at,
            )
        )
        self.session.flush()
        return listing

    # -- competition --------------------------------------------------------
    def record_market_stats(
        self, stats: MarketStats, *, provider: str, product: Product | None
    ) -> CompetitionSnapshot:
        spread = None
        if stats.lowest_price and stats.highest_price and stats.lowest_price.amount > 0:
            spread = (
                stats.highest_price.amount - stats.lowest_price.amount
            ) / stats.lowest_price.amount

        snapshot = CompetitionSnapshot(
            product_id=product.id if product else None,
            provider=provider,
            currency=self.currency,
            competitor_count=stats.competitor_count,
            seller_count=stats.seller_count,
            lowest_price=stats.lowest_price.amount if stats.lowest_price else None,
            median_price=stats.median_price.amount if stats.median_price else None,
            highest_price=stats.highest_price.amount if stats.highest_price else None,
            realistic_sale_price=(
                stats.realistic_sale_price.amount if stats.realistic_sale_price else None
            ),
            price_spread_ratio=spread,
            sold_last_30d=stats.sold_last_30d,
            price_volatility=stats.price_volatility,
            price_trend=self.price_trend_for(product.id if product else None),
            distribution=stats.distribution,
            observed_at=stats.observed_at,
        )
        self.session.add(snapshot)
        self.session.add(
            PriceHistory(
                product_id=product.id if product else None,
                entity_type="market",
                entity_id=None,
                provider=provider,
                currency=self.currency,
                lowest_price=stats.lowest_price.amount if stats.lowest_price else None,
                median_price=stats.median_price.amount if stats.median_price else None,
                highest_price=stats.highest_price.amount if stats.highest_price else None,
                sample_size=max(stats.competitor_count, 1),
                observed_at=stats.observed_at,
            )
        )
        self.session.flush()
        return snapshot

    # -- history analysis ---------------------------------------------------
    def price_points(self, product_id: int | None, entity_type: str, *, limit: int = 30) -> list[Decimal]:
        if product_id is None:
            return []
        stmt = (
            select(PriceHistory.price, PriceHistory.median_price)
            .where(PriceHistory.product_id == product_id, PriceHistory.entity_type == entity_type)
            .order_by(PriceHistory.observed_at.desc())
            .limit(limit)
        )
        values: list[Decimal] = []
        for price, median in self.session.execute(stmt):
            chosen = price if price is not None else median
            if chosen is not None:
                values.append(Decimal(str(chosen)))
        return values

    def volatility(self, product_id: int | None, entity_type: str = "target_listing") -> Decimal | None:
        """Coefficient of variation of observed prices.

        Returns ``None`` below three observations: two points cannot tell a
        trend from noise, and pretending otherwise would understate risk.
        """
        values = self.price_points(product_id, entity_type)
        if len(values) < 3:
            return None
        mean = sum(values) / Decimal(len(values))
        if mean == 0:
            return None
        deviation = Decimal(str(statistics.pstdev([float(v) for v in values])))
        return (deviation / mean).quantize(Decimal("0.0001"))

    def price_trend_for(self, product_id: int | None) -> PriceTrend:
        values = self.price_points(product_id, "target_listing", limit=10)
        if len(values) < 3:
            return PriceTrend.UNKNOWN
        recent = values[: len(values) // 2]
        older = values[len(values) // 2 :]
        recent_mean = sum(recent) / Decimal(len(recent))
        older_mean = sum(older) / Decimal(len(older))
        if older_mean == 0:
            return PriceTrend.UNKNOWN
        change = (recent_mean - older_mean) / older_mean
        if change > Decimal("0.03"):
            return PriceTrend.RISING
        if change < Decimal("-0.03"):
            return PriceTrend.FALLING
        return PriceTrend.STABLE

    def source_price_change_percent(self, offer: SourceOffer) -> Decimal | None:
        """How far the source price moved since the previous observation."""
        stmt = (
            select(PriceHistory.price)
            .where(
                PriceHistory.entity_type == "source_offer",
                PriceHistory.entity_id == offer.id,
                PriceHistory.price.is_not(None),
            )
            .order_by(PriceHistory.observed_at.desc())
            .limit(2)
        )
        rows = [Decimal(str(row[0])) for row in self.session.execute(stmt)]
        if len(rows) < 2 or rows[1] == 0:
            return None
        return ((rows[0] - rows[1]) / rows[1] * Decimal(100)).quantize(Decimal("0.01"))

    def stock_flapped(self, offer: SourceOffer, *, lookback: int = 6) -> bool:
        stmt = (
            select(InventorySnapshot.stock_status)
            .where(InventorySnapshot.source_offer_id == offer.id)
            .order_by(InventorySnapshot.observed_at.desc())
            .limit(lookback)
        )
        statuses = [row[0] for row in self.session.execute(stmt)]
        return len(set(statuses)) > 1

    def latest_competition(self, product_id: int | None) -> CompetitionSnapshot | None:
        if product_id is None:
            return None
        stmt = (
            select(CompetitionSnapshot)
            .where(CompetitionSnapshot.product_id == product_id)
            .order_by(CompetitionSnapshot.observed_at.desc())
            .limit(1)
        )
        return self.session.execute(stmt).scalars().first()

    def money(self, value: Decimal | None) -> Money | None:
        return Money(value, self.currency) if value is not None else None
