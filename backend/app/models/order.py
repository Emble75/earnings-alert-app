"""Orders: the money path from an eBay sale to a realized profit."""

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
from app.db.types import JSONDict, MoneyCents, Ratio, StringEnum
from app.models.enums import (
    CapitalReservationState,
    ExecutionMode,
    OrderState,
    SourceOrderState,
)


class Order(Base, IdMixin, TimestampMixin):
    """A sale on the target marketplace and everything it triggers."""

    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("provider", "external_order_id", name="uq_order_external"),
        Index("ix_orders_state_created", "state", "created_at"),
        Index("ix_orders_approval", "state", "approval_required_at"),
    )

    reference: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    opportunity_id: Mapped[int | None] = mapped_column(
        ForeignKey("opportunities.id", ondelete="SET NULL"), index=True
    )
    target_listing_id: Mapped[int | None] = mapped_column(
        ForeignKey("target_listings.id", ondelete="SET NULL")
    )
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))

    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="ebay")
    external_order_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    state: Mapped[OrderState] = mapped_column(
        StringEnum(OrderState), nullable=False, default=OrderState.SALE_RECEIVED, index=True
    )
    execution_mode: Mapped[ExecutionMode] = mapped_column(
        StringEnum(ExecutionMode), nullable=False, default=ExecutionMode.DEMO
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # -- the sale ------------------------------------------------------------
    sale_price: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False)
    buyer_shipping_paid: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    sold_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    buyer_reference: Mapped[str | None] = mapped_column(String(120))
    ship_to: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    buyer_delivery_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # -- expectation at approval time ---------------------------------------
    expected_net_profit: Mapped[Decimal | None] = mapped_column(MoneyCents)
    worst_case_net_profit: Mapped[Decimal | None] = mapped_column(MoneyCents)
    expected_margin: Mapped[Decimal | None] = mapped_column(Ratio)
    expected_roi: Mapped[Decimal | None] = mapped_column(Ratio)
    capital_required: Mapped[Decimal | None] = mapped_column(MoneyCents)
    #: The source unit price the approval was calculated from. The purchase
    #: refuses to pay more than this, so a price move between approval and
    #: execution fails the order instead of silently eating the margin.
    approved_source_unit_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    risk_score: Mapped[int | None] = mapped_column(Integer)
    match_confidence: Mapped[Decimal | None] = mapped_column(Ratio)

    # -- realization ---------------------------------------------------------
    realized_revenue: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_source_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_fees: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_shipping: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_packaging: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_return_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_other_costs: Mapped[Decimal | None] = mapped_column(MoneyCents)
    realized_net_profit: Mapped[Decimal | None] = mapped_column(MoneyCents)
    profit_variance: Mapped[Decimal | None] = mapped_column(MoneyCents)
    """``realized_net_profit - expected_net_profit``; negative means we did
    worse than the approval screen promised."""

    # -- workflow bookkeeping ------------------------------------------------
    revalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revalidation_result: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    approval_required_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approval_note: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    failure_reason: Mapped[str | None] = mapped_column(Text)
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)

    events: Mapped[list[OrderEvent]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="OrderEvent.occurred_at"
    )
    source_orders: Mapped[list[SourceOrder]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Order {self.reference} {self.state}>"


class OrderEvent(Base, IdMixin):
    """Append-only order history. Every transition writes exactly one row."""

    __tablename__ = "order_events"
    __table_args__ = (
        Index("ix_order_events_order_ts", "order_id", "occurred_at"),
        UniqueConstraint("order_id", "idempotency_key", name="uq_order_event_idempotency"),
    )

    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    from_state: Mapped[OrderState | None] = mapped_column(StringEnum(OrderState))
    to_state: Mapped[OrderState | None] = mapped_column(StringEnum(OrderState))
    actor: Mapped[str] = mapped_column(String(80), nullable=False, default="system")
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    message: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    idempotency_key: Mapped[str | None] = mapped_column(String(80))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    order: Mapped[Order] = relationship(back_populates="events")


class SourceOrder(Base, IdMixin, TimestampMixin):
    """The purchase we make from the source marketplace after approval."""

    __tablename__ = "source_orders"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_source_order_idempotency"),
        Index("ix_source_orders_state", "state"),
    )

    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_offer_id: Mapped[int | None] = mapped_column(ForeignKey("source_offers.id", ondelete="SET NULL"))
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="amazon")
    external_order_id: Mapped[str | None] = mapped_column(String(80), index=True)
    state: Mapped[SourceOrderState] = mapped_column(
        StringEnum(SourceOrderState), nullable=False, default=SourceOrderState.PENDING
    )
    execution_mode: Mapped[ExecutionMode] = mapped_column(
        StringEnum(ExecutionMode), nullable=False, default=ExecutionMode.DEMO
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    unit_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    shipping_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)
    tax: Mapped[Decimal | None] = mapped_column(MoneyCents)
    total_cost: Mapped[Decimal | None] = mapped_column(MoneyCents)

    #: Derived from (order id, offer id, quantity) - the single guarantee that
    #: a worker retry cannot buy the same item twice.
    idempotency_key: Mapped[str] = mapped_column(String(80), nullable=False)
    placed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    estimated_delivery: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tracking_number: Mapped[str | None] = mapped_column(String(120))
    carrier: Mapped[str | None] = mapped_column(String(80))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)

    order: Mapped[Order] = relationship(back_populates="source_orders")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<SourceOrder {self.provider}:{self.external_order_id} {self.state}>"


class CapitalReservation(Base, IdMixin, TimestampMixin):
    """Server-side capital accounting.

    Exposure is the sum of ``RESERVED`` + ``COMMITTED`` rows.  Limits are
    enforced against this table inside the approval transaction, so the UI
    cannot route around them.
    """

    __tablename__ = "capital_reservations"
    __table_args__ = (
        Index("ix_capital_reservations_state", "state"),
        UniqueConstraint("order_id", "purpose", name="uq_capital_reservation_order_purpose"),
    )

    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    opportunity_id: Mapped[int | None] = mapped_column(ForeignKey("opportunities.id", ondelete="CASCADE"))
    purpose: Mapped[str] = mapped_column(String(40), nullable=False, default="source_purchase")
    amount: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    state: Mapped[CapitalReservationState] = mapped_column(
        StringEnum(CapitalReservationState), nullable=False, default=CapitalReservationState.RESERVED
    )
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[str | None] = mapped_column(Text)
