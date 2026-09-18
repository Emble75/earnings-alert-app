from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import Field

from app.models.enums import ListingState, ProductCondition
from app.schemas.common import ApiModel, DecimalStringMixin


class ListingOut(ApiModel, DecimalStringMixin):
    id: int
    provider: str
    external_id: str | None = None
    sku: str | None = None
    title: str
    state: ListingState
    condition: ProductCondition
    currency: str
    price: Decimal | None = None
    minimum_sale_price: Decimal | None = None
    recommended_sale_price: Decimal | None = None
    quantity: int
    is_own_listing: bool
    url: str | None = None
    published_at: datetime | None = None
    ended_at: datetime | None = None
    last_error: str | None = None
    created_at: datetime


class CreateListingRequest(ApiModel):
    opportunity_id: int


class ListingCandidateOut(ApiModel):
    listing: ListingOut
    minimum_sale_price: str
    recommended_sale_price: str
    expected_net_profit: str
    reasons: list[str] = Field(default_factory=list)


class UpdateListingRequest(ApiModel):
    price: Decimal | None = None
    quantity: int | None = Field(default=None, ge=0, le=1000)


class ProductOut(ApiModel):
    id: int
    title: str
    brand: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    category: str | None = None
    condition: ProductCondition
    primary_identifier_value: str | None = None
    attributes: dict = Field(default_factory=dict)
    created_at: datetime
