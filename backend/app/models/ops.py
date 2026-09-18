"""Operational plumbing: audit, notifications, idempotency, provider health."""

from __future__ import annotations

from datetime import datetime

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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin
from app.db.types import JSONDict, StringEnum
from app.models.enums import (
    ComplianceCheckType,
    DecisionOutcome,
    NotificationChannel,
    NotificationEvent,
    NotificationStatus,
)


class AuditLog(Base, IdMixin):
    """Append-only record of everything that mattered."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_entity", "entity_type", "entity_id", "occurred_at"),
        Index("ix_audit_logs_action_ts", "action", "occurred_at"),
    )

    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(60))
    actor: Mapped[str] = mapped_column(String(80), nullable=False, default="system")
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    old_state: Mapped[str | None] = mapped_column(String(60))
    new_state: Mapped[str | None] = mapped_column(String(60))
    request_id: Mapped[str | None] = mapped_column(String(60), index=True)
    meta: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<AuditLog {self.action} {self.entity_type}:{self.entity_id}>"


class Notification(Base, IdMixin, TimestampMixin):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_status", "status", "created_at"),
        UniqueConstraint("dedupe_key", name="uq_notification_dedupe"),
    )

    event: Mapped[NotificationEvent] = mapped_column(StringEnum(NotificationEvent), nullable=False)
    channel: Mapped[NotificationChannel] = mapped_column(StringEnum(NotificationChannel), nullable=False)
    status: Mapped[NotificationStatus] = mapped_column(
        StringEnum(NotificationStatus), nullable=False, default=NotificationStatus.PENDING
    )
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(60))
    entity_id: Mapped[str | None] = mapped_column(String(60))
    dedupe_key: Mapped[str | None] = mapped_column(String(120))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)


class IdempotencyKey(Base, IdMixin, TimestampMixin):
    """Exactly-once guard for webhooks, purchases, labels and refunds."""

    __tablename__ = "idempotency_keys"
    __table_args__ = (UniqueConstraint("scope", "key", name="uq_idempotency_scope_key"),)

    scope: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="IN_PROGRESS")
    entity_type: Mapped[str | None] = mapped_column(String(60))
    entity_id: Mapped[str | None] = mapped_column(String(60))
    result: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class ProviderHealth(Base, IdMixin, TimestampMixin):
    """Circuit-breaker and rate-limit state per provider."""

    __tablename__ = "provider_health"
    __table_args__ = (UniqueConstraint("provider", name="uq_provider_health_provider"),)

    provider: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="HEALTHY")
    circuit_state: Mapped[str] = mapped_column(String(20), nullable=False, default="CLOSED")
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_requests: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_failure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    circuit_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retry_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class ComplianceCheck(Base, IdMixin, TimestampMixin):
    """Result of a server-side compliance gate before an external action."""

    __tablename__ = "compliance_checks"
    __table_args__ = (Index("ix_compliance_checks_entity", "entity_type", "entity_id", "checked_at"),)

    check_type: Mapped[ComplianceCheckType] = mapped_column(
        StringEnum(ComplianceCheckType), nullable=False
    )
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(60))
    outcome: Mapped[DecisionOutcome] = mapped_column(StringEnum(DecisionOutcome), nullable=False)
    #: ``[{"rule": "...", "outcome": "PASS", "message": "..."}, ...]``
    results: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    ruleset_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    is_blocking: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
