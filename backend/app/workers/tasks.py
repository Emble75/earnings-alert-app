"""Background tasks.

Each task opens its own transaction, does one bounded piece of work and
reports a summary.  Failures are logged with context and retried with backoff
where a retry can help; tasks that touch money rely on the service-level
idempotency keys rather than on the broker's delivery guarantees.
"""

from __future__ import annotations

from typing import Any

from celery import shared_task
from sqlalchemy import select

from app.core.clock import age_seconds
from app.core.errors import AppError
from app.core.logging import get_logger
from app.db.session import session_scope
from app.models.enums import (
    ListingState,
    NotificationEvent,
    OpportunityState,
    OrderState,
    ShipmentState,
)
from app.models.fulfillment import Return, Shipment
from app.models.market import TargetListing
from app.models.opportunity import Opportunity
from app.models.order import Order
from app.providers.registry import build_notification_providers, get_providers
from app.services.notification_service import NotificationService
from app.services.opportunity_service import OpportunityService
from app.services.order_service import OrderService
from app.services.settings_service import SettingsService

logger = get_logger(__name__)

_ACTIVE_OPPORTUNITY_STATES = (
    OpportunityState.ACTIONABLE.value,
    OpportunityState.LISTING_CANDIDATE.value,
    OpportunityState.LISTED.value,
)


def _context():
    """Open a session with the current config and providers."""
    session_ctx = session_scope()
    session = session_ctx.__enter__()
    config = SettingsService(session).load()
    return session_ctx, session, config, get_providers()


@shared_task(name="app.workers.tasks.discover_products", bind=True, max_retries=3)
def discover_products(self, query: str = "", limit: int = 20) -> dict[str, Any]:
    ctx, session, config, providers = _context()
    try:
        service = OpportunityService(session, config, providers)
        created = service.discover(query, limit=limit)
        logger.info("discover_products", found=len(created), query=query)
        return {"discovered": len(created)}
    except AppError as exc:
        logger.warning("discover_products_failed", error=str(exc), code=exc.code)
        if exc.retryable:
            raise self.retry(exc=exc, countdown=60) from exc
        return {"discovered": 0, "error": exc.code}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.calculate_opportunities")
def calculate_opportunities(limit: int = 100) -> dict[str, Any]:
    """Evaluate opportunities that have not yet reached a decision."""
    ctx, session, config, providers = _context()
    try:
        service = OpportunityService(session, config, providers)
        pending = list(
            session.execute(
                select(Opportunity)
                .where(
                    Opportunity.state.in_(
                        [
                            OpportunityState.DISCOVERED.value,
                            OpportunityState.MATCH_PENDING.value,
                            OpportunityState.MATCH_VERIFIED.value,
                            OpportunityState.PRICE_PENDING.value,
                            OpportunityState.PROFITABLE.value,
                            OpportunityState.RISK_REVIEW.value,
                        ]
                    )
                )
                .limit(limit)
            ).scalars()
        )
        actionable = 0
        for opportunity in pending:
            try:
                result = service.evaluate(opportunity)
            except AppError as exc:
                logger.warning(
                    "evaluate_failed", opportunity=opportunity.reference, error=str(exc)
                )
                continue
            if result.is_actionable:
                actionable += 1
                _notify_high_value(session, config, opportunity)
        return {"evaluated": len(pending), "actionable": actionable}
    finally:
        ctx.__exit__(None, None, None)


def _notify_high_value(session, config, opportunity: Opportunity) -> None:
    if opportunity.expected_net_profit is None:
        return
    if opportunity.expected_net_profit < config.minimum_net_profit:
        return
    NotificationService(session, build_notification_providers()).queue(
        NotificationEvent.HIGH_VALUE_OPPORTUNITY,
        subject=f"Opportunity {opportunity.reference}: {opportunity.expected_net_profit} expected profit",
        body=(
            f"Expected net profit {opportunity.expected_net_profit} {opportunity.currency}, "
            f"margin {opportunity.profit_margin}, risk {opportunity.risk_score}, "
            f"match confidence {opportunity.match_confidence}."
        ),
        entity_type="opportunity",
        entity_id=opportunity.id,
    )


@shared_task(name="app.workers.tasks.refresh_prices")
def refresh_prices(limit: int = 100) -> dict[str, Any]:
    ctx, session, config, providers = _context()
    try:
        service = OpportunityService(session, config, providers)
        rows = list(
            session.execute(
                select(Opportunity)
                .where(Opportunity.state.in_(_ACTIVE_OPPORTUNITY_STATES))
                .limit(limit)
            ).scalars()
        )
        for opportunity in rows:
            try:
                service.refresh_market_data(opportunity)
            except AppError as exc:
                logger.warning("refresh_failed", opportunity=opportunity.reference, error=str(exc))
        return {"refreshed": len(rows)}
    finally:
        ctx.__exit__(None, None, None)


