"""Order state machine (sale -> realized profit).

Ordering note: ``APPROVAL_REQUIRED`` is only reachable through
``REVALIDATION_REQUIRED``.  The system therefore cannot present an approval
screen built on stale numbers, and cannot purchase without one.
"""

from __future__ import annotations

from app.models.enums import OrderState as S
from app.state_machines.base import build

_ACTIVE = [
    S.SALE_RECEIVED,
    S.VALIDATING,
    S.REVALIDATION_REQUIRED,
    S.APPROVAL_REQUIRED,
    S.APPROVED,
    S.SOURCE_PURCHASE_PENDING,
    S.SOURCE_PURCHASED,
    S.SOURCE_SHIPPING,
    S.SOURCE_RECEIVED,
    S.INSPECTION,
    S.FULFILLMENT,
    S.OUTBOUND_SHIPPING,
    S.SHIPPED,
]

_EDGES: list[tuple] = [
    (S.SALE_RECEIVED, S.VALIDATING, "live revalidation started"),
    (S.VALIDATING, S.REVALIDATION_REQUIRED, "inputs refreshed, awaiting decision"),
    (S.VALIDATING, S.BLOCKED, "compliance / availability block"),
    (S.VALIDATING, S.FAILED, "validation error"),
    (S.REVALIDATION_REQUIRED, S.APPROVAL_REQUIRED, "revalidation passed"),
    (S.REVALIDATION_REQUIRED, S.BLOCKED, "revalidation blocked"),
    (S.REVALIDATION_REQUIRED, S.VALIDATING, "revalidate again"),
    (S.REVALIDATION_REQUIRED, S.CANCELLED, "operator cancelled"),
    (S.APPROVAL_REQUIRED, S.APPROVED, "operator approved source purchase"),
    (S.APPROVAL_REQUIRED, S.REVALIDATION_REQUIRED, "approval data went stale"),
    (S.APPROVAL_REQUIRED, S.BLOCKED, "limit or compliance block"),
    (S.APPROVAL_REQUIRED, S.CANCELLED, "operator declined"),
    (S.APPROVED, S.SOURCE_PURCHASE_PENDING, "purchase dispatched", True),
    (S.APPROVED, S.CANCELLED, "cancelled before purchase"),
    (S.SOURCE_PURCHASE_PENDING, S.SOURCE_PURCHASED, "source order confirmed", True),
    (S.SOURCE_PURCHASE_PENDING, S.FAILED, "purchase failed"),
    (S.SOURCE_PURCHASE_PENDING, S.REVALIDATION_REQUIRED, "price/stock changed at purchase time"),
    (S.SOURCE_PURCHASED, S.SOURCE_SHIPPING, "source dispatched"),
    (S.SOURCE_PURCHASED, S.CANCELLED, "source cancelled the order"),
    (S.SOURCE_SHIPPING, S.SOURCE_RECEIVED, "package received by operator"),
    (S.SOURCE_SHIPPING, S.FAILED, "lost in transit"),
    (S.SOURCE_RECEIVED, S.INSPECTION, "inspection started"),
    (S.INSPECTION, S.FULFILLMENT, "inspection passed"),
    (S.INSPECTION, S.FAILED, "inspection failed"),
    (S.FULFILLMENT, S.OUTBOUND_SHIPPING, "outbound shipment created", True),
    (S.OUTBOUND_SHIPPING, S.SHIPPED, "tracking uploaded", True),
    (S.SHIPPED, S.DELIVERED, "carrier confirmed delivery"),
    (S.SHIPPED, S.RETURN_REQUESTED, "buyer opened a return"),
    (S.SHIPPED, S.FAILED, "delivery exception"),
    (S.DELIVERED, S.RETURN_REQUESTED, "buyer opened a return"),
    (S.DELIVERED, S.COMPLETED, "settled"),
    (S.RETURN_REQUESTED, S.RETURNED, "return received"),
    (S.RETURN_REQUESTED, S.COMPLETED, "return withdrawn"),
    (S.RETURNED, S.COMPLETED, "refund settled"),
    (S.BLOCKED, S.REVALIDATION_REQUIRED, "block cleared"),
    (S.BLOCKED, S.CANCELLED, "block confirmed"),
    (S.BLOCKED, S.FAILED, "unrecoverable block"),
]

_EDGES += [(state, S.FAILED, "unrecoverable error") for state in _ACTIVE]
_EDGES += [
    (state, S.CANCELLED, "cancelled by operator")
    for state in (S.SALE_RECEIVED, S.VALIDATING, S.SOURCE_PURCHASE_PENDING)
]

ORDER_MACHINE = build(
    "order",
    S.SALE_RECEIVED,
    _EDGES,
    terminal=(S.COMPLETED, S.FAILED, S.CANCELLED),
)

#: States in which capital is committed and a source purchase already exists.
CAPITAL_COMMITTED_STATES = frozenset(
    {
        S.SOURCE_PURCHASE_PENDING,
        S.SOURCE_PURCHASED,
        S.SOURCE_SHIPPING,
        S.SOURCE_RECEIVED,
        S.INSPECTION,
        S.FULFILLMENT,
        S.OUTBOUND_SHIPPING,
        S.SHIPPED,
    }
)
