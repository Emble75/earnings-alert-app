"""Marketplace-side data: offers, listings, prices, inventory, delivery, competition.

Every row in this module carries its own observation timestamp.  Freshness is
a first-class property of the data, not an afterthought: the profit engine and
the revalidation service refuse to act on observations older than the
configured maximum age.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin
from app.db.types import JSONDict, MoneyCents, Ratio, StringEnum
from app.models.enums import (
    DeliverySpeed,
    ListingState,
    PriceTrend,
    ProductCondition,
    StockStatus,
)


class SourceOffer(Base, IdMixin, TimestampMixin):
    """A purchasable offer on a source marketplace (Amazon in v1)."""

    __tablename__ = "source_offers"
    __table_args__ = (
        UniqueConstraint("provider", "external_id", "seller_id", name="uq_source_offer_external"),
        Index("ix_source_offers_provider_active", "provider", "is_active"),
        Index("ix_source_offers_price_ts", "price_timestamp"),
    )

    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), index=True)
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="amazon")
    external_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    url: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    seller_id: Mapped[str | None] = mapped_column(String(80))
    seller_name: Mapped[str | None] = mapped_column(String(160))
    sold_by_marketplace: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    condition: Mapped[ProductCondition] = mapped_column(
        StringEnum(ProductCondition), nullable=False, default=ProductCondition.NEW
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")

    # -- price ---------------------------------------------------------------
    price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    shipping_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)
    price_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Price that requires a coupon/membership; never used as the base price.
    conditional_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    conditional_price_note: Mapped[str | None] = mapped_column(Text)

    # -- inventory -----------------------------------------------------------
    stock_status: Mapped[StockStatus] = mapped_column(
        StringEnum(StockStatus), nullable=False, default=StockStatus.UNKNOWN
    )
    available_quantity: Mapped[int | None] = mapped_column(Integer)
    stock_confidence: Mapped[Decimal] = mapped_column(Ratio, nullable=False, default=Decimal("0"))
    inventory_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    max_order_quantity: Mapped[int | None] = mapped_column(Integer)

    # -- delivery ------------------------------------------------------------
    delivery_min_days: Mapped[int | None] = mapped_column(Integer)
    delivery_max_days: Mapped[int | None] = mapped_column(Integer)
    delivery_speed: Mapped[DeliverySpeed] = mapped_column(
        StringEnum(DeliverySpeed), nullable=False, default=DeliverySpeed.UNKNOWN
    )
    delivery_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_fast_shipping_eligible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    """Prime/express eligibility flag. Informational only - the engines use
    the observed delivery estimate, never the flag on its own."""

    attributes: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    raw_payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<SourceOffer {self.provider}:{self.external_id} {self.price}>"


class TargetListing(Base, IdMixin, TimestampMixin):
    """Our listing on the target marketplace, or an observed competitor listing."""

    __tablename__ = "target_listings"
    __table_args__ = (
        Index("ix_target_listings_provider_state", "provider", "state"),
        Index("ix_target_listings_price_ts", "price_timestamp"),
        UniqueConstraint("provider", "external_id", name="uq_target_listing_external"),
    )

    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), index=True)
    opportunity_id: Mapped[int | None] = mapped_column(
        ForeignKey("opportunities.id", ondelete="SET NULL"), index=True
    )
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="ebay")
    external_id: Mapped[str | None] = mapped_column(String(80), index=True)
    sku: Mapped[str | None] = mapped_column(String(80), index=True)
    url: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    category_id: Mapped[str | None] = mapped_column(String(40))
    condition: Mapped[ProductCondition] = mapped_column(
        StringEnum(ProductCondition), nullable=False, default=ProductCondition.NEW
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")

    #: ``True`` for our own listings, ``False`` for observed market listings.
    is_own_listing: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    state: Mapped[ListingState] = mapped_column(
        StringEnum(ListingState), nullable=False, default=ListingState.DRAFT
    )

    price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    shipping_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    minimum_sale_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    recommended_sale_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    price_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    handling_time_days: Mapped[int | None] = mapped_column(Integer)
    delivery_expectation_days: Mapped[int | None] = mapped_column(Integer)
    seller_id: Mapped[str | None] = mapped_column(String(80))
    attributes: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    raw_payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<TargetListing {self.provider}:{self.external_id} {self.price}>"


class PriceHistory(Base, IdMixin):
    """Append-only price observations, used for volatility and anomaly checks."""

    __tablename__ = "price_history"
    __table_args__ = (
        Index("ix_price_history_entity_ts", "entity_type", "entity_id", "observed_at"),
        Index("ix_price_history_product_ts", "product_id", "observed_at"),
    )

    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    #: ``source_offer`` | ``target_listing`` | ``market``
    entity_type: Mapped[str] = mapped_column(String(30), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")

    price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    shipping_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)
    lowest_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    median_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    highest_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    sample_size: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class InventorySnapshot(Base, IdMixin):
    __tablename__ = "inventory_snapshots"
    __table_args__ = (Index("ix_inventory_snapshots_offer_ts", "source_offer_id", "observed_at"),)

    source_offer_id: Mapped[int] = mapped_column(
        ForeignKey("source_offers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stock_status: Mapped[StockStatus] = mapped_column(StringEnum(StockStatus), nullable=False)
    available_quantity: Mapped[int | None] = mapped_column(Integer)
    stock_confidence: Mapped[Decimal] = mapped_column(Ratio, nullable=False, default=Decimal("0"))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class DeliveryEstimate(Base, IdMixin):
    __tablename__ = "delivery_estimates"
    __table_args__ = (Index("ix_delivery_estimates_offer_ts", "source_offer_id", "observed_at"),)

    source_offer_id: Mapped[int] = mapped_column(
        ForeignKey("source_offers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    min_days: Mapped[int | None] = mapped_column(Integer)
    max_days: Mapped[int | None] = mapped_column(Integer)
    speed: Mapped[DeliverySpeed] = mapped_column(
        StringEnum(DeliverySpeed), nullable=False, default=DeliverySpeed.UNKNOWN
    )
    estimated_arrival: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    shipping_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class CompetitionSnapshot(Base, IdMixin):
    """Observed competitive landscape for one product on the target marketplace."""

    __tablename__ = "competition_snapshots"
    __table_args__ = (Index("ix_competition_snapshots_product_ts", "product_id", "observed_at"),)

    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="ebay")
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")

    competitor_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    seller_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lowest_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    median_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    highest_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    #: The price we believe is actually achievable - never simply the highest.
    realistic_sale_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    price_spread_ratio: Mapped[Decimal | None] = mapped_column(Ratio)
    listing_quality_score: Mapped[Decimal | None] = mapped_column(Ratio)
    sold_last_30d: Mapped[int | None] = mapped_column(Integer)
    price_trend: Mapped[PriceTrend] = mapped_column(
        StringEnum(PriceTrend), nullable=False, default=PriceTrend.UNKNOWN
    )
    price_volatility: Mapped[Decimal | None] = mapped_column(Ratio)
    distribution: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
