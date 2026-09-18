"""Shipment and return state machines."""

from __future__ import annotations

from app.models.enums import ReturnState as R
from app.models.enums import ShipmentState as S
from app.state_machines.base import build

SHIPMENT_MACHINE = build(
    "shipment",
    S.PENDING,
    [
        (S.PENDING, S.LABEL_CREATED, "label purchased", True),
        (S.PENDING, S.EXCEPTION, "label creation failed"),
        (S.LABEL_CREATED, S.SHIPPED, "handed to carrier"),
        (S.LABEL_CREATED, S.EXCEPTION, "never handed over"),
        (S.SHIPPED, S.IN_TRANSIT, "carrier scan"),
        (S.SHIPPED, S.EXCEPTION, "carrier exception"),
        (S.IN_TRANSIT, S.OUT_FOR_DELIVERY, "out for delivery"),
        (S.IN_TRANSIT, S.EXCEPTION, "carrier exception"),
        (S.IN_TRANSIT, S.LOST, "declared lost"),
        (S.IN_TRANSIT, S.DELIVERED, "delivered"),
        (S.OUT_FOR_DELIVERY, S.DELIVERED, "delivered"),
        (S.OUT_FOR_DELIVERY, S.EXCEPTION, "delivery failed"),
        (S.EXCEPTION, S.IN_TRANSIT, "exception resolved"),
        (S.EXCEPTION, S.DELIVERED, "delivered after exception"),
        (S.EXCEPTION, S.LOST, "declared lost"),
        (S.EXCEPTION, S.RETURNED, "returned to sender"),
        (S.DELIVERED, S.RETURNED, "returned after delivery"),
        (S.OUT_FOR_DELIVERY, S.RETURNED, "refused by recipient"),
    ],
    terminal=(S.DELIVERED, S.LOST, S.RETURNED),
)
# DELIVERED is not strictly terminal (a return can follow) - the return is
# tracked as its own shipment, so the delivered leg stays closed.
SHIPMENT_MACHINE.terminal_states = frozenset({S.LOST, S.RETURNED})

RETURN_MACHINE = build(
    "return",
    R.RETURN_REQUESTED,
    [
        (R.RETURN_REQUESTED, R.RETURN_AUTHORIZED, "return authorised"),
        (R.RETURN_REQUESTED, R.CLOSED, "request withdrawn"),
        (R.RETURN_AUTHORIZED, R.RETURN_IN_TRANSIT, "buyer shipped it back"),
        (R.RETURN_AUTHORIZED, R.CLOSED, "return never sent"),
        (R.RETURN_IN_TRANSIT, R.RETURN_RECEIVED, "received by operator"),
        (R.RETURN_IN_TRANSIT, R.CLOSED, "lost return - written off"),
        (R.RETURN_RECEIVED, R.INSPECTION_REQUIRED, "inspection queued"),
        (R.INSPECTION_REQUIRED, R.REFUND_REQUIRED, "inspection complete"),
        (R.INSPECTION_REQUIRED, R.CLOSED, "refund not owed"),
        (R.REFUND_REQUIRED, R.REFUNDED, "refund issued", True),
        (R.REFUNDED, R.CLOSED, "closed"),
    ],
    terminal=(R.CLOSED,),
)
