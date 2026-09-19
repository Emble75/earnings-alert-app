"""Manual research endpoints.

Lets the operator analyse real products they have looked up themselves, with
no marketplace API account required.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, File, Query, UploadFile
from pydantic import Field

from app.api.deps import BusinessSettings, CurrentUser, Operator, Providers, TxSession
from app.core.errors import AppError, ValidationError
from app.core.logging import get_logger
from app.models.enums import ProductCondition, StockStatus
from app.schemas.common import ApiModel
from app.schemas.opportunity import MarketplaceLinks, OpportunityOut
from app.services.opportunity_service import build_links
from app.services.research_service import (
    COLUMNS,
    CSV_TEMPLATE,
    ResearchInput,
    ResearchService,
)


def _out(session, opportunity) -> OpportunityOut:
    out = OpportunityOut.model_validate(opportunity)
    out.links = MarketplaceLinks(**build_links(opportunity, session))
    return out

router = APIRouter(prefix="/research", tags=["research"])
logger = get_logger(__name__)

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
        opportunities=[_out(session, o) for o in outcome.created],
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
        opportunities=[_out(session, o) for o in outcome.created],
        errors=outcome.errors,
    )


class EbayListingOut(ApiModel):
    """One real eBay listing, addressable by its item number."""

    item_id: str
    title: str
    price: str | None = None
    shipping: str | None = None
    total: str | None = None
    currency: str
    condition: str
    url: str | None = None
    seller: str | None = None
    seller_feedback: str | None = None
    identifiers: dict = Field(default_factory=dict)
    #: True when eBay's own catalogue gives this listing a product code. That
    #: is the difference between a guess and evidence the matcher can use.
    has_identifier: bool = False


class EbaySearchOut(ApiModel):
    """Live eBay results, or a plain reason why there are none."""

    available: bool
    reason: str | None = None
    query: str = ""
    listings: list[EbayListingOut] = Field(default_factory=list)


@router.get("/ebay", response_model=EbaySearchOut)
def search_ebay(
    user: CurrentUser,
    providers: Providers,
    q: str = Query(default="", max_length=200),
    ean: str = Query(default="", max_length=32),
    limit: int = Query(default=20, ge=1, le=50),
) -> EbaySearchOut:
    """Find real eBay listings to price against.

    Searching by EAN works here and does not work on the eBay website: the API
    indexes the structured product code, the site searches titles. That is why
    an EAN that returns nothing in a browser can still return the right
    listings through this endpoint.

    A missing integration is reported as ``available: false`` with a reason
    rather than as an error, because "no eBay account configured" is a state
    the operator can act on, not a failure.
    """
    # The provider is used through its research-mode wrapper, so this path
    # keeps the read-only guarantee. The wrapper is only asked whether what it
    # returns is the real marketplace - not whether it may act on it.
    target = providers.target
    live = getattr(target, "reads_live_data", getattr(target, "is_live", False))
    if not live:
        return EbaySearchOut(
            available=False,
            reason=(
                "No eBay application keys are configured, so there are no live "
                "listings to show. Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET from "
                "your eBay developer account, or paste an eBay listing address by hand."
            ),
        )

    query = (q or "").strip()
    identifier = (ean or "").strip()
    if not query and not identifier:
        return EbaySearchOut(available=True, reason="Enter a product name or an EAN.")

    try:
        if identifier:
            listings = target.find_by_identifier("EAN", identifier)[:limit]
        else:
            listings = target.search_listings(query, limit=limit)
    except AppError as exc:
        logger.warning("ebay_search_failed", error=str(exc))
        return EbaySearchOut(available=False, reason=str(exc), query=query or identifier)

    out = []
    for listing in listings:
        price = listing.price
        shipping = listing.shipping_price
        total = None
        if price is not None and shipping is not None:
            total = str((price + shipping).amount)
        feedback = listing.attributes.get("seller_feedback_percentage")
        score = listing.attributes.get("seller_feedback_score")
        out.append(
            EbayListingOut(
                item_id=listing.external_id,
                title=listing.title,
                price=str(price.amount) if price is not None else None,
                shipping=str(shipping.amount) if shipping is not None else None,
                total=total,
                currency=(price.currency if price is not None else ""),
                condition=listing.condition.value,
                url=listing.url,
                seller=listing.seller_id,
                seller_feedback=(
                    f"{feedback}% of {score}" if feedback and score else None
                ),
                identifiers=listing.identifiers,
                has_identifier=bool(listing.identifiers),
            )
        )
    return EbaySearchOut(available=True, query=query or identifier, listings=out)
