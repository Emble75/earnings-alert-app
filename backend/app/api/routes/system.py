"""Analytics, risk, settings, logs and health."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.analytics.backtest import BacktestEngine
from app.analytics.service import AnalyticsService
from app.api.deps import Admin, BusinessSettings, CurrentUser, DbSession, Operator, Providers, TxSession
from app.compliance.rules import RULESET_VERSION
from app.core.config import get_settings
from app.matching.matcher import MATCHER_VERSION
from app.models.enums import RiskLevel
from app.models.opportunity import Opportunity, RiskAssessment
from app.models.ops import AuditLog, Notification
from app.profit.engine import PROFIT_MODEL_VERSION
from app.risk.engine import RISK_MODEL_VERSION
from app.schemas.settings import SettingsOut, SettingsUpdateRequest
from app.services.audit_service import AuditService
from app.services.notification_service import NotificationService
from app.services.settings_service import FIELD_GROUPS, BusinessConfig, SettingsService

router = APIRouter(tags=["system"])


@router.get("/health")
def health(providers: Providers) -> dict:
    settings = get_settings()
    return {
        "status": "ok",
        "environment": settings.environment,
        "demo_mode": settings.effective_demo_mode,
        "simulation_mode": settings.simulation_mode,
        "automation_level": settings.automation_level,
        "providers": providers.describe(),
        "model_versions": {
            "profit": PROFIT_MODEL_VERSION,
            "risk": RISK_MODEL_VERSION,
            "matcher": MATCHER_VERSION,
            "compliance_ruleset": RULESET_VERSION,
        },
    }


@router.get("/analytics")
def analytics(session: DbSession, user: CurrentUser, config: BusinessSettings) -> dict:
    service = AnalyticsService(session, currency=config.base_currency)
    return {
        "dashboard": service.dashboard(minimum_profit=config.minimum_net_profit).to_dict(),
        "expected_vs_realized": service.expected_vs_realized(limit=50),
        "rejection_breakdown": service.rejection_breakdown(),
    }


@router.get("/analytics/backtest")
def backtest(
    session: DbSession,
    user: CurrentUser,
    config: BusinessSettings,
    days: Annotated[int, Query(ge=1, le=365)] = 30,
) -> dict:
    return BacktestEngine(session, config).run(days=days).to_dict()


@router.get("/risk")
def risk_overview(
    session: DbSession,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    distribution = {level.value: 0 for level in RiskLevel}
    for level, count in session.execute(
        select(Opportunity.risk_level, func.count(Opportunity.id))
        .where(Opportunity.risk_level.is_not(None))
        .group_by(Opportunity.risk_level)
    ):
        key = level.value if hasattr(level, "value") else str(level)
        distribution[key] = int(count)

    recent = []
    for row in session.execute(
        select(RiskAssessment).order_by(RiskAssessment.assessed_at.desc()).limit(limit)
    ).scalars():
        recent.append(
            {
                "opportunity_id": row.opportunity_id,
                "order_id": row.order_id,
                "score": row.score,
                "level": row.level.value,
                "is_blocking": row.is_blocking,
                "blockers": row.blockers,
                "reasons": row.reasons,
                "factors": row.factors,
                "assessed_at": row.assessed_at.isoformat(),
            }
        )
    return {
        "distribution": distribution,
        "risk_model_version": RISK_MODEL_VERSION,
        "recent_assessments": recent,
    }


@router.get("/settings", response_model=SettingsOut)
def get_settings_endpoint(
    session: DbSession, user: CurrentUser, providers: Providers
) -> SettingsOut:
    config = SettingsService(session).load()
    groups: dict[str, list[str]] = {}
    for field, group in FIELD_GROUPS.items():
        groups.setdefault(group, []).append(field)
    env = get_settings()
    return SettingsOut(
        values=config.model_dump(mode="json"),
        groups=groups,
        runtime={
            "demo_mode": env.effective_demo_mode,
            "simulation_mode": env.simulation_mode,
            "automation_level": env.automation_level,
            "providers": providers.describe(),
            "model_versions": {
                "profit": PROFIT_MODEL_VERSION,
                "risk": RISK_MODEL_VERSION,
                "matcher": MATCHER_VERSION,
                "compliance_ruleset": RULESET_VERSION,
            },
        },
    )


@router.put("/settings", response_model=SettingsOut)
def update_settings(
    payload: SettingsUpdateRequest,
    session: TxSession,
    user: Admin,
    providers: Providers,
) -> SettingsOut:
    """Change business rules.

    Admin only, validated as a whole before anything is written, and every
    change is audited: these values decide when the system spends money.
    """
    service = SettingsService(session)
    before = service.load().model_dump(mode="json")
    config: BusinessConfig = service.update(payload.updates)
    after = config.model_dump(mode="json")
    AuditService(session).record(
        "settings.updated",
        entity_type="settings",
        actor=f"user:{user.id}",
        actor_user_id=user.id,
        meta={
            "changed": {
                key: {"from": before.get(key), "to": after.get(key)} for key in payload.updates
            }
        },
    )
    groups: dict[str, list[str]] = {}
    for field, group in FIELD_GROUPS.items():
        groups.setdefault(group, []).append(field)
    env = get_settings()
    return SettingsOut(
        values=after,
        groups=groups,
        runtime={
            "demo_mode": env.effective_demo_mode,
            "simulation_mode": env.simulation_mode,
            "automation_level": env.automation_level,
            "providers": providers.describe(),
        },
    )


@router.get("/logs")
def logs(
    session: DbSession,
    user: CurrentUser,
    entity_type: Annotated[str | None, Query(max_length=60)] = None,
    entity_id: Annotated[str | None, Query(max_length=60)] = None,
    action: Annotated[str | None, Query(max_length=80)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict:
    conditions = []
    if entity_type:
        conditions.append(AuditLog.entity_type == entity_type)
    if entity_id:
        conditions.append(AuditLog.entity_id == entity_id)
    if action:
        conditions.append(AuditLog.action == action)
    rows = list(
        session.execute(
            select(AuditLog).where(*conditions).order_by(AuditLog.occurred_at.desc()).limit(limit)
        ).scalars()
    )
    return {
        "items": [
            {
                "action": row.action,
                "entity_type": row.entity_type,
                "entity_id": row.entity_id,
                "actor": row.actor,
                "old_state": row.old_state,
                "new_state": row.new_state,
                "request_id": row.request_id,
                "meta": row.meta,
                "occurred_at": row.occurred_at.isoformat(),
            }
            for row in rows
        ],
        "total": len(rows),
    }


@router.get("/notifications")
def notifications(
    session: DbSession,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    rows = list(
        session.execute(
            select(Notification).order_by(Notification.created_at.desc()).limit(limit)
        ).scalars()
    )
    return {
        "items": [
            {
                "id": row.id,
                "event": row.event.value,
                "channel": row.channel.value,
                "status": row.status.value,
                "subject": row.subject,
                "body": row.body,
                "entity_type": row.entity_type,
                "entity_id": row.entity_id,
                "read_at": row.read_at.isoformat() if row.read_at else None,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
    }


@router.post("/notifications/{notification_id}/read")
def mark_read(notification_id: int, session: TxSession, user: Operator) -> dict:
    notification = NotificationService(session).mark_read(notification_id)
    return {"ok": notification is not None}
