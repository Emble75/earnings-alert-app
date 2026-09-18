"""Manual research endpoints.

Lets the operator analyse real products they have looked up themselves, with
no marketplace API account required.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, File, UploadFile
from pydantic import Field

from app.api.deps import BusinessSettings, CurrentUser, Operator, Providers, TxSession
from app.core.errors import ValidationError
from app.models.enums import ProductCondition, StockStatus
from app.schemas.common import ApiModel
from app.schemas.opportunity import OpportunityOut
from app.services.research_service import (
    COLUMNS,
    CSV_TEMPLATE,
    ResearchInput,
    ResearchService,
)

router = APIRouter(prefix="/research", tags=["research"])

MAX_UPLOAD_BYTES = 1_000_000


class ResearchProductIn(ApiModel):
    """One product the operator has looked up by hand."""

    title: str = Field(min_length=3, max_length=300)
    source_price: Decimal = Field(gt=0)
    target_price: Decimal = Field(gt=0)
    ean: str | None = Field(default=None, max_length=32)
    brand: str | None = Field(default=None, max_length=160)
    model: str | None = Field(default=None, max_length=160)
    source_shipping: Decimal = Decimal("0")
    target_shipping: Decimal = Decimal("0")
    source_stock: StockStatus = StockStatus.UNKNOWN
    source_delivery_days: int | None = Field(default=None, ge=0, le=120)
    source_quantity_available: int | None = Field(default=None, ge=0, le=100000)
    competitor_count: int | None = Field(default=None, ge=0, le=10000)
    lowest_competitor_price: Decimal | None = None
    median_competitor_price: Decimal | None = None
    highest_competitor_price: Decimal | None = None
    condition: ProductCondition = ProductCondition.NEW
    category: str | None = Field(default=None, max_length=160)
    source_url: str | None = Field(default=None, max_length=1000)
    target_url: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=1000)

    def to_input(self) -> ResearchInput:
        return ResearchInput(**self.model_dump())


class ResearchRequest(ApiModel):
    products: list[ResearchProductIn] = Field(min_length=1, max_length=200)


class ResearchResponse(ApiModel):
    summary: dict
    opportunities: list[OpportunityOut]
    errors: list[str] = Field(default_factory=list)


@router.get("/template")
def csv_template(user: CurrentUser) -> dict:
    """The CSV format, with a worked example row."""
    return {
        "columns": COLUMNS,
        "template_csv": CSV_TEMPLATE,
        "notes": [
            "Only title, source_price and target_price are strictly required.",
            "In practice you also need ean, brand and model: without all three the "
            "system cannot confirm the Amazon item and the eBay listing are the same "
            "product, and it refuses the match rather than assuming it.",
            "target_price should be what you realistically expect to sell for, "
            "not the highest listing you can find.",
            "Prices are recorded as observations made now and age like any other.",
        ],
    }


@router.post("", response_model=ResearchResponse)
def analyse(
    payload: ResearchRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> ResearchResponse:
    """Run the full engine over manually entered products."""
    service = ResearchService(session, config, providers)
    outcome = service.analyse([product.to_input() for product in payload.products])
    return ResearchResponse(
        summary=outcome.summary(),
        opportunities=[OpportunityOut.model_validate(o) for o in outcome.created],
        errors=outcome.errors,
    )


@router.post("/csv", response_model=ResearchResponse)
async def analyse_csv(
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
    file: Annotated[UploadFile, File()],
) -> ResearchResponse:
    """Upload a CSV of products to analyse."""
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValidationError(
            f"file is too large ({len(raw)} bytes); the limit is {MAX_UPLOAD_BYTES}"
        )
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValidationError(
            "the file must be UTF-8 text. If you exported it from Excel, "
            "choose 'CSV UTF-8' when saving."
        ) from None

    outcome = ResearchService(session, config, providers).analyse_csv(content)
    return ResearchResponse(
        summary=outcome.summary(),
        opportunities=[OpportunityOut.model_validate(o) for o in outcome.created],
        errors=outcome.errors,
    )
