"""Fulfilment, shipment and return endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import BusinessSettings, CurrentUser, DbSession, Operator, Providers, TxSession
from app.core.errors import NotFoundError
from app.models.fulfillment import Return, Shipment
from app.models.order import Order
from app.schemas.common import Page
from app.schemas.order import (
    InspectRequest,
    OrderOut,
    ReceiveRequest,
    RepackRequest,
    ReturnOut,
    ReturnRequest,
    ShipmentOut,
    ShipRequest,
    TrackingUpdateRequest,
)
from app.services.fulfillment_service import FulfillmentService
from app.services.return_service import ReturnService

router = APIRouter(tags=["fulfillment"])


def _order(session, order_id: int) -> Order:
    order = session.get(Order, order_id)
    if order is None:
        raise NotFoundError(f"order {order_id} does not exist")
    return order


@router.post("/fulfillment/{order_id}/receive", response_model=OrderOut)
def receive(
    order_id: int,
    payload: ReceiveRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Order:
    order = _order(session, order_id)
    FulfillmentService(session, config, providers).receive(
        order,
        received_quantity=payload.received_quantity,
        package_intact=payload.package_intact,
        carrier=payload.carrier,
        tracking_number=payload.tracking_number,
        notes=payload.notes,
    )
    return order


@router.post("/fulfillment/{order_id}/inspect", response_model=OrderOut)
def inspect(
    order_id: int,
    payload: InspectRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Order:
    order = _order(session, order_id)
    FulfillmentService(session, config, providers).inspect(
        order,
        observed_identifier=payload.observed_identifier,
        observed_condition=payload.observed_condition,
        observed_quantity=payload.observed_quantity,
        accessories_complete=payload.accessories_complete,
        user_id=user.id,
        notes=payload.notes,
    )
    return order


@router.post("/fulfillment/{order_id}/repack", response_model=OrderOut)
def repack(
    order_id: int,
    payload: RepackRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Order:
    order = _order(session, order_id)
    FulfillmentService(session, config, providers).repack(
        order, original_package_usable=payload.original_package_usable, reason=payload.reason
    )
    return order


@router.post("/fulfillment/{order_id}/ship", response_model=ShipmentOut)
def ship(
    order_id: int,
    payload: ShipRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Shipment:
    order = _order(session, order_id)
    return FulfillmentService(session, config, providers).ship(
        order, carrier=payload.carrier, service=payload.service
    )


@router.get("/shipments", response_model=Page[ShipmentOut])
def list_shipments(
    session: DbSession,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[ShipmentOut]:
    total = int(session.execute(select(func.count(Shipment.id))).scalar_one() or 0)
    rows = list(
        session.execute(
            select(Shipment).order_by(Shipment.created_at.desc()).limit(limit).offset(offset)
        ).scalars()
    )
    return Page(
        items=[ShipmentOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.post("/shipments/{shipment_id}/tracking", response_model=ShipmentOut)
def update_tracking(
    shipment_id: int,
    payload: TrackingUpdateRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Shipment:
    shipment = session.get(Shipment, shipment_id)
    if shipment is None:
        raise NotFoundError(f"shipment {shipment_id} does not exist")
    return FulfillmentService(session, config, providers).update_tracking(
        shipment, state=payload.state, message=payload.message
    )


@router.get("/returns", response_model=Page[ReturnOut])
def list_returns(
    session: DbSession,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[ReturnOut]:
    total = int(session.execute(select(func.count(Return.id))).scalar_one() or 0)
    rows = list(
        session.execute(
            select(Return).order_by(Return.created_at.desc()).limit(limit).offset(offset)
        ).scalars()
    )
    return Page(
        items=[ReturnOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.post("/orders/{order_id}/returns", response_model=ReturnOut)
def request_return(
    order_id: int,
    payload: ReturnRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Return:
    order = _order(session, order_id)
    return ReturnService(session, config, providers).request(
        order,
        reason=payload.reason,
        external_return_id=payload.external_return_id,
        buyer_comment=payload.buyer_comment,
    )


@router.post("/returns/{return_id}/refund", response_model=ReturnOut)
def refund_return(
    return_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Return:
    record = session.get(Return, return_id)
    if record is None:
        raise NotFoundError(f"return {return_id} does not exist")
    return ReturnService(session, config, providers).refund(record)


@router.post("/orders/{order_id}/finalize", response_model=OrderOut)
def finalize(
    order_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> Order:
    """Compute realized profit and close the order."""
    order = _order(session, order_id)
    return ReturnService(session, config, providers).finalize(order)
