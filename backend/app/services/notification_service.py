"""Notifications.

Notifications are persisted first and delivered second, so a channel outage
never loses an alert and never blocks an order.  ``dedupe_key`` stops the same
alert being sent twice when a worker retries.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.ids import deterministic_key
from app.core.logging import get_logger
from app.models.enums import NotificationChannel, NotificationEvent, NotificationStatus
from app.models.ops import Notification
from app.providers.base import NotificationProvider

logger = get_logger(__name__)

#: Which events reach which channels by default. Overridable per event through
#: the settings table (``notify_<EVENT>`` keys).
DEFAULT_ROUTING: dict[NotificationEvent, tuple[NotificationChannel, ...]] = {
    NotificationEvent.HIGH_VALUE_OPPORTUNITY: (NotificationChannel.IN_APP,),
    NotificationEvent.LISTING_PUBLISHED: (NotificationChannel.IN_APP,),
    NotificationEvent.SALE_RECEIVED: (NotificationChannel.IN_APP, NotificationChannel.TELEGRAM),
    NotificationEvent.APPROVAL_REQUIRED: (
        NotificationChannel.IN_APP,
        NotificationChannel.TELEGRAM,
        NotificationChannel.EMAIL,
    ),
    NotificationEvent.SOURCE_PRICE_CHANGED: (NotificationChannel.IN_APP,),
    NotificationEvent.SOURCE_UNAVAILABLE: (NotificationChannel.IN_APP, NotificationChannel.TELEGRAM),
    NotificationEvent.RISK_INCREASED: (NotificationChannel.IN_APP,),
    NotificationEvent.SHIPMENT_DELAYED: (NotificationChannel.IN_APP,),
    NotificationEvent.DELIVERY_EXCEPTION: (NotificationChannel.IN_APP, NotificationChannel.TELEGRAM),
    NotificationEvent.RETURN_REQUESTED: (NotificationChannel.IN_APP, NotificationChannel.TELEGRAM),
    NotificationEvent.ORDER_COMPLETED: (NotificationChannel.IN_APP,),
    NotificationEvent.PROFIT_REALIZED: (NotificationChannel.IN_APP,),
    NotificationEvent.COMPLIANCE_BLOCKED: (NotificationChannel.IN_APP, NotificationChannel.EMAIL),
    NotificationEvent.CAPITAL_LIMIT_REACHED: (NotificationChannel.IN_APP, NotificationChannel.EMAIL),
}


class NotificationService:
    def __init__(
        self,
        session: Session,
        providers: dict[NotificationChannel, NotificationProvider] | None = None,
        *,
        routing: dict[NotificationEvent, tuple[NotificationChannel, ...]] | None = None,
    ) -> None:
        self.session = session
        self.providers = providers or {}
        self.routing = routing or DEFAULT_ROUTING

    def queue(
        self,
        event: NotificationEvent,
        *,
        subject: str,
        body: str,
        entity_type: str | None = None,
        entity_id: str | int | None = None,
        payload: dict[str, Any] | None = None,
        channels: tuple[NotificationChannel, ...] | None = None,
    ) -> list[Notification]:
        targets = channels or self.routing.get(event, (NotificationChannel.IN_APP,))
        queued: list[Notification] = []
        for channel in targets:
            if channel is not NotificationChannel.IN_APP and channel not in self.providers:
                continue  # channel not configured - silently skip, never fail the order
            dedupe = deterministic_key(event.value, channel.value, entity_type or "", entity_id or "")
            notification = Notification(
                event=event,
                channel=channel,
                status=NotificationStatus.PENDING,
                subject=subject,
                body=body,
                entity_type=entity_type,
                entity_id=str(entity_id) if entity_id is not None else None,
                dedupe_key=dedupe,
                payload=payload or {},
            )
            self.session.add(notification)
            try:
                self.session.flush()
            except IntegrityError:
                self.session.rollback()
                logger.info("notification_deduplicated", event=event.value, channel=channel.value)
                continue
            queued.append(notification)
        return queued

    def dispatch_pending(self, *, limit: int = 50, max_attempts: int = 5) -> int:
        stmt = (
            select(Notification)
            .where(Notification.status == NotificationStatus.PENDING)
            .order_by(Notification.created_at)
            .limit(limit)
        )
        sent = 0
        for notification in self.session.execute(stmt).scalars():
            provider = self.providers.get(notification.channel)
            if provider is None:
                notification.status = NotificationStatus.SUPPRESSED
                notification.last_error = "channel not configured"
                continue
            notification.attempts += 1
            try:
                ok = provider.send(
                    subject=notification.subject,
                    body=notification.body,
                    payload=notification.payload,
                )
            except Exception as exc:  # a channel must never break the caller
                ok = False
                notification.last_error = str(exc)[:500]
            if ok:
                notification.status = NotificationStatus.SENT
                notification.sent_at = utcnow()
                sent += 1
            elif notification.attempts >= max_attempts:
                notification.status = NotificationStatus.FAILED
        self.session.flush()
        return sent

    def unread(self, *, limit: int = 50) -> list[Notification]:
        stmt = (
            select(Notification)
            .where(Notification.channel == NotificationChannel.IN_APP, Notification.read_at.is_(None))
            .order_by(Notification.created_at.desc())
            .limit(limit)
        )
        return list(self.session.execute(stmt).scalars())

    def mark_read(self, notification_id: int) -> Notification | None:
        notification = self.session.get(Notification, notification_id)
        if notification is not None:
            notification.read_at = utcnow()
            self.session.flush()
        return notification
