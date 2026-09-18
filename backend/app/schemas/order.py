from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import Field

from app.models.enums import OrderState, ProductCondition, ShipmentState
from app.schemas.common import ApiModel, DecimalStringMixin


class OrderOut(ApiModel, DecimalStringMixin):
    id: int
    reference: str
    state: OrderState
    provider: str
    external_order_id: str
    currency: str
    quantity: int
    sale_price: Decimal
    buyer_shipping_paid: Decimal
    sold_at: datetime | None = None
    expected_net_profit: Decimal | None = None
    worst_case_net_profit: Decimal | None = None
    expected_margin: Decimal | None = None
    expected_roi: Decimal | None = None
    capital_required: Decimal | None = None
    risk_score: int | None = None
    match_confidence: Decimal | None = None
    realized_net_profit: Decimal | None = None
    profit_variance: Decimal | None = None
    revalidated_at: datetime | None = None
    approval_required_at: datetime | None = None
    approved_at: datetime | None = None
    completed_at: datetime | None = None
    blocked_reason: str | None = None
    failure_reason: str | None = None
    created_at: datetime


class OrderEventOut(ApiModel):
    event_type: str
    from_state: OrderState | None = None
    to_state: OrderState | None = None
    actor: str
    message: str | None = None
    payload: dict = Field(default_factory=dict)
    occurred_at: datetime


class OrderDetailOut(OrderOut):
    events: list[OrderEventOut] = Field(default_factory=list)
    approval_summary: dict[str, Any] = Field(default_factory=dict)


class ApproveRequest(ApiModel):
    note: str = Field(default="", max_length=500)


class RevalidateResponse(ApiModel):
    ok: bool
    state: OrderState
    problems: list[str] = Field(default_factory=list)
    checks: dict[str, str] = Field(default_factory=dict)


class ReceiveRequest(ApiModel):
    received_quantity: int = Field(ge=0, le=1000)
    package_intact: bool | None = None
    carrier: str | None = Field(default=None, max_length=80)
    tracking_number: str | None = Field(default=None, max_length=120)
    notes: str = Field(default="", max_length=1000)


class InspectRequest(ApiModel):
    observed_identifier: str | None = Field(default=None, max_length=64)
    observed_condition: ProductCondition = ProductCondition.NEW
    observed_quantity: int | None = Field(default=None, ge=0, le=1000)
    accessories_complete: bool = True
    notes: str = Field(default="", max_length=1000)


class RepackRequest(ApiModel):
    original_package_usable: bool
    reason: str = Field(default="", max_length=300)


class ShipRequest(ApiModel):
    carrier: str | None = Field(default=None, max_length=80)
    service: str | None = Field(default=None, max_length=80)


class ShipmentOut(ApiModel, DecimalStringMixin):
    id: int
    order_id: int
    direction: str
    state: ShipmentState
    carrier: str | None = None
    service: str | None = None
    tracking_number: str | None = None
    tracking_url: str | None = None
    shipping_cost: Decimal
    currency: str
    estimated_delivery: datetime | None = None
    actual_delivery: datetime | None = None
    exception_reason: str | None = None
    created_at: datetime


class TrackingUpdateRequest(ApiModel):
    state: ShipmentState
    message: str = Field(default="", max_length=300)


class ReturnOut(ApiModel, DecimalStringMixin):
    id: int
    order_id: int
    state: str
    reason: str | None = None
    refund_amount: Decimal
    return_shipping_cost: Decimal
    restocking_recovery: Decimal
    total_return_cost: Decimal
    currency: str
    requested_at: datetime | None = None
    closed_at: datetime | None = None


class ReturnRequest(ApiModel):
    reason: str = Field(max_length=300)
    buyer_comment: str = Field(default="", max_length=1000)
    external_return_id: str | None = Field(default=None, max_length=80)


class SaleWebhookPayload(ApiModel):
    """Inbound sale notification from the target marketplace."""

    external_order_id: str = Field(max_length=80)
    listing_external_id: str | None = Field(default=None, max_length=80)
    sku: str | None = Field(default=None, max_length=80)
    quantity: int = Field(default=1, ge=1, le=1000)
    sale_price: Decimal
    buyer_shipping_paid: Decimal = Decimal("0")
    currency: str = "EUR"
    sold_at: datetime | None = None
    ship_to: dict[str, Any] = Field(default_factory=dict)
    buyer_reference: str | None = Field(default=None, max_length=120)
    delivery_deadline: datetime | None = None
