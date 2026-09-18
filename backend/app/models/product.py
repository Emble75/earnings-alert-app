"""Products, their identifiers, and cross-marketplace matches."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, IdMixin, TimestampMixin
from app.db.types import JSONDict, Ratio, StringEnum
from app.models.enums import IdentifierType, MatchMethod, MatchStatus, ProductCondition


class Product(Base, IdMixin, TimestampMixin):
    """A canonical product, independent of any marketplace."""

    __tablename__ = "products"
    __table_args__ = (
        Index("ix_products_brand_model", "brand", "model"),
        Index("ix_products_primary_identifier", "primary_identifier_value"),
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    brand: Mapped[str | None] = mapped_column(String(160), index=True)
    manufacturer: Mapped[str | None] = mapped_column(String(160))
    model: Mapped[str | None] = mapped_column(String(160))
    category: Mapped[str | None] = mapped_column(String(160), index=True)
    condition: Mapped[ProductCondition] = mapped_column(
        StringEnum(ProductCondition), nullable=False, default=ProductCondition.NEW
    )
    primary_identifier_type: Mapped[IdentifierType | None] = mapped_column(StringEnum(IdentifierType))
    primary_identifier_value: Mapped[str | None] = mapped_column(String(64))

    #: Normalised variant attributes (size, colour, capacity, edition, region,
    #: quantity, included accessories...).  The matcher compares these.
    attributes: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    image_urls: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    identifiers: Mapped[list[ProductIdentifier]] = relationship(
        back_populates="product", cascade="all, delete-orphan", lazy="selectin"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Product {self.id} {self.brand} {self.model}>"


class ProductIdentifier(Base, IdMixin, TimestampMixin):
    __tablename__ = "product_identifiers"
    __table_args__ = (
        UniqueConstraint("product_id", "identifier_type", "value", name="uq_product_identifier"),
        Index("ix_product_identifiers_lookup", "identifier_type", "value"),
    )

    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    identifier_type: Mapped[IdentifierType] = mapped_column(StringEnum(IdentifierType), nullable=False)
    value: Mapped[str] = mapped_column(String(64), nullable=False)
    #: Where the identifier came from (provider name, manual entry, ...).
    source: Mapped[str] = mapped_column(String(60), nullable=False, default="unknown")
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    product: Mapped[Product] = relationship(back_populates="identifiers")


class ProductMatch(Base, IdMixin, TimestampMixin):
    """A decision that a source offer and a target listing are the same item."""

    __tablename__ = "product_matches"
    __table_args__ = (
        UniqueConstraint("source_offer_id", "target_listing_id", name="uq_match_offer_listing"),
        Index("ix_product_matches_status", "status", "confidence"),
    )

    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), index=True)
    source_offer_id: Mapped[int] = mapped_column(
        ForeignKey("source_offers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_listing_id: Mapped[int] = mapped_column(
        ForeignKey("target_listings.id", ondelete="CASCADE"), nullable=False, index=True
    )

    status: Mapped[MatchStatus] = mapped_column(StringEnum(MatchStatus), nullable=False)
    method: Mapped[MatchMethod] = mapped_column(StringEnum(MatchMethod), nullable=False)
    confidence: Mapped[Decimal] = mapped_column(Ratio, nullable=False, default=Decimal("0"))
    #: Per-signal evidence, e.g. {"EAN": "exact", "brand": "exact", ...}
    evidence: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    #: Conflicting signals; a non-empty list forces BLOCKED.
    conflicts: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    matcher_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    match_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    reviewed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    review_note: Mapped[str | None] = mapped_column(Text)
    quantity_ratio: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    """How many source units make up one target unit (bundle handling)."""

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ProductMatch {self.id} {self.status} {self.confidence}>"
