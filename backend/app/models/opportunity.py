"""Opportunities and the calculations that justify them.

An opportunity row is a *decision record*: it stores the inputs, the engine
versions and the outputs, so that any past decision can be reproduced exactly
from stored data without re-querying a provider.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, IdMixin, TimestampMixin
from app.db.types import JSONDict, MoneyCents, Ratio, StringEnum
from app.models.enums import (
    DecisionOutcome,
    ExecutionMode,
    OpportunityState,
    RiskLevel,
    ScenarioType,
)


class Opportunity(Base, IdMixin, TimestampMixin):
    __tablename__ = "opportunities"
    __table_args__ = (
        Index("ix_opportunities_state_profit", "state", "expected_net_profit"),
        Index("ix_opportunities_actionable", "state", "risk_score", "match_confidence"),
        Index("ix_opportunities_expires", "expires_at"),
    )

    reference: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), index=True)
    source_offer_id: Mapped[int | None] = mapped_column(
        ForeignKey("source_offers.id", ondelete="SET NULL"), index=True
    )
    target_listing_id: Mapped[int | None] = mapped_column(
        ForeignKey("target_listings.id", ondelete="SET NULL"), index=True
    )
    product_match_id: Mapped[int | None] = mapped_column(
        ForeignKey("product_matches.id", ondelete="SET NULL")
    )

    state: Mapped[OpportunityState] = mapped_column(
        StringEnum(OpportunityState), nullable=False, default=OpportunityState.DISCOVERED, index=True
    )
    execution_mode: Mapped[ExecutionMode] = mapped_column(
        StringEnum(ExecutionMode), nullable=False, default=ExecutionMode.DEMO
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # -- headline figures (denormalised from the latest calculation) ---------
    source_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    target_price: Mapped[Decimal | None] = mapped_column(MoneyCents)
    total_costs: Mapped[Decimal | None] = mapped_column(MoneyCents)
    expected_net_profit: Mapped[Decimal | None] = mapped_column(MoneyCents, index=True)
    worst_case_net_profit: Mapped[Decimal | None] = mapped_column(MoneyCents)
    best_case_net_profit: Mapped[Decimal | None] = mapped_column(MoneyCents)
    profit_margin: Mapped[Decimal | None] = mapped_column(Ratio)
    roi: Mapped[Decimal | None] = mapped_column(Ratio)
    capital_required: Mapped[Decimal | None] = mapped_column(MoneyCents)

    risk_score: Mapped[int | None] = mapped_column(Integer, index=True)
    risk_level: Mapped[RiskLevel | None] = mapped_column(StringEnum(RiskLevel))
    match_confidence: Mapped[Decimal | None] = mapped_column(Ratio)

    # -- freshness -----------------------------------------------------------
    source_price_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    target_price_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    inventory_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivery_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    match_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    risk_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    profit_calculation_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_revalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # -- decision ------------------------------------------------------------
    decision: Mapped[DecisionOutcome | None] = mapped_column(StringEnum(DecisionOutcome))
    decision_reasons: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    rejected_reason: Mapped[str | None] = mapped_column(Text)
    discovery_source: Mapped[str | None] = mapped_column(String(60))
    notes: Mapped[str | None] = mapped_column(Text)

    profit_calculations: Mapped[list[ProfitCalculation]] = relationship(
        back_populates="opportunity", cascade="all, delete-orphan", lazy="selectin"
    )
    risk_assessments: Mapped[list[RiskAssessment]] = relationship(
        back_populates="opportunity", cascade="all, delete-orphan", lazy="selectin"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Opportunity {self.reference} {self.state} profit={self.expected_net_profit}>"


class ProfitCalculation(Base, IdMixin, TimestampMixin):
    """One fully itemised profit calculation.

    Every cost line is stored separately.  There is deliberately no labour,
    handling or opportunity-cost column: manual fulfilment consumes operator
    time, not cash, and the cash model must not pretend otherwise.
    """

    __tablename__ = "profit_calculations"
    __table_args__ = (
        Index("ix_profit_calculations_opp_scenario", "opportunity_id", "scenario", "calculated_at"),
    )

    opportunity_id: Mapped[int | None] = mapped_column(
        ForeignKey("opportunities.id", ondelete="CASCADE"), index=True
    )
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    scenario: Mapped[ScenarioType] = mapped_column(
        StringEnum(ScenarioType), nullable=False, default=ScenarioType.BASE_CASE
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="EUR")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # -- revenue -------------------------------------------------------------
    sale_revenue: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False)
    buyer_shipping_paid: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))

    # -- costs (all positive amounts; they are subtracted) -------------------
    source_purchase_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    source_shipping_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    marketplace_fees: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    payment_fees: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    fulfillment_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    outbound_shipping_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    packaging_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    expected_return_cost: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    risk_reserve: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    other_variable_costs: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))

    total_costs: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    net_profit: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))
    profit_margin: Mapped[Decimal | None] = mapped_column(Ratio)
    roi: Mapped[Decimal | None] = mapped_column(Ratio)
    capital_required: Mapped[Decimal] = mapped_column(MoneyCents, nullable=False, default=Decimal("0"))

    #: Full inputs + intermediate fee breakdown, enough to recompute the row.
    inputs: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    fee_breakdown: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    assumptions: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    profit_model_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    fee_model_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    calculated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    opportunity: Mapped[Opportunity | None] = relationship(back_populates="profit_calculations")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ProfitCalculation {self.scenario} net={self.net_profit}>"


class RiskAssessment(Base, IdMixin, TimestampMixin):
    """A deterministic, explainable risk score."""

    __tablename__ = "risk_assessments"
    __table_args__ = (Index("ix_risk_assessments_opp_ts", "opportunity_id", "assessed_at"),)

    opportunity_id: Mapped[int | None] = mapped_column(
        ForeignKey("opportunities.id", ondelete="CASCADE"), index=True
    )
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)

    score: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[RiskLevel] = mapped_column(StringEnum(RiskLevel), nullable=False)
    #: ``[{"factor": "inventory_risk", "score": 40, "weight": "0.15",
    #:    "reason": "stock status UNKNOWN"}, ...]``
    factors: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    #: Hard blockers found; a non-empty list forces a BLOCK decision.
    blockers: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    reasons: Mapped[list] = mapped_column(JSONDict, nullable=False, default=list)
    inputs: Mapped[dict] = mapped_column(JSONDict, nullable=False, default=dict)
    risk_reserve_amount: Mapped[Decimal | None] = mapped_column(MoneyCents)
    risk_model_version: Mapped[str] = mapped_column(String(20), nullable=False, default="1.0.0")
    is_blocking: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    assessed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    opportunity: Mapped[Opportunity | None] = relationship(back_populates="risk_assessments")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<RiskAssessment {self.score} {self.level}>"
