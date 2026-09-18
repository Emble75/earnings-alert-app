"""Backtesting over stored price history.

This engine only ever replays observations the system actually recorded.  It
does not synthesise history, and when there is not enough of it, it says so -
a backtest built on invented data is worse than no backtest, because it
produces confident numbers about a past that never happened.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.money import Money
from app.models.enums import ScenarioType, StockStatus
from app.models.market import InventorySnapshot, PriceHistory
from app.models.opportunity import Opportunity
from app.profit.engine import calculate_profit, inputs_from_config
from app.services.settings_service import BusinessConfig

MINIMUM_OBSERVATIONS = 10


@dataclass
class BacktestResult:
    available: bool
    reason: str = ""
    window_start: datetime | None = None
    window_end: datetime | None = None
    observations: int = 0
    products_covered: int = 0
    opportunities_evaluated: int = 0
    passed_filters: int = 0
    reached_profit_threshold: int = 0
    source_price_changes: int = 0
    stock_disappearances: int = 0
    total_expected_profit: Decimal = Decimal("0")
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "reason": self.reason,
            "window_start": self.window_start.isoformat() if self.window_start else None,
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "observations": self.observations,
            "products_covered": self.products_covered,
            "opportunities_evaluated": self.opportunities_evaluated,
            "passed_filters": self.passed_filters,
            "reached_profit_threshold": self.reached_profit_threshold,
            "source_price_changes": self.source_price_changes,
            "stock_disappearances": self.stock_disappearances,
            "total_expected_profit": str(self.total_expected_profit),
            "notes": self.notes,
        }


class BacktestEngine:
    def __init__(self, session: Session, config: BusinessConfig) -> None:
        self.session = session
        self.config = config
        self.currency = config.base_currency

    def run(self, *, days: int = 30) -> BacktestResult:
        window_end = utcnow()
        window_start = window_end - timedelta(days=days)

        observations = int(
            self.session.execute(
                select(func.count(PriceHistory.id)).where(PriceHistory.observed_at >= window_start)
            ).scalar_one()
            or 0
        )
        if observations < MINIMUM_OBSERVATIONS:
            return BacktestResult(
                available=False,
                reason=(
                    f"only {observations} price observations in the last {days} days; "
                    f"at least {MINIMUM_OBSERVATIONS} are needed. Backtesting is unavailable "
                    "until the monitors have collected real history - no data will be invented."
                ),
                window_start=window_start,
                window_end=window_end,
                observations=observations,
            )

        products = int(
            self.session.execute(
                select(func.count(func.distinct(PriceHistory.product_id))).where(
                    PriceHistory.observed_at >= window_start,
                    PriceHistory.product_id.is_not(None),
                )
            ).scalar_one()
            or 0
        )

        source_changes = self._count_price_changes(window_start, "source_offer")
        stock_losses = int(
            self.session.execute(
                select(func.count(InventorySnapshot.id)).where(
                    InventorySnapshot.observed_at >= window_start,
                    InventorySnapshot.stock_status == StockStatus.OUT_OF_STOCK.value,
                )
            ).scalar_one()
            or 0
        )

        evaluated = passed = reached = 0
        total_profit = Decimal("0")
        for opportunity in self.session.execute(
            select(Opportunity).where(Opportunity.created_at >= window_start)
        ).scalars():
            evaluated += 1
            replay = self._replay(opportunity)
            if replay is None:
                continue
            passed += 1
            if replay.net_profit.amount >= self.config.minimum_net_profit:
                reached += 1
                total_profit += replay.net_profit.amount

        return BacktestResult(
            available=True,
            window_start=window_start,
            window_end=window_end,
            observations=observations,
            products_covered=products,
            opportunities_evaluated=evaluated,
            passed_filters=passed,
            reached_profit_threshold=reached,
            source_price_changes=source_changes,
            stock_disappearances=stock_losses,
            total_expected_profit=total_profit,
            notes=[
                "Replayed against recorded price history only; no synthetic data.",
                f"Filters applied: minimum net profit {self.config.minimum_net_profit}, "
                f"minimum margin {self.config.minimum_profit_margin}.",
            ],
        )

    def _replay(self, opportunity: Opportunity):
        if opportunity.source_price is None or opportunity.target_price is None:
            return None
        inputs = inputs_from_config(
            self.config,
            sale_price=Money(opportunity.target_price, self.currency),
            source_unit_price=Money(opportunity.source_price, self.currency),
            quantity=opportunity.quantity,
            scenario=ScenarioType.BASE_CASE,
        )
        breakdown = calculate_profit(inputs)
        margin = breakdown.profit_margin
        if margin is None or margin < self.config.minimum_profit_margin:
            return None
        return breakdown

    def _count_price_changes(self, since: datetime, entity_type: str) -> int:
        rows = list(
            self.session.execute(
                select(PriceHistory.entity_id, PriceHistory.price, PriceHistory.observed_at)
                .where(
                    PriceHistory.observed_at >= since,
                    PriceHistory.entity_type == entity_type,
                    PriceHistory.price.is_not(None),
                )
                .order_by(PriceHistory.entity_id, PriceHistory.observed_at)
            )
        )
        changes = 0
        last: dict[int, Decimal] = {}
        for entity_id, price, _ in rows:
            value = Decimal(str(price))
            if entity_id in last and last[entity_id] != value:
                changes += 1
            last[entity_id] = value
        return changes
