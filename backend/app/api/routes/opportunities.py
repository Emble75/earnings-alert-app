"""Opportunity endpoints."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import BusinessSettings, CurrentUser, DbSession, Operator, Providers, TxSession
from app.core.errors import NotFoundError
from app.models.enums import OpportunityState
from app.models.opportunity import Opportunity
from app.schemas.common import Page
from app.schemas.opportunity import (
    DiscoverRequest,
    EvaluationOut,
    OpportunityDetailOut,
    OpportunityOut,
)
from app.services.opportunity_service import OpportunityService

router = APIRouter(prefix="/opportunities", tags=["opportunities"])

#: Default view: what the operator can actually act on. Rejected and expired
#: rows stay queryable but do not clutter the list.
_DEFAULT_STATES = (
    OpportunityState.ACTIONABLE,
    OpportunityState.LISTING_CANDIDATE,
    OpportunityState.LISTED,
    OpportunityState.SALE_RECEIVED,
    OpportunityState.APPROVAL_REQUIRED,
)

_SORTABLE = {
    "expected_net_profit": Opportunity.expected_net_profit,
    "profit_margin": Opportunity.profit_margin,
    "roi": Opportunity.roi,
    "risk_score": Opportunity.risk_score,
    "match_confidence": Opportunity.match_confidence,
    "capital_required": Opportunity.capital_required,
    "created_at": Opportunity.created_at,
}


def _load(session, opportunity_id: int) -> Opportunity:
    opportunity = session.get(Opportunity, opportunity_id)
    if opportunity is None:
        raise NotFoundError(f"opportunity {opportunity_id} does not exist")
    return opportunity


@router.get("", response_model=Page[OpportunityOut])
def list_opportunities(
    session: DbSession,
    user: CurrentUser,
    config: BusinessSettings,
    state: Annotated[list[OpportunityState] | None, Query()] = None,
    min_profit: Annotated[Decimal | None, Query()] = None,
    min_margin: Annotated[Decimal | None, Query()] = None,
    max_risk: Annotated[int | None, Query()] = None,
    min_confidence: Annotated[Decimal | None, Query()] = None,
    sort: Annotated[str, Query()] = "expected_net_profit",
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    apply_defaults: Annotated[bool, Query()] = True,
) -> Page[OpportunityOut]:
    """List opportunities.

    With ``apply_defaults`` the configured thresholds are applied, which is
    what keeps micro-profit noise out of the operator's view by default.
    """
    conditions = []
    conditions.append(
        Opportunity.state.in_([s.value for s in (state or _DEFAULT_STATES)])
    )
    floor_profit = min_profit if min_profit is not None else (
        config.minimum_net_profit if apply_defaults else None
    )
    floor_margin = min_margin if min_margin is not None else (
        config.minimum_profit_margin if apply_defaults else None
    )
    risk_ceiling = max_risk if max_risk is not None else (
        config.maximum_risk_score if apply_defaults else None
    )
    confidence_floor = min_confidence if min_confidence is not None else (
        config.minimum_match_confidence if apply_defaults else None
    )
    if floor_profit is not None:
        conditions.append(Opportunity.expected_net_profit >= floor_profit)
    if floor_margin is not None:
        conditions.append(Opportunity.profit_margin >= floor_margin)
    if risk_ceiling is not None:
        conditions.append(Opportunity.risk_score <= risk_ceiling)
    if confidence_floor is not None:
        conditions.append(Opportunity.match_confidence >= confidence_floor)

    column = _SORTABLE.get(sort, Opportunity.expected_net_profit)
    ordering = column.desc() if order == "desc" else column.asc()
    total = int(
        session.execute(select(func.count(Opportunity.id)).where(*conditions)).scalar_one() or 0
    )
    rows = list(
        session.execute(
            select(Opportunity).where(*conditions).order_by(ordering).limit(limit).offset(offset)
        ).scalars()
    )
    return Page(
        items=[OpportunityOut.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{opportunity_id}", response_model=OpportunityDetailOut)
def get_opportunity(
    opportunity_id: int,
    session: DbSession,
    user: CurrentUser,
    config: BusinessSettings,
    providers: Providers,
) -> OpportunityDetailOut:
    opportunity = _load(session, opportunity_id)
    detail = OpportunityDetailOut.model_validate(opportunity)
    detail.staleness = OpportunityService(session, config, providers).staleness(opportunity)
    return detail


@router.post("/discover", response_model=list[EvaluationOut])
def discover(
    payload: DiscoverRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> list[EvaluationOut]:
    service = OpportunityService(session, config, providers)
    results: list[EvaluationOut] = []
    for opportunity in service.discover(payload.query, limit=payload.limit):
        if payload.evaluate:
            evaluation = service.evaluate(opportunity)
            results.append(
                EvaluationOut(
                    opportunity=OpportunityOut.model_validate(opportunity),
                    decision=evaluation.decision,
                    reasons=[str(r) for r in evaluation.reasons],
                )
            )
        else:
            results.append(
                EvaluationOut(
                    opportunity=OpportunityOut.model_validate(opportunity),
                    decision=opportunity.decision or "REVIEW",
                    reasons=[],
                )
            )
    return results


@router.post("/{opportunity_id}/evaluate", response_model=EvaluationOut)
def evaluate(
    opportunity_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> EvaluationOut:
    opportunity = _load(session, opportunity_id)
    evaluation = OpportunityService(session, config, providers).evaluate(opportunity)
    return EvaluationOut(
        opportunity=OpportunityOut.model_validate(opportunity),
        decision=evaluation.decision,
        reasons=[str(r) for r in evaluation.reasons],
    )


@router.post("/{opportunity_id}/revalidate", response_model=EvaluationOut)
def revalidate(
    opportunity_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> EvaluationOut:
    opportunity = _load(session, opportunity_id)
    evaluation = OpportunityService(session, config, providers).revalidate(opportunity)
    return EvaluationOut(
        opportunity=OpportunityOut.model_validate(opportunity),
        decision=evaluation.decision,
        reasons=[str(r) for r in evaluation.reasons],
    )


@router.post("/{opportunity_id}/reject", response_model=OpportunityOut)
def reject(
    opportunity_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
    reason: Annotated[str, Query(max_length=300)] = "rejected by operator",
) -> Opportunity:
    opportunity = _load(session, opportunity_id)
    service = OpportunityService(session, config, providers)
    opportunity.rejected_reason = reason
    service.transition(
        opportunity,
        OpportunityState.REJECTED,
        reason=reason,
        actor=f"user:{user.id}",
        actor_user_id=user.id,
    )
    return opportunity
