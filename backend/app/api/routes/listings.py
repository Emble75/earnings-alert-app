"""Listing and product endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import BusinessSettings, CurrentUser, DbSession, Operator, Providers, TxSession
from app.core.errors import NotFoundError
from app.core.money import Money
from app.listing.engine import ListingEngine
from app.models.market import TargetListing
from app.models.opportunity import Opportunity
from app.models.product import Product
from app.schemas.common import Page
from app.schemas.listing import (
    CreateListingRequest,
    ListingCandidateOut,
    ListingOut,
    ProductOut,
    UpdateListingRequest,
)

router = APIRouter(tags=["listings"])


@router.get("/listings", response_model=Page[ListingOut])
def list_listings(
    session: DbSession,
    user: CurrentUser,
    own_only: Annotated[bool, Query()] = True,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[ListingOut]:
    conditions = [TargetListing.is_own_listing.is_(True)] if own_only else []
    total = int(
        session.execute(select(func.count(TargetListing.id)).where(*conditions)).scalar_one() or 0
    )
    rows = list(
        session.execute(
            select(TargetListing)
            .where(*conditions)
            .order_by(TargetListing.created_at.desc())
            .limit(limit)
            .offset(offset)
        ).scalars()
    )
    return Page(
        items=[ListingOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.post("/listings", response_model=ListingCandidateOut)
def create_listing_candidate(
    payload: CreateListingRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> ListingCandidateOut:
    opportunity = session.get(Opportunity, payload.opportunity_id)
    if opportunity is None:
        raise NotFoundError(f"opportunity {payload.opportunity_id} does not exist")
    candidate = ListingEngine(session, config, providers).create_listing_candidate(opportunity)
    return ListingCandidateOut(
        listing=ListingOut.model_validate(candidate.listing),
        minimum_sale_price=str(candidate.minimum_sale_price.amount),
        recommended_sale_price=str(candidate.recommended_sale_price.amount),
        expected_net_profit=str(candidate.expected_net_profit.amount),
        reasons=candidate.reasons,
    )


@router.post("/listings/{listing_id}/publish", response_model=ListingOut)
def publish(
    listing_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> TargetListing:
    listing = session.get(TargetListing, listing_id)
    if listing is None:
        raise NotFoundError(f"listing {listing_id} does not exist")
    opportunity = (
        session.get(Opportunity, listing.opportunity_id) if listing.opportunity_id else None
    )
    if opportunity is None:
        raise NotFoundError("listing is not linked to an opportunity")
    return ListingEngine(session, config, providers).publish_listing(opportunity, listing)


@router.put("/listings/{listing_id}", response_model=ListingOut)
def update(
    listing_id: int,
    payload: UpdateListingRequest,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
) -> TargetListing:
    listing = session.get(TargetListing, listing_id)
    if listing is None:
        raise NotFoundError(f"listing {listing_id} does not exist")
    price = Money(payload.price, listing.currency) if payload.price is not None else None
    return ListingEngine(session, config, providers).update_listing(
        listing, price=price, quantity=payload.quantity
    )


@router.delete("/listings/{listing_id}", response_model=ListingOut)
def end(
    listing_id: int,
    session: TxSession,
    user: Operator,
    config: BusinessSettings,
    providers: Providers,
    reason: Annotated[str, Query(max_length=300)] = "ended by operator",
) -> TargetListing:
    listing = session.get(TargetListing, listing_id)
    if listing is None:
        raise NotFoundError(f"listing {listing_id} does not exist")
    return ListingEngine(session, config, providers).end_listing(listing, reason=reason)


@router.get("/products", response_model=Page[ProductOut])
def list_products(
    session: DbSession,
    user: CurrentUser,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[ProductOut]:
    conditions = []
    if q:
        conditions.append(Product.title.ilike(f"%{q}%"))
    total = int(session.execute(select(func.count(Product.id)).where(*conditions)).scalar_one() or 0)
    rows = list(
        session.execute(
            select(Product).where(*conditions).order_by(Product.id.desc()).limit(limit).offset(offset)
        ).scalars()
    )
    return Page(
        items=[ProductOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.get("/products/{product_id}", response_model=ProductOut)
def get_product(product_id: int, session: DbSession, user: CurrentUser) -> Product:
    product = session.get(Product, product_id)
    if product is None:
        raise NotFoundError(f"product {product_id} does not exist")
    return product
