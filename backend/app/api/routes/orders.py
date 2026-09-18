"""Order endpoints, including the one-click approval."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import BusinessSettings, CurrentUser, DbSession, Operator, Providers, TxSession
from app.core.errors import NotFoundError
from app.models.enums import OrderState
from app.models.order import Order
from app.schemas.common import Page
from app.schemas.order import (
    ApproveRequest,
    OrderDetailOut,
    OrderOut,
    RevalidateResponse,
)
from app.services.order_service import OrderService

router = APIRouter(prefix="/orders", tags=["orders"])


def _load(session, order_id: int) -> Order:
    order = session.get(Order, order_id)
    if order is None:
        raise NotFoundError(f"order {order_id} does not exist")
    return order


@router.get("", response_model=Page[OrderOut])
def list_orders(
    session: DbSession,
    user: CurrentUser,
    state: Annotated[list[OrderState] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[OrderOut]:
    conditions = []
    if state:
        conditions.append(Order.state.in_([s.value for s in state]))
    total = int(session.execute(select(func.count(Order.id)).where(*conditions)).scalar_one() or 0)
    rows = list(
        session.execute(
            select(Order).where(*conditions).order_by(Order.created_at.desc()).limit(limit).offset(offset)
        ).scalars()
    )
    return Page(
        items=[OrderOut.model_validate(row) for row in rows], total=total, limit=limit, offset=offset
    )


@router.get("/pending-approval", response_model=list[OrderDetailOut])
def pending_approvals(
    session: DbSession, user: CurrentUser, config: BusinessSettings, providers: Providers
) -> list[OrderDetailOut]:
    service = OrderService(session, config, providers)
    rows = list(
        session.execute(
            select(Order)
            .where(Order.state == OrderState.APPROVAL_REQUIRED.value)
            .order_by(Order.approval_required_at)
        ).scalars()
    )
    details = []
    for order in rows:
        detail = OrderDetailOut.model_validate(order)
        detail.approval_summary = service.approval_summary(order)
        details.append(detail)
    return details


@router.get("/{order_id}", response_model=OrderDetailOut)
def get_order(
    order_id: int,
    session: DbSession,
    user: CurrentUser,
    config: BusinessSettings,
    providers: Providers,
) -> OrderDetailOut:
    order = _load(session, order_id)
    detail = OrderDetailOut.model_validate(order)
    detail.approval_summary = OrderService(session, config, providers).approval_summary(order)
    return detail


@router.post("/{order_id}/revalidate", response_model=RevalidateResponse)
def revalidate(
    order_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> RevalidateResponse:
    order = _load(session, order_id)
    outcome = OrderService(session, config, providers).revalidate(order)
    return RevalidateResponse(
        ok=outcome.ok, state=order.state, problems=outcome.problems, checks=outcome.checks
    )


@router.post("/{order_id}/approve", response_model=OrderDetailOut)
def approve(
    order_id: int,
    payload: ApproveRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> OrderDetailOut:
    """Approve the source purchase.

    This is the single approval in the workflow. Capital limits are enforced
    here, server-side, inside the same transaction that reserves the capital.
    """
    order = _load(session, order_id)
    service = OrderService(session, config, providers)
    service.approve(order, user_id=user.id, note=payload.note)
    detail = OrderDetailOut.model_validate(order)
    detail.approval_summary = service.approval_summary(order)
    return detail


@router.post("/{order_id}/execute", response_model=OrderDetailOut)
def execute(
    order_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> OrderDetailOut:
    """Place the source purchase for an approved order (idempotent)."""
    order = _load(session, order_id)
    service = OrderService(session, config, providers)
    service.execute(order)
    detail = OrderDetailOut.model_validate(order)
    detail.approval_summary = service.approval_summary(order)
    return detail


@router.post("/{order_id}/cancel", response_model=OrderOut)
def cancel(
    order_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
    reason: Annotated[str, Query(max_length=300)] = "cancelled by operator",
) -> Order:
    order = _load(session, order_id)
    return OrderService(session, config, providers).cancel(order, reason=reason, user_id=user.id)


@router.post("/{order_id}/unblock", response_model=OrderOut)
def unblock(
    order_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Order:
    order = _load(session, order_id)
    return OrderService(session, config, providers).unblock(order)
