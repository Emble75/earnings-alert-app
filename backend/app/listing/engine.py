"""The sell-first listing engine.

Listing is the first irreversible step: once it is live, a buyer can commit us
to supplying the item.  So a listing is only created from an ACTIONABLE
opportunity, only after a fresh revalidation, only above a dynamically
computed minimum sale price, and only once compliance has passed.

The minimum sale price is the floor below which the order stops being worth
doing:

    MINIMUM_SALE_PRICE = SOURCE_COST + SOURCE_SHIPPING + MARKETPLACE_FEES
                       + PAYMENT_FEES + FULFILLMENT_COST + OUTBOUND_SHIPPING
                       + PACKAGING + RISK_RESERVE + MINIMUM_REQUIRED_PROFIT

Fees depend on the price, and the price depends on the fees, so the floor is
solved iteratively against the configured fee model rather than assumed from a
single percentage.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal

from sqlalchemy.orm import Session

from app.compliance.rules import ComplianceContext
from app.compliance.service import ComplianceService
from app.core.clock import utcnow
from app.core.errors import ConflictError, StaleDataError, ValidationError
from app.core.ids import deterministic_key
from app.core.money import Money
from app.models.enums import (
    ComplianceCheckType,
    ListingState,
    OpportunityState,
    ProductCondition,
)
from app.models.market import SourceOffer, TargetListing
from app.models.opportunity import Opportunity
from app.models.product import Product
from app.profit.engine import ProfitInputs, calculate_profit, inputs_from_config
from app.providers.base import PublishRequest
from app.providers.registry import ProviderBundle
from app.services.audit_service import AuditService
from app.services.settings_service import BusinessConfig
from app.state_machines.opportunity import OPPORTUNITY_MACHINE

#: Iteration bound for the minimum-price solver. Convergence is typically
#: reached in two or three passes; the bound just guarantees termination.
_MAX_SOLVER_ITERATIONS = 24
_SOLVER_TOLERANCE = Decimal("0.01")


@dataclass
class ListingCandidate:
    opportunity: Opportunity
    listing: TargetListing
    minimum_sale_price: Money
    recommended_sale_price: Money
    expected_net_profit: Money
    reasons: list[str]


class ListingEngine:
    def __init__(
        self, session: Session, config: BusinessConfig, providers: ProviderBundle
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency
        self.audit = AuditService(session)
        self.compliance = ComplianceService(session)

    # -- pricing ------------------------------------------------------------
    def calculate_minimum_sale_price(self, base_inputs: ProfitInputs) -> Money:
        """Solve for the lowest sale price that still clears the profit floor.

        Fees are a function of the price, so this is a fixed-point iteration:
        guess a price, compute the profit at that price, move the price by the
        shortfall, repeat until it stops moving.
        """
        required = Money(self.config.minimum_net_profit, self.currency)
        price = base_inputs.sale_price
        if price.amount <= 0:
            price = Money(required.amount * 2, self.currency)

        for _ in range(_MAX_SOLVER_ITERATIONS):
            breakdown = calculate_profit(replace(base_inputs, sale_price=price))
            shortfall = required - breakdown.net_profit
            if abs(shortfall.amount) <= _SOLVER_TOLERANCE:
                break
            price = price + shortfall
            if price.amount <= 0:  # pragma: no cover - degenerate cost model
                raise ValidationError(
                    "no sale price can satisfy the configured minimum profit for these costs",
                    context={"minimum_net_profit": str(required.amount)},
                )

        # Also honour the margin floor: a price that clears the cash floor but
        # not the margin floor is not acceptable either.
        margin_floor = self.config.minimum_profit_margin
        if margin_floor > 0:
            for _ in range(_MAX_SOLVER_ITERATIONS):
                breakdown = calculate_profit(replace(base_inputs, sale_price=price))
                margin = breakdown.profit_margin
                if margin is not None and margin >= margin_floor:
                    break
                price = Money(price.amount * Decimal("1.02") + Decimal("0.01"), self.currency)

        # Round up to the cent so rounding can never land us below the floor.
        return Money(price.amount, self.currency)

    def calculate_recommended_sale_price(
        self, *, minimum: Money, market_price: Money | None
    ) -> Money:
        """Recommend a price that is both achievable and above the floor.

        The market price wins when it clears the floor; otherwise the floor
        wins and the listing will be rejected as unviable rather than listed
        at a loss.
        """
        markup = self.config.listing_price_markup_percent
        floor = Money(minimum.amount * (Decimal(100) + markup) / Decimal(100), self.currency)
        if market_price is None:
            return floor
        return market_price if market_price > floor else floor

    # -- candidate ----------------------------------------------------------
    def create_listing_candidate(self, opportunity: Opportunity) -> ListingCandidate:
        if opportunity.state is not OpportunityState.ACTIONABLE:
            raise ConflictError(
                f"only an ACTIONABLE opportunity can become a listing candidate "
                f"(this one is {opportunity.state.value})",
                context={"opportunity": opportunity.reference},
            )
        offer = self.session.get(SourceOffer, opportunity.source_offer_id)
        listing = self.session.get(TargetListing, opportunity.target_listing_id)
        product = self.session.get(Product, opportunity.product_id)
        if offer is None or offer.price is None:
            raise ValidationError("the source offer no longer has a usable price")

        base_inputs = inputs_from_config(
            self.config,
            sale_price=Money(opportunity.target_price or Decimal("0"), self.currency),
            source_unit_price=Money(offer.price, self.currency),
            quantity=opportunity.quantity,
            source_shipping_cost=Money(offer.shipping_cost or Decimal("0"), self.currency),
        )
        minimum = self.calculate_minimum_sale_price(base_inputs)
        market_price = Money(opportunity.target_price, self.currency) if opportunity.target_price else None
        recommended = self.calculate_recommended_sale_price(minimum=minimum, market_price=market_price)
        final = calculate_profit(replace(base_inputs, sale_price=recommended))

        own = self._own_listing_for(opportunity, listing, product)
        own.price = recommended.amount
        own.minimum_sale_price = minimum.amount
        own.recommended_sale_price = recommended.amount
        own.price_timestamp = utcnow()
        own.state = ListingState.CANDIDATE
        own.quantity = opportunity.quantity
        own.handling_time_days = self.config.target_handling_time_days
        own.delivery_expectation_days = self.config.target_delivery_expectation_days
        self.session.flush()

        opportunity.target_listing_id = opportunity.target_listing_id or own.id
        OPPORTUNITY_MACHINE.validate(opportunity.state, OpportunityState.LISTING_CANDIDATE)
        previous = opportunity.state
        opportunity.state = OpportunityState.LISTING_CANDIDATE
        self.session.flush()
        self.audit.record(
            "listing.candidate_created",
            entity_type="opportunity",
            entity_id=opportunity.id,
            old_state=previous.value,
            new_state=opportunity.state.value,
            meta={
                "listing_id": own.id,
                "minimum_sale_price": str(minimum.amount),
                "recommended_sale_price": str(recommended.amount),
            },
        )
        return ListingCandidate(
            opportunity=opportunity,
            listing=own,
            minimum_sale_price=minimum,
            recommended_sale_price=recommended,
            expected_net_profit=final.net_profit,
            reasons=[
                f"minimum viable sale price {minimum}",
                f"recommended sale price {recommended}",
                f"expected net profit at the recommended price {final.net_profit}",
            ],
        )

    def _own_listing_for(
        self, opportunity: Opportunity, market_listing: TargetListing | None, product: Product | None
    ) -> TargetListing:
        if market_listing is not None and market_listing.is_own_listing:
            return market_listing
        sku = f"SKU-{opportunity.reference}"
        existing = (
            self.session.query(TargetListing)
            .filter(TargetListing.sku == sku, TargetListing.is_own_listing.is_(True))
            .first()
        )
        if existing is not None:
            return existing
        listing = TargetListing(
            product_id=opportunity.product_id,
            opportunity_id=opportunity.id,
            provider=self.providers.target.name,
            sku=sku,
            title=(market_listing.title if market_listing else (product.title if product else sku)),
            condition=(product.condition if product else ProductCondition.NEW),
            currency=self.currency,
            is_own_listing=True,
            state=ListingState.DRAFT,
            category_id=market_listing.category_id if market_listing else None,
            brand=product.brand if product else None,
            model=product.model if product else None,
            attributes=dict(product.attributes) if product else {},
        )
        self.session.add(listing)
        self.session.flush()
        return listing

    # -- validation ---------------------------------------------------------
    def validate_listing(self, opportunity: Opportunity, listing: TargetListing) -> list[str]:
        """Every reason this listing must not go live. Empty means go."""
        problems: list[str] = []
        offer = self.session.get(SourceOffer, opportunity.source_offer_id)
        product = self.session.get(Product, opportunity.product_id)

        if listing.price is None or listing.price <= 0:
            problems.append("listing has no price")
        elif listing.minimum_sale_price is not None and listing.price < listing.minimum_sale_price:
            problems.append(
                f"price {listing.price} is below the minimum viable sale price "
                f"{listing.minimum_sale_price}"
            )
        if offer is None:
            problems.append("the source offer has disappeared")
        else:
            if offer.stock_status.value in ("OUT_OF_STOCK", "UNKNOWN"):
                problems.append(f"source stock status is {offer.stock_status.value}")
            if (offer.available_quantity or 0) < listing.quantity:
                problems.append("source does not have enough units for the listed quantity")

        from app.services.opportunity_service import OpportunityService

        stale = OpportunityService(self.session, self.config, self.providers).staleness(opportunity)
        problems.extend(stale)

        compliance = self.compliance.check(
            ComplianceCheckType.LISTING,
            ComplianceContext(
                title=listing.title,
                condition=listing.condition,
                declared_condition_matches_source=(
                    offer is not None and listing.condition is offer.condition
                ),
                identifiers=(
                    {i.identifier_type.value: i.value for i in product.identifiers} if product else {}
                ),
                category=listing.category_id,
                price=listing.price,
                match_is_verified=opportunity.match_confidence is not None
                and opportunity.match_confidence >= self.config.minimum_match_confidence,
                handling_time_days=listing.handling_time_days,
                automation_level=self.config.automation_level,
            ),
            entity_type="target_listing",
            entity_id=listing.id,
        )
        if compliance.is_blocking:
            problems.append(compliance.blocked_reason() or "blocked by compliance")

        if not problems:
            listing.state = ListingState.VALIDATED
            self.session.flush()
        return problems

    # -- publication --------------------------------------------------------
    def publish_listing(self, opportunity: Opportunity, listing: TargetListing) -> TargetListing:
        """Publish, after a mandatory revalidation.

        Revalidating immediately before publishing is not belt-and-braces: the
        price and stock behind this listing may have moved since the candidate
        was created, and a live listing is a promise to supply.
        """
        from app.services.opportunity_service import OpportunityService

        opportunities = OpportunityService(self.session, self.config, self.providers)
        opportunities.refresh_market_data(opportunity)

        problems = self.validate_listing(opportunity, listing)
        if problems:
            listing.last_error = "; ".join(problems)
            self.session.flush()
            raise StaleDataError(
                "listing cannot be published: " + "; ".join(problems),
                context={"opportunity": opportunity.reference, "problems": problems},
            )

        idempotency_key = deterministic_key("publish", opportunity.reference, listing.sku or listing.id)
        product = self.session.get(Product, opportunity.product_id)
        result = self.providers.target.publish_listing(
            PublishRequest(
                sku=listing.sku or f"SKU-{opportunity.reference}",
                title=listing.title,
                description=(product.description if product and product.description else listing.title),
                price=Money(listing.price, self.currency),
                quantity=listing.quantity,
                condition=listing.condition,
                idempotency_key=idempotency_key,
                category_id=listing.category_id,
                identifiers=(
                    {i.identifier_type.value: i.value for i in product.identifiers} if product else {}
                ),
                image_urls=list(product.image_urls) if product else [],
                shipping_price=Money(listing.shipping_price or Decimal("0"), self.currency),
                handling_time_days=listing.handling_time_days or self.config.target_handling_time_days,
                attributes=dict(listing.attributes),
            )
        )
        if not result.success:
            listing.state = ListingState.FAILED
            listing.last_error = result.message
            self.session.flush()
            raise ConflictError(
                f"publishing failed: {result.message}", context={"listing_id": listing.id}
            )

        listing.external_id = result.external_id
        listing.url = result.url
        listing.state = ListingState.PUBLISHED
        listing.published_at = utcnow()
        listing.last_error = None
        self.session.flush()

        if opportunity.state is OpportunityState.LISTING_CANDIDATE:
            OPPORTUNITY_MACHINE.validate(opportunity.state, OpportunityState.LISTED)
            opportunity.state = OpportunityState.LISTED
            self.session.flush()
        self.audit.record(
            "listing.published",
            entity_type="target_listing",
            entity_id=listing.id,
            new_state=ListingState.PUBLISHED.value,
            meta={
                "external_id": result.external_id,
                "price": str(listing.price),
                "opportunity": opportunity.reference,
                "replayed": result.already_published,
            },
        )
        return listing

    def update_listing(
        self, listing: TargetListing, *, price: Money | None = None, quantity: int | None = None
    ) -> TargetListing:
        if not listing.external_id:
            raise ConflictError("listing has not been published yet")
        below_floor = (
            price is not None
            and listing.minimum_sale_price is not None
            and price.amount < listing.minimum_sale_price
        )
        if below_floor:
            raise ValidationError(
                f"refusing to reprice below the minimum viable sale price "
                f"({listing.minimum_sale_price})",
                context={"listing_id": listing.id},
            )
        result = self.providers.target.update_listing(
            listing.external_id, price=price, quantity=quantity
        )
        if not result.success:
            raise ConflictError(f"listing update failed: {result.message}")
        if price is not None:
            listing.price = price.amount
            listing.price_timestamp = utcnow()
        if quantity is not None:
            listing.quantity = quantity
        self.session.flush()
        self.audit.record(
            "listing.updated",
            entity_type="target_listing",
            entity_id=listing.id,
            meta={"price": str(price.amount) if price else None, "quantity": quantity},
        )
        return listing

    def end_listing(self, listing: TargetListing, *, reason: str = "") -> TargetListing:
        if listing.external_id:
            self.providers.target.end_listing(listing.external_id, reason=reason)
        listing.state = ListingState.ENDED
        listing.ended_at = utcnow()
        self.session.flush()
        self.audit.record(
            "listing.ended",
            entity_type="target_listing",
            entity_id=listing.id,
            new_state=ListingState.ENDED.value,
            meta={"reason": reason},
        )
        return listing

    def get_listing_status(self, listing: TargetListing):
        if not listing.external_id:
            return None
        return self.providers.target.get_listing_status(listing.external_id)

    def revalidate_listing(self, opportunity: Opportunity, listing: TargetListing) -> list[str]:
        """Re-check a live listing and pull it if it is no longer viable."""
        from app.services.opportunity_service import OpportunityService

        OpportunityService(self.session, self.config, self.providers).refresh_market_data(opportunity)
        problems = self.validate_listing(opportunity, listing)
        if problems and listing.state is ListingState.PUBLISHED:
            self.audit.record(
                "listing.revalidation_failed",
                entity_type="target_listing",
                entity_id=listing.id,
                meta={"problems": problems},
            )
        return problems
