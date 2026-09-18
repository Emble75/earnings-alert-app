"""Exactly-once execution.

The guarantee this module provides is narrow and important: for a given
``(scope, key)``, the wrapped work runs at most once, and a concurrent or
retried caller gets the first caller's recorded result instead of doing it
again.  That is what stops a redelivered webhook from creating a second order
and a retried worker from making a second purchase.

The uniqueness constraint on ``(scope, key)`` is what actually enforces it;
the code here just turns the resulting integrity error into a useful answer.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, TypeVar

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import ConflictError
from app.core.logging import get_logger
from app.models.ops import IdempotencyKey

T = TypeVar("T")
logger = get_logger(__name__)

STATUS_IN_PROGRESS = "IN_PROGRESS"
STATUS_COMPLETED = "COMPLETED"
STATUS_FAILED = "FAILED"


@dataclass
class IdempotentOutcome:
    replayed: bool
    record: IdempotencyKey


class IdempotencyService:
    def __init__(self, session: Session, *, ttl_hours: int = 72) -> None:
        self.session = session
        self.ttl = timedelta(hours=ttl_hours)

    def find(self, scope: str, key: str) -> IdempotencyKey | None:
        stmt = select(IdempotencyKey).where(
            IdempotencyKey.scope == scope, IdempotencyKey.key == key
        )
        return self.session.execute(stmt).scalars().first()

    def claim(self, scope: str, key: str) -> IdempotentOutcome:
        """Claim ``(scope, key)`` for this caller.

        Returns ``replayed=True`` when somebody already claimed it, in which
        case the caller must not perform the side effect.
        """
        existing = self.find(scope, key)
        if existing is not None:
            return IdempotentOutcome(replayed=True, record=existing)

        record = IdempotencyKey(
            scope=scope, key=key, status=STATUS_IN_PROGRESS, expires_at=utcnow() + self.ttl
        )
        self.session.add(record)
        try:
            self.session.flush()
        except IntegrityError:
            # Another transaction won the race between our SELECT and INSERT.
            self.session.rollback()
            existing = self.find(scope, key)
            if existing is None:  # pragma: no cover - only on a vanished row
                raise ConflictError(
                    "idempotency key conflict could not be resolved",
                    context={"scope": scope, "key": key},
                ) from None
            return IdempotentOutcome(replayed=True, record=existing)
        return IdempotentOutcome(replayed=False, record=record)

    def complete(
        self,
        record: IdempotencyKey,
        *,
        entity_type: str | None = None,
        entity_id: str | int | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        record.status = STATUS_COMPLETED
        record.entity_type = entity_type
        record.entity_id = str(entity_id) if entity_id is not None else None
        record.result = result or {}
        self.session.flush()

    def fail(self, record: IdempotencyKey, *, error: str) -> None:
        record.status = STATUS_FAILED
        record.result = {"error": error}
        self.session.flush()

    def run_once(
        self,
        scope: str,
        key: str,
        func: Callable[[], T],
        *,
        on_replay: Callable[[IdempotencyKey], T] | None = None,
    ) -> T:
        """Run ``func`` at most once for ``(scope, key)``."""
        outcome = self.claim(scope, key)
        if outcome.replayed:
            logger.info("idempotent_replay", scope=scope, key=key, status=outcome.record.status)
            if on_replay is not None:
                return on_replay(outcome.record)
            raise ConflictError(
                "this operation has already been performed",
                context={"scope": scope, "key": key, "status": outcome.record.status},
            )
        try:
            result = func()
        except Exception as exc:
            self.fail(outcome.record, error=str(exc))
            raise
        self.complete(outcome.record, result={"ok": True})
        return result
