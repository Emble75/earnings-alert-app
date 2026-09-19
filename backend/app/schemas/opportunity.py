from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import Field

from app.models.enums import (
    DecisionOutcome,
    DeliverySpeed,
    OpportunityState,
    ProductCondition,
    RiskLevel,
    StockStatus,
)
from app.schemas.common import ApiModel, DecimalStringMixin


class MarketplaceLinks(ApiModel):
    """Where to go and check this yourself."""

    #: The exact Amazon offer, when we know its ASIN.
    source_product: str | None = None
    #: The exact eBay listing, when we know its item number.
    target_product: str | None = None
    source_search: str | None = None
    target_search: str | None = None
    #: Completed eBay sales - what buyers actually paid, not what sellers ask.
    target_sold: str | None = None


class ProductSummary(ApiModel):
    """Which product this opportunity is actually about."""

    id: int
    title: str
    brand: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    category: str | None = None
    condition: ProductCondition
    primary_identifier_value: str | None = None
    image_urls: list = Field(default_factory=list)


class SourceOfferSummary(ApiModel, DecimalStringMixin):
    """What we would buy, and on what terms."""

    id: int
    provider: str
    title: str
    brand: str | None = None
    model: str | None = None
    price: Decimal | None = None
    shipping_cost: Decimal | None = None
    currency: str
    stock_status: StockStatus
    available_quantity: int | None = None
    delivery_min_days: int | None = None
    delivery_max_days: int | None = None
    delivery_speed: DeliverySpeed
    seller_name: str | None = None
    sold_by_marketplace: bool = False
    url: str | None = None


class TargetListingSummary(ApiModel, DecimalStringMixin):
    """What we would sell it as."""

    id: int
    provider: str
    title: str
    price: Decimal | None = None
    shipping_price: Decimal | None = None
    minimum_sale_price: Decimal | None = None
    currency: str
    url: str | None = None


class OpportunityOut(ApiModel, DecimalStringMixin):
    id: int
    reference: str
    state: OpportunityState
    currency: str
    quantity: int

    product_id: int | None = None
    source_offer_id: int | None = None
    target_listing_id: int | None = None
    product: ProductSummary | None = None
    links: MarketplaceLinks | None = None

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
    net_vat: Decimal
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
    source_offer: SourceOfferSummary | None = None
    target_listing: TargetListingSummary | None = None
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
