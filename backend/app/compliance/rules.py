"""Compliance rules.

These are *gates*, not suggestions.  They run server-side before any action
that touches a marketplace, a carrier or the operator's money.

What this module is for: making sure we only list what we can actually and
lawfully supply, that the buyer gets accurate information, and that the
operator's own limits are respected.

What it is deliberately not for, and what this codebase must never gain: any
capability to evade marketplace policy, misrepresent the seller or the origin
of goods, falsify tracking, conceal a sourcing arrangement, deceive a buyer or
work around an account restriction.  A rule here may only ever *stop* an
action.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.models.enums import DecisionOutcome, ProductCondition, StockStatus

RULESET_VERSION = "1.0.0"


@dataclass(frozen=True)
class RuleResult:
    rule: str
    outcome: DecisionOutcome
    message: str

    def to_dict(self) -> dict:
        return {"rule": self.rule, "outcome": self.outcome.value, "message": self.message}


@dataclass
class ComplianceContext:
    """Facts the rules inspect. Anything absent is treated as not-yet-proven."""

    # listing
    title: str | None = None
    description: str | None = None
    condition: ProductCondition | None = None
    declared_condition_matches_source: bool | None = None
    identifiers: dict[str, str] = field(default_factory=dict)
    category: str | None = None
    image_urls: list[str] = field(default_factory=list)
    handling_time_days: int | None = None
    price: Decimal | None = None

    # order / sourcing
    source_stock_status: StockStatus | None = None
    source_available_quantity: int | None = None
    required_quantity: int = 1
    source_delivery_max_days: int | None = None
    buyer_delivery_expectation_days: int | None = None
    match_is_verified: bool | None = None

    # fulfilment
    ship_to: dict[str, Any] = field(default_factory=dict)
    tracking_number: str | None = None
    carrier: str | None = None
    inspection_passed: bool | None = None

    # policy
    restricted_categories: tuple[str, ...] = ()
    allowed_destination_countries: tuple[str, ...] = ()
    seller_account_active: bool = True
    is_simulated: bool = False
    #: Research mode: analysis only. Blocks every outward action.
    research_mode: bool = False
    automation_level: int = 2
    max_automation_without_approval: int = 3


@dataclass(frozen=True)
class ComplianceResult:
    outcome: DecisionOutcome
    results: list[RuleResult]
    ruleset_version: str = RULESET_VERSION

    @property
    def is_blocking(self) -> bool:
        return self.outcome in (DecisionOutcome.BLOCK, DecisionOutcome.REJECT)

    def blocked_reason(self) -> str | None:
        blocking = [r for r in self.results if r.outcome in (DecisionOutcome.BLOCK, DecisionOutcome.REJECT)]
        return "; ".join(f"{r.rule}: {r.message}" for r in blocking) or None

    def to_dicts(self) -> list[dict]:
        return [r.to_dict() for r in self.results]


def _combine(results: list[RuleResult]) -> ComplianceResult:
    outcome = DecisionOutcome.PASS
    for result in results:
        if result.outcome in (DecisionOutcome.BLOCK, DecisionOutcome.REJECT):
            outcome = DecisionOutcome.BLOCK
            break
        if result.outcome is DecisionOutcome.REVIEW:
            outcome = DecisionOutcome.REVIEW
    return ComplianceResult(outcome=outcome, results=results)


# ---------------------------------------------------------------------------
# Rule sets
# ---------------------------------------------------------------------------
def _research_block(action: str) -> RuleResult:
    return RuleResult(
        "research_mode",
        DecisionOutcome.BLOCK,
        f"research mode is active: {action} is disabled, this deployment only analyses",
    )


def check_listing(ctx: ComplianceContext) -> ComplianceResult:
    results: list[RuleResult] = []
    if ctx.research_mode:
        return _combine([_research_block("listing")])

    if not ctx.title or len(ctx.title.strip()) < 10:
        results.append(
            RuleResult("listing.title", DecisionOutcome.BLOCK, "listing title is missing or too short")
        )
    else:
        results.append(RuleResult("listing.title", DecisionOutcome.PASS, "title present"))

    if ctx.condition is None or ctx.condition is ProductCondition.UNKNOWN:
        results.append(
            RuleResult(
                "listing.condition_declared",
                DecisionOutcome.BLOCK,
                "the item condition must be stated on the listing",
            )
        )
    elif ctx.declared_condition_matches_source is False:
        # Listing an item in a condition it is not is a misrepresentation of
        # the product to the buyer. There is no configuration that allows it.
        results.append(
            RuleResult(
                "listing.condition_accuracy",
                DecisionOutcome.BLOCK,
                "declared condition does not match the condition of the goods we can source",
            )
        )
    else:
        results.append(
            RuleResult("listing.condition_accuracy", DecisionOutcome.PASS, "condition stated accurately")
        )

    if ctx.category and ctx.category.lower() in {c.lower() for c in ctx.restricted_categories}:
        results.append(
            RuleResult(
                "listing.restricted_category",
                DecisionOutcome.BLOCK,
                f"category {ctx.category!r} is on the operator's restricted list",
            )
        )

    if ctx.price is None or ctx.price <= 0:
        results.append(
            RuleResult("listing.price", DecisionOutcome.BLOCK, "a listing needs a positive price")
        )

    if not ctx.identifiers:
        results.append(
            RuleResult(
                "listing.identifiers",
                DecisionOutcome.REVIEW,
                "no product identifier on the listing - buyers and the marketplace expect one",
            )
        )

    if ctx.match_is_verified is False:
        results.append(
            RuleResult(
                "listing.verified_match",
                DecisionOutcome.BLOCK,
                "cannot list an item whose source match is unverified",
            )
        )

    if not ctx.seller_account_active:
        results.append(
            RuleResult(
                "seller.account_active",
                DecisionOutcome.BLOCK,
                "the seller account is not active; listing is not permitted",
            )
        )

    return _combine(results)


def check_order(ctx: ComplianceContext) -> ComplianceResult:
    """Run before committing money to a source purchase."""
    results: list[RuleResult] = []
    if ctx.research_mode:
        return _combine([_research_block("purchasing")])

    if ctx.source_stock_status is StockStatus.OUT_OF_STOCK:
        results.append(
            RuleResult(
                "order.supply",
                DecisionOutcome.BLOCK,
                "the source is out of stock - the sale cannot be supplied",
            )
        )
    elif ctx.source_stock_status is StockStatus.UNKNOWN or ctx.source_stock_status is None:
        results.append(
            RuleResult(
                "order.supply",
                DecisionOutcome.BLOCK,
                "source availability is unknown - refusing to commit to a sale we may not be able to supply",
            )
        )
    elif (
        ctx.source_available_quantity is not None
        and ctx.source_available_quantity < ctx.required_quantity
    ):
        results.append(
            RuleResult(
                "order.supply",
                DecisionOutcome.BLOCK,
                f"source has {ctx.source_available_quantity} units, {ctx.required_quantity} required",
            )
        )
    else:
        results.append(RuleResult("order.supply", DecisionOutcome.PASS, "supply confirmed at source"))

    if ctx.source_delivery_max_days is not None and ctx.buyer_delivery_expectation_days is not None:
        if ctx.source_delivery_max_days > ctx.buyer_delivery_expectation_days:
            results.append(
                RuleResult(
                    "order.delivery_promise",
                    DecisionOutcome.BLOCK,
                    f"source needs up to {ctx.source_delivery_max_days} days against a "
                    f"{ctx.buyer_delivery_expectation_days} day promise to the buyer",
                )
            )
        else:
            results.append(
                RuleResult("order.delivery_promise", DecisionOutcome.PASS, "delivery promise is achievable")
            )
    else:
        results.append(
            RuleResult(
                "order.delivery_promise",
                DecisionOutcome.REVIEW,
                "delivery feasibility could not be established from the available data",
            )
        )

    if ctx.match_is_verified is not True:
        results.append(
            RuleResult(
                "order.verified_match",
                DecisionOutcome.BLOCK,
                "the product match is not verified; buying the wrong item is not recoverable",
            )
        )

    if ctx.automation_level > ctx.max_automation_without_approval:
        results.append(
            RuleResult(
                "order.automation_level",
                DecisionOutcome.REVIEW,
                f"automation level {ctx.automation_level} exceeds the level permitted without approval",
            )
        )

    return _combine(results)


def check_fulfillment(ctx: ComplianceContext) -> ComplianceResult:
    """Run before dispatching to the buyer."""
    results: list[RuleResult] = []
    if ctx.research_mode:
        return _combine([_research_block("shipping")])

    required = ("name", "street", "postal_code", "city", "country")
    missing = [f for f in required if not ctx.ship_to.get(f)]
    if missing:
        results.append(
            RuleResult(
                "fulfillment.address",
                DecisionOutcome.BLOCK,
                f"destination address is incomplete: missing {', '.join(missing)}",
            )
        )
    else:
        results.append(RuleResult("fulfillment.address", DecisionOutcome.PASS, "destination complete"))

    country = str(ctx.ship_to.get("country", "")).upper()
    if ctx.allowed_destination_countries and country not in ctx.allowed_destination_countries:
        results.append(
            RuleResult(
                "fulfillment.destination_allowed",
                DecisionOutcome.BLOCK,
                f"destination country {country!r} is outside the configured shipping area",
            )
        )

    if ctx.inspection_passed is not True:
        results.append(
            RuleResult(
                "fulfillment.inspection",
                DecisionOutcome.BLOCK,
                "the goods must pass inspection before they are dispatched to the buyer",
            )
        )
    else:
        results.append(RuleResult("fulfillment.inspection", DecisionOutcome.PASS, "inspection passed"))

    if ctx.tracking_number is not None and not ctx.carrier:
        # Tracking must identify the actual carrier that actually holds the
        # parcel. A tracking number without a carrier cannot be verified and
        # must never be uploaded.
        results.append(
            RuleResult(
                "fulfillment.tracking_integrity",
                DecisionOutcome.BLOCK,
                "tracking must name the carrier actually carrying the parcel",
            )
        )

    return _combine(results)


def check_marketplace_policy(ctx: ComplianceContext) -> ComplianceResult:
    results: list[RuleResult] = []

    if ctx.handling_time_days is not None and ctx.handling_time_days < 1:
        results.append(
            RuleResult(
                "policy.handling_time",
                DecisionOutcome.REVIEW,
                "a handling time below one day is unlikely to be met by manual fulfilment",
            )
        )
    if ctx.category and ctx.category.lower() in {c.lower() for c in ctx.restricted_categories}:
        results.append(
            RuleResult(
                "policy.restricted_category",
                DecisionOutcome.BLOCK,
                f"category {ctx.category!r} is restricted",
            )
        )
    if not results:
        results.append(
            RuleResult("policy.general", DecisionOutcome.PASS, "no marketplace policy conflicts found")
        )
    return _combine(results)


def check_seller_requirements(ctx: ComplianceContext) -> ComplianceResult:
    results: list[RuleResult] = []
    if not ctx.seller_account_active:
        results.append(
            RuleResult("seller.account_active", DecisionOutcome.BLOCK, "seller account is not active")
        )
    else:
        results.append(RuleResult("seller.account_active", DecisionOutcome.PASS, "seller account active"))
    if ctx.handling_time_days is not None and ctx.handling_time_days > 3:
        results.append(
            RuleResult(
                "seller.handling_time",
                DecisionOutcome.REVIEW,
                "handling times above three days damage seller standing",
            )
        )
    return _combine(results)