#: Inventory and delivery freshness travel with the same provider call, so
#: these are thin aliases rather than duplicated logic.
@shared_task(name="app.workers.tasks.refresh_inventory")
def refresh_inventory(limit: int = 100) -> dict[str, Any]:
    return refresh_prices(limit=limit)


@shared_task(name="app.workers.tasks.refresh_delivery")
def refresh_delivery(limit: int = 100) -> dict[str, Any]:
    return refresh_prices(limit=limit)


@shared_task(name="app.workers.tasks.revalidate_opportunities")
def revalidate_opportunities(limit: int = 50) -> dict[str, Any]:
    ctx, session, config, providers = _context()
    try:
        service = OpportunityService(session, config, providers)
        rows = list(
            session.execute(
                select(Opportunity)
                .where(Opportunity.state.in_(_ACTIVE_OPPORTUNITY_STATES))
                .limit(limit)
            ).scalars()
        )
        changed = 0
        for opportunity in rows:
            previous = opportunity.state
            try:
                service.revalidate(opportunity)
            except AppError as exc:
                logger.warning("revalidate_failed", opportunity=opportunity.reference, error=str(exc))
                continue
            if opportunity.state is not previous:
                changed += 1
        return {"revalidated": len(rows), "state_changed": changed}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.monitor_listings")
def monitor_listings(limit: int = 100) -> dict[str, Any]:
    """Pull live listings that are no longer viable."""
    from app.listing.engine import ListingEngine

    ctx, session, config, providers = _context()
    try:
        engine = ListingEngine(session, config, providers)
        listings = list(
            session.execute(
                select(TargetListing)
                .where(
                    TargetListing.is_own_listing.is_(True),
                    TargetListing.state == ListingState.PUBLISHED.value,
                )
                .limit(limit)
            ).scalars()
        )
        problems_found = 0
        for listing in listings:
            opportunity = (
                session.get(Opportunity, listing.opportunity_id) if listing.opportunity_id else None
            )
            if opportunity is None:
                continue
            problems = engine.revalidate_listing(opportunity, listing)
            if problems:
                problems_found += 1
                NotificationService(session, build_notification_providers()).queue(
                    NotificationEvent.SOURCE_UNAVAILABLE,
                    subject=f"Listing {listing.sku} is no longer backed by a viable source",
                    body="; ".join(problems),
                    entity_type="target_listing",
                    entity_id=listing.id,
                )
        return {"checked": len(listings), "with_problems": problems_found}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.poll_sales")
def poll_sales() -> dict[str, Any]:
    """Pull sales from the marketplace as a backstop for missed webhooks."""
    ctx, session, config, providers = _context()
    try:
        service = OrderService(session, config, providers)
        events = providers.target.fetch_sales()
        created = 0
        for event in events:
            before = session.execute(
                select(Order).where(
                    Order.provider == providers.target.name,
                    Order.external_order_id == event.external_order_id,
                )
            ).scalars().first()
            if before is not None:
                continue
            order = service.ingest_sale(event)
            created += 1
            NotificationService(session, build_notification_providers()).queue(
                NotificationEvent.SALE_RECEIVED,
                subject=f"Sale received: {order.reference}",
                body=f"{order.quantity} unit(s) at {order.sale_price} {order.currency}",
                entity_type="order",
                entity_id=order.id,
            )
        return {"sales_seen": len(events), "orders_created": created}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.process_sale")
def process_sale(order_id: int) -> dict[str, Any]:
    ctx, session, config, providers = _context()
    try:
        order = session.get(Order, order_id)
        if order is None:
            return {"error": "order not found"}
        outcome = OrderService(session, config, providers).revalidate(order)
        if outcome.ok:
            NotificationService(session, build_notification_providers()).queue(
                NotificationEvent.APPROVAL_REQUIRED,
                subject=f"Approval required: {order.reference}",
                body=(
                    f"Expected net profit {order.expected_net_profit} {order.currency}, "
                    f"worst case {order.worst_case_net_profit}, capital {order.capital_required}, "
                    f"risk {order.risk_score}."
                ),
                entity_type="order",
                entity_id=order.id,
            )
        return {"ok": outcome.ok, "state": order.state.value, "problems": outcome.problems}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.revalidate_orders")
