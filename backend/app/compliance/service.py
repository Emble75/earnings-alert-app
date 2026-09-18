"""Compliance service: runs the gates and records the verdict.

Every check is persisted.  If an action was allowed, there is a row saying
which rules passed; if it was blocked, there is a row saying which rule
stopped it.  That record is what makes "why did the system do that?"
answerable months later.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.compliance.rules import (
    RULESET_VERSION,
    ComplianceContext,
    ComplianceResult,
    check_fulfillment,
    check_listing,
    check_marketplace_policy,
    check_order,
    check_seller_requirements,
)
from app.core.clock import utcnow
from app.core.errors import ComplianceBlockedError
from app.models.enums import ComplianceCheckType
from app.models.ops import ComplianceCheck


class ComplianceService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def _record(
        self,
        check_type: ComplianceCheckType,
        entity_type: str,
        entity_id: str | int | None,
        result: ComplianceResult,
    ) -> ComplianceCheck:
        row = ComplianceCheck(
            check_type=check_type,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            outcome=result.outcome,
            results=result.to_dicts(),
            blocked_reason=result.blocked_reason(),
            ruleset_version=RULESET_VERSION,
            is_blocking=result.is_blocking,
            checked_at=utcnow(),
        )
        self.session.add(row)
        self.session.flush()
        return row

    def check(
        self,
        check_type: ComplianceCheckType,
        ctx: ComplianceContext,
        *,
        entity_type: str,
        entity_id: str | int | None = None,
    ) -> ComplianceResult:
        runner = {
            ComplianceCheckType.LISTING: check_listing,
            ComplianceCheckType.ORDER: check_order,
            ComplianceCheckType.FULFILLMENT: check_fulfillment,
            ComplianceCheckType.MARKETPLACE_POLICY: check_marketplace_policy,
            ComplianceCheckType.SELLER_REQUIREMENTS: check_seller_requirements,
        }[check_type]
        result = runner(ctx)
        self._record(check_type, entity_type, entity_id, result)
        return result

    def require(
        self,
        check_type: ComplianceCheckType,
        ctx: ComplianceContext,
        *,
        entity_type: str,
        entity_id: str | int | None = None,
    ) -> ComplianceResult:
        """Run a gate and raise if it blocks.

        Used at every point where the next statement would touch the outside
        world.
        """
        result = self.check(check_type, ctx, entity_type=entity_type, entity_id=entity_id)
        if result.is_blocking:
            raise ComplianceBlockedError(
                result.blocked_reason() or "blocked by compliance",
                context={
                    "check_type": check_type.value,
                    "entity_type": entity_type,
                    "entity_id": str(entity_id) if entity_id is not None else None,
                },
            )
        return result
