from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import Field

from app.models.enums import DecisionOutcome, OpportunityState, RiskLevel
from app.schemas.common import ApiModel, DecimalStringMixin


class OpportunityOut(ApiModel, DecimalStringMixin):
    id: int
    reference: str
    state: OpportunityState
    currency: str
    quantity: int

    product_id: int | None = None
    source_offer_id: int | None = None
    target_listing_id: int | None = None

    source_price: Decimal | None = None
    target_price: Decimal | None = None
    total_costs: Decimal | None = None
    expected_net_profit: Decimal | None = None
    worst_case_net_profit: Decimal | None = None
    best_case_net_profit: Decimal | None = None
    profit_margin: Decimal | None = None
    roi: Decimal | None = None
    capital_required: Decimal | None = None

    risk_score: int | None = None
    risk_level: RiskLevel | None = None
    match_confidence: Decimal | None = None
    decision: DecisionOutcome | None = None
    decision_reasons: list = Field(default_factory=list)
    blocked_reason: str | None = None
    rejected_reason: str | None = None

    source_price_timestamp: datetime | None = None
    target_price_timestamp: datetime | None = None
    inventory_timestamp: datetime | None = None
    delivery_timestamp: datetime | None = None
    last_revalidated_at: datetime | None = None
    expires_at: datetime | None = None
    created_at: datetime


class ProfitCalculationOut(ApiModel, DecimalStringMixin):
    scenario: str
    currency: str
    sale_revenue: Decimal
    buyer_shipping_paid: Decimal
    source_purchase_cost: Decimal
    source_shipping_cost: Decimal
    marketplace_fees: Decimal
    payment_fees: Decimal
    fulfillment_cost: Decimal
    outbound_shipping_cost: Decimal
    packaging_cost: Decimal
    expected_return_cost: Decimal
    risk_reserve: Decimal
    other_variable_costs: Decimal
    total_costs: Decimal
    net_profit: Decimal
    profit_margin: Decimal | None = None
    roi: Decimal | None = None
    capital_required: Decimal
    fee_breakdown: list = Field(default_factory=list)
    assumptions: list = Field(default_factory=list)
    profit_model_version: str
    calculated_at: datetime


class RiskAssessmentOut(ApiModel):
    score: int
    level: RiskLevel
    factors: list = Field(default_factory=list)
    blockers: list = Field(default_factory=list)
    reasons: list = Field(default_factory=list)
    is_blocking: bool
    risk_model_version: str
    assessed_at: datetime


class OpportunityDetailOut(OpportunityOut):
    profit_calculations: list[ProfitCalculationOut] = Field(default_factory=list)
    risk_assessments: list[RiskAssessmentOut] = Field(default_factory=list)
    staleness: list[str] = Field(default_factory=list)


class DiscoverRequest(ApiModel):
    query: str = Field(default="", max_length=200)
    limit: int = Field(default=20, ge=1, le=100)
    evaluate: bool = True


class EvaluationOut(ApiModel):
    opportunity: OpportunityOut
    decision: DecisionOutcome
    reasons: list[str] = Field(default_factory=list)