def revalidate_orders(limit: int = 25) -> dict[str, Any]:
    """Revalidate new sales, and refresh approvals whose data has aged out."""
    ctx, session, config, providers = _context()
    try:
        service = OrderService(session, config, providers)
        pending = list(
            session.execute(
                select(Order)
                .where(Order.state.in_([OrderState.SALE_RECEIVED.value, OrderState.VALIDATING.value]))
                .limit(limit)
            ).scalars()
        )
        approvals = list(
            session.execute(
                select(Order).where(Order.state == OrderState.APPROVAL_REQUIRED.value).limit(limit)
            ).scalars()
        )
        processed = 0
        for order in pending:
            try:
                service.revalidate(order)
                processed += 1
            except AppError as exc:
                logger.warning("order_revalidate_failed", order=order.reference, error=str(exc))

        refreshed = 0
        for order in approvals:
            age = age_seconds(order.revalidated_at)
            if age is None or age > config.max_price_age_seconds:
                try:
                    service.revalidate(order)
                    refreshed += 1
                except AppError as exc:
                    logger.warning("approval_refresh_failed", order=order.reference, error=str(exc))
        return {"revalidated": processed, "approvals_refreshed": refreshed}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.execute_approved_orders", bind=True, max_retries=3)
def execute_approved_orders(self, limit: int = 10) -> dict[str, Any]:
    """Place source purchases for approved orders.

    Automation level gates this: below level 3 the operator triggers execution
    explicitly from the UI and this task does nothing.
    """
    ctx, session, config, providers = _context()
    try:
        if config.automation_level < 3:
            return {"skipped": "automation level below 3; execution is operator-triggered"}
        service = OrderService(session, config, providers)
        orders = list(
            session.execute(
                select(Order).where(Order.state == OrderState.APPROVED.value).limit(limit)
            ).scalars()
        )
        executed = 0
        for order in orders:
            try:
                service.execute(order)
                executed += 1
            except AppError as exc:
                logger.warning("execute_failed", order=order.reference, error=str(exc), code=exc.code)
        return {"considered": len(orders), "executed": executed}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.monitor_shipments")
def monitor_shipments(limit: int = 100) -> dict[str, Any]:
    from app.services.fulfillment_service import FulfillmentService

    ctx, session, config, providers = _context()
    try:
        service = FulfillmentService(session, config, providers)
        shipments = list(
            session.execute(
                select(Shipment)
                .where(
                    Shipment.state.in_(
                        [
                            ShipmentState.SHIPPED.value,
                            ShipmentState.IN_TRANSIT.value,
                            ShipmentState.OUT_FOR_DELIVERY.value,
                        ]
                    )
                )
                .limit(limit)
            ).scalars()
        )
        updated = 0
        for shipment in shipments:
            if not shipment.tracking_number or not shipment.carrier:
                continue
            update = providers.shipping.track(shipment.tracking_number, carrier=shipment.carrier)
            if update is None:
                continue
            try:
                target = ShipmentState(update.status)
            except ValueError:
                continue
            if target is shipment.state:
                continue
            try:
                service.update_tracking(shipment, state=target, message="carrier update")
                updated += 1
            except AppError as exc:
                logger.warning("tracking_update_failed", shipment=shipment.id, error=str(exc))
        return {"checked": len(shipments), "updated": updated}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.process_returns")
def process_returns(limit: int = 50) -> dict[str, Any]:
    ctx, session, config, providers = _context()
    try:
        open_returns = list(
            session.execute(
                select(Return).where(Return.state != "CLOSED").limit(limit)
            ).scalars()
        )
        for record in open_returns:
            NotificationService(session, build_notification_providers()).queue(
                NotificationEvent.RETURN_REQUESTED,
                subject=f"Return {record.id} is open ({record.state.value})",
                body=record.reason or "no reason given",
                entity_type="return",
                entity_id=record.id,
            )
        return {"open_returns": len(open_returns)}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.send_notifications")
def send_notifications(limit: int = 50) -> dict[str, Any]:
    ctx, session, _config, _providers = _context()
    try:
        sent = NotificationService(session, build_notification_providers()).dispatch_pending(limit=limit)
        return {"sent": sent}
    finally:
        ctx.__exit__(None, None, None)


@shared_task(name="app.workers.tasks.expire_opportunities")
def expire_opportunities() -> dict[str, Any]:
    ctx, session, config, providers = _context()
    try:
        expired = OpportunityService(session, config, providers).expire_stale()
        return {"expired": expired}
    finally:
        ctx.__exit__(None, None, None)
