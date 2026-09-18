"""Analytics: what the system expected, what it actually got, and the gap."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.models.enums import (
    CapitalReservationState,
    OpportunityState,
    OrderState,
    ReturnState,
    RiskLevel,
)
from app.models.fulfillment import Return
from app.models.opportunity import Opportunity
from app.models.order import CapitalReservation, Order


def _decimal(value) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        # SUM over a MoneyCents column can come back as raw cents.
        return Decimal(value) / Decimal(100)
    return Decimal(str(value))


@dataclass
class DashboardSummary:
    opportunities_today: int
    opportunities_above_threshold: int
    average_expected_profit: Decimal
    total_expected_profit: Decimal
    actionable_count: int
    listed_count: int
    orders_open: int
    pending_approvals: int
    capital_exposed: Decimal
    realized_profit_total: Decimal
    profit_variance_total: Decimal
    risk_distribution: dict[str, int]
    failed_opportunities: int
    blocked_opportunities: int
    returns_open: int
    currency: str

    def to_dict(self) -> dict:
        return {
            "opportunities_today": self.opportunities_today,
            "opportunities_above_threshold": self.opportunities_above_threshold,
            "average_expected_profit": str(self.average_expected_profit),
            "total_expected_profit": str(self.total_expected_profit),
            "actionable_count": self.actionable_count,
            "listed_count": self.listed_count,
            "orders_open": self.orders_open,
            "pending_approvals": self.pending_approvals,
            "capital_exposed": str(self.capital_exposed),
            "realized_profit_total": str(self.realized_profit_total),
            "profit_variance_total": str(self.profit_variance_total),
            "risk_distribution": self.risk_distribution,
            "failed_opportunities": self.failed_opportunities,
            "blocked_opportunities": self.blocked_opportunities,
            "returns_open": self.returns_open,
            "currency": self.currency,
        }


class AnalyticsService:
    def __init__(self, session: Session, *, currency: str = "EUR") -> None:
        self.session = session
        self.currency = currency

    def _count(self, stmt) -> int:
        return int(self.session.execute(stmt).scalar_one() or 0)

    def dashboard(self, *, minimum_profit: Decimal = Decimal("20")) -> DashboardSummary:
        since = utcnow() - timedelta(days=1)
        actionable_states = (
            OpportunityState.ACTIONABLE.value,
            OpportunityState.LISTING_CANDIDATE.value,
            OpportunityState.LISTED.value,
        )

        today = self._count(
            select(func.count(Opportunity.id)).where(Opportunity.created_at >= since)
        )
        profits = [
            _decimal(row[0])
            for row in self.session.execute(
                select(Opportunity.expected_net_profit).where(
                    Opportunity.state.in_(actionable_states),
                    Opportunity.expected_net_profit.is_not(None),
                )
            )
        ]
        qualifying = [p for p in profits if p >= minimum_profit]
        total_expected = sum(qualifying, Decimal("0"))
        average = (total_expected / Decimal(len(qualifying))) if qualifying else Decimal("0")

        risk_distribution = {level.value: 0 for level in RiskLevel}
        for row in self.session.execute(
            select(Opportunity.risk_level, func.count(Opportunity.id))
            .where(Opportunity.risk_level.is_not(None))
            .group_by(Opportunity.risk_level)
        ):
            level, count = row
            key = level.value if hasattr(level, "value") else str(level)
            risk_distribution[key] = int(count)

        open_order_states = [
            s.value
            for s in OrderState
            if s not in (OrderState.COMPLETED, OrderState.FAILED, OrderState.CANCELLED)
        ]
        exposure = _decimal(
            self.session.execute(
                select(func.coalesce(func.sum(CapitalReservation.amount), 0)).where(
                    CapitalReservation.state.in_(
                        [CapitalReservationState.RESERVED.value, CapitalReservationState.COMMITTED.value]
                    )
                )
            ).scalar_one()
        )
        realized = _decimal(
            self.session.execute(
                select(func.coalesce(func.sum(Order.realized_net_profit), 0))
            ).scalar_one()
        )
        variance = _decimal(
            self.session.execute(select(func.coalesce(func.sum(Order.profit_variance), 0))).scalar_one()
        )

        return DashboardSummary(
            opportunities_today=today,
            opportunities_above_threshold=len(qualifying),
            average_expected_profit=average.quantize(Decimal("0.01")),
            total_expected_profit=total_expected.quantize(Decimal("0.01")),
            actionable_count=self._count(
                select(func.count(Opportunity.id)).where(
                    Opportunity.state == OpportunityState.ACTIONABLE.value
                )
            ),
            listed_count=self._count(
                select(func.count(Opportunity.id)).where(
                    Opportunity.state == OpportunityState.LISTED.value
                )
            ),
            orders_open=self._count(
                select(func.count(Order.id)).where(Order.state.in_(open_order_states))
            ),
            pending_approvals=self._count(
                select(func.count(Order.id)).where(
                    Order.state == OrderState.APPROVAL_REQUIRED.value
                )
            ),
            capital_exposed=exposure,
            realized_profit_total=realized,
            profit_variance_total=variance,
            risk_distribution=risk_distribution,
            failed_opportunities=self._count(
                select(func.count(Opportunity.id)).where(
                    Opportunity.state == OpportunityState.FAILED.value
                )
            ),
            blocked_opportunities=self._count(
                select(func.count(Opportunity.id)).where(
                    Opportunity.state == OpportunityState.BLOCKED.value
                )
            ),
            returns_open=self._count(
                select(func.count(Return.id)).where(Return.state != ReturnState.CLOSED.value)
            ),
            currency=self.currency,
        )

    def expected_vs_realized(self, *, limit: int = 100) -> list[dict]:
        stmt = (
            select(Order)
            .where(Order.realized_net_profit.is_not(None))
            .order_by(Order.completed_at.desc())
            .limit(limit)
        )
        rows = []
        for order in self.session.execute(stmt).scalars():
            rows.append(
                {
                    "order_reference": order.reference,
                    "completed_at": order.completed_at.isoformat() if order.completed_at else None,
                    "expected_net_profit": str(order.expected_net_profit or Decimal("0")),
                    "realized_net_profit": str(order.realized_net_profit or Decimal("0")),
                    "variance": str(order.profit_variance or Decimal("0")),
                    "sale_price": str(order.sale_price),
                    "state": order.state.value,
                }
            )
        return rows

    def rejection_breakdown(self, *, limit: int = 500) -> dict[str, int]:
        """Why opportunities did not make it - the false-positive report."""
        stmt = (
            select(Opportunity.state, Opportunity.rejected_reason, Opportunity.blocked_reason)
            .where(
                Opportunity.state.in_(
                    [OpportunityState.REJECTED.value, OpportunityState.BLOCKED.value]
                )
            )
            .limit(limit)
        )
        counts: dict[str, int] = {}
        for state, rejected, blocked in self.session.execute(stmt):
            reason = (rejected or blocked or "unspecified").split(";")[0].strip()
            # Normalise the numeric part away so reasons group sensibly.
            key = reason.split(" is ")[0].split(" exceeds ")[0][:80]
            state_label = state.value if hasattr(state, "value") else str(state)
            counts[f"{state_label}: {key}"] = counts.get(f"{state_label}: {key}", 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: -kv[1]))
