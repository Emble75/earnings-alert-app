"""Audit logging.

Cheap to call, impossible to forget: every service that changes state calls
:meth:`AuditService.record`, and the row carries who, what, when, the old and
new state and the request that caused it.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.logging import get_logger, request_id_var
from app.models.ops import AuditLog

logger = get_logger(__name__)


class AuditService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def record(
        self,
        action: str,
        *,
        entity_type: str,
        entity_id: str | int | None = None,
        actor: str = "system",
        actor_user_id: int | None = None,
        old_state: str | None = None,
        new_state: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> AuditLog:
        row = AuditLog(
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            actor=actor,
            actor_user_id=actor_user_id,
            old_state=old_state,
            new_state=new_state,
            request_id=request_id_var.get(),
            meta=meta or {},
            occurred_at=utcnow(),
        )
        self.session.add(row)
        self.session.flush()
        logger.info(
            "audit",
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            actor=actor,
            old_state=old_state,
            new_state=new_state,
        )
        return row

    def for_entity(self, entity_type: str, entity_id: str | int, *, limit: int = 100) -> list[AuditLog]:
        stmt = (
            select(AuditLog)
            .where(AuditLog.entity_type == entity_type, AuditLog.entity_id == str(entity_id))
            .order_by(AuditLog.occurred_at.desc())
            .limit(limit)
        )
        return list(self.session.execute(stmt).scalars())
