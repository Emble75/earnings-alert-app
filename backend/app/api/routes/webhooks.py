"""Marketplace webhooks.

Webhook handling has three non-negotiables: the payload is authenticated
before anything is created from it, processing is idempotent, and every
delivery is logged whether or not it was acted on.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, Request

from app.api.deps import BusinessSettings, DbSession, Providers
from app.core.clock import utcnow
from app.core.errors import AuthenticationError
from app.core.money import Money
from app.providers.base import SaleEvent
from app.schemas.order import OrderOut, SaleWebhookPayload
from app.services.audit_service import AuditService
from app.services.order_service import OrderService

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/sales", response_model=OrderOut)
async def sale_webhook(
    request: Request,
    session: DbSession,
    config: BusinessSettings,
    providers: Providers,
    x_signature: Annotated[str | None, Header()] = None,
) -> OrderOut:
    """Receive a sale from the target marketplace."""
    raw = await request.body()
    if not providers.target.verify_webhook(raw, x_signature):
        AuditService(session).record(
            "webhook.rejected",
            entity_type="webhook",
            actor=providers.target.name,
            meta={"reason": "signature verification failed"},
        )
        session.commit()
        raise AuthenticationError("webhook signature verification failed")

    payload = SaleWebhookPayload.model_validate_json(raw)
    event = SaleEvent(
        external_order_id=payload.external_order_id,
        sku=payload.sku,
        listing_external_id=payload.listing_external_id,
        quantity=payload.quantity,
        sale_price=Money(payload.sale_price, payload.currency),
        buyer_shipping_paid=Money(payload.buyer_shipping_paid, payload.currency),
        sold_at=payload.sold_at or utcnow(),
        ship_to=payload.ship_to,
        buyer_reference=payload.buyer_reference,
        delivery_deadline=payload.delivery_deadline,
        raw=payload.model_dump(mode="json"),
    )
    service = OrderService(session, config, providers)
    order = service.ingest_sale(event)
    # Post-sale revalidation starts immediately; a failure here must not lose
    # the order, so it is recorded and left for the worker to retry.
    try:
        service.revalidate(order)
    except Exception as exc:  # noqa: BLE001 - deliberate: the order must survive
        AuditService(session).record(
            "order.revalidation_deferred",
            entity_type="order",
            entity_id=order.id,
            meta={"error": str(exc)[:300]},
        )
    session.commit()
    return OrderOut.model_validate(order)
