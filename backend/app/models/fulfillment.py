"""Fulfilment, receiving, inspection, shipping and returns.

In v1 the operator performs fulfilment by hand.  The tables below still model
it explicitly - receipts, inspections, shipments - because that is what makes
a later switch to a 3PL a provider swap rather than a rewrite.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, IdMixin, TimestampMixin
from app.db.types import JSONDict, MoneyCents, StringEnum
from app.models.enums import (
    FulfillmentMode,
    FulfillmentState,
    InspectionResult,
    ProductCondition,
    ReturnState,
    ShipmentState,
)


class FulfillmentOrder(Base, IdMixin, TimestampMixin):
    __tablename__ = "fulfillment_orders"
    __table_args__ = (
        UniqueConstraint("order_id", name="uq_fulfillment_order_order"),
        Index("ix_fulfillment_orders_state", "state"),
    )

    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="manual")
    mode: Mapped[FulfillmentMode] = mapped_column(
        StringEnum(FulfillmentMode), nullable=False, default=FulfillmentMode.MANUAL
    )
    state: Mapped[FulfillmentState] = mapped_column(
        StringEnum(FulfillmentState), nullable=False, default=FulfillmentState.PENDING
    )
    external_reference: Mapped[str | None] = mapped_column(String(80))

    # -- packaging / origin handling ----------------------------------------
    original_package: Mapped[bool | None] = mapped_column(Boolean)
    received_condition: Mapped[ProductCondition | None] = mapped_column(StringEnum(ProductCondition))
    repack_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    repacked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    packaging_type: Mapped[str | None] = mapped_column(String(60))
    package_length_cm: Mapped[int | None] = mapped_column(Integer)
    package_width_cm: Mapped[int | None] = mapped_column(Integer)
    package_height_cm: Mapped[int | None] = mapped_column(Integer)
    package_weight_grams: Mapped[int | None] = mapped_column(Integer)

    # -- actual cash costs only. No labour, no handling time, no warehouse. --
    packaging_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    provider_fees: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    fee_breakdown: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)

    notes: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    receipts: Mapped[list[WarehouseReceipt]] = relationship(
        back_populates="fulfillment_order", cascade="all, delete-orphan"
    )
    inspections: Mapped[list[Inspection]] = relationship(
        back_populates="fulfillment_order", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<FulfillmentOrder order={self.order_id} {self.state}>"


class WarehouseReceipt(Base, IdMixin, TimestampMixin):
    """Goods received - by the operator in v1, by a 3PL later."""

    __tablename__ = "warehouse_receipts"

    fulfillment_order_id: Mapped[int] = mapped_column(
        ForeignKey("fulfillment_orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_order_id: Mapped[int | None] = mapped_column(ForeignKey("source_orders.id", ondelete="SET NULL"))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expected_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    carrier: Mapped[str | None] = mapped_column(String(80))
    tracking_number: Mapped[str | None] = mapped_column(String(120))
    package_intact: Mapped[bool | None] = mapped_column(Boolean)
    location: Mapped[str | None] = mapped_column(String(80))
    photos: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    notes: Mapped[str | None] = mapped_column(Text)

    fulfillment_order: Mapped[FulfillmentOrder] = relationship(back_populates="receipts")


class Inspection(Base, IdMixin, TimestampMixin):
    """SKU / quantity / condition verification before the item goes out."""

    __tablename__ = "inspections"

    fulfillment_order_id: Mapped[int] = mapped_column(
        ForeignKey("fulfillment_orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    warehouse_receipt_id: Mapped[int | None] = mapped_column(
        ForeignKey("warehouse_receipts.id", ondelete="SET NULL")
    )
    inspected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    inspected_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    result: Mapped[InspectionResult] = mapped_column(
        StringEnum(InspectionResult), nullable=False, default=InspectionResult.PENDING
    )
    sku_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quantity_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    condition_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    accessories_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expected_identifier: Mapped[str | None] = mapped_column(String(64))
    observed_identifier: Mapped[str | None] = mapped_column(String(64))
    observed_condition: Mapped[ProductCondition | None] = mapped_column(StringEnum(ProductCondition))
    observed_quantity: Mapped[int | None] = mapped_column(Integer)
    findings: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    photos: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    notes: Mapped[str | None] = mapped_column(Text)

    fulfillment_order: Mapped[FulfillmentOrder] = relationship(back_populates="inspections")


class Shipment(Base, IdMixin, TimestampMixin):
    """An outbound (or return) shipment.

    ``idempotency_key`` is unique: a retried worker reuses the existing
    shipment instead of buying a second label.
    """

    __tablename__ = "shipments"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_shipment_idempotency"),
        Index("ix_shipments_state", "state"),
        Index("ix_shipments_tracking", "carrier", "tracking_number"),
    )

    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    fulfillment_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("fulfillment_orders.id", ondelete="SET NULL")
    )
    direction: Mapped[str] = mapped_column(String(20), nullable=False, default="OUTBOUND")
    state: Mapped[ShipmentState] = mapped_column(
        StringEnum(ShipmentState), nullable=False, default=ShipmentState.PENDING
    )
    carrier: Mapped[str | None] = mapped_column(String(80))
    service: Mapped[str | None] = mapped_column(String(80))
    tracking_number: Mapped[str | None] = mapped_column(String(120), index=True)
    tracking_url: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    destination: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    shipping_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    label_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    estimated_delivery: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_delivery: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tracking_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exception_reason: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(String(80), nullable=False)
    events: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Shipment {self.carrier}:{self.tracking_number} {self.state}>"


class Return(Base, IdMixin, TimestampMixin):
    __tablename__ = "returns"
    __table_args__ = (
        UniqueConstraint("provider", "external_return_id", name="uq_return_external"),
        Index("ix_returns_state", "state"),
    )

    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    shipment_id: Mapped[int | None] = mapped_column(ForeignKey("shipments.id", ondelete="SET NULL"))
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="ebay")
    external_return_id: Mapped[str | None] = mapped_column(String(80), index=True)
    state: Mapped[ReturnState] = mapped_column(
        StringEnum(ReturnState), nullable=False, default=ReturnState.RETURN_REQUESTED
    )
    reason: Mapped[str | None] = mapped_column(Text)
    buyer_comment: Mapped[str | None] = mapped_column(Text)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")

    refund_amount: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    return_shipping_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    restocking_recovery: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    """Value recovered by reselling or returning the item to the source."""
    fees_refunded: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    total_return_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))

    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    authorized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    inspection_result: Mapped[InspectionResult | None] = mapped_column(StringEnum(InspectionResult))
    raw_payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Return order={self.order_id} {self.state}>"
