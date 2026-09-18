"""Opportunity state machine (discovery -> completion)."""

from __future__ import annotations

from app.models.enums import OpportunityState as S
from app.state_machines.base import build

#: Any state may fail, expire, be rejected or be cancelled; rather than
#: writing those edges out by hand for every source state we generate them.
_ACTIVE = [
    S.DISCOVERED,
    S.MATCH_PENDING,
    S.MATCH_VERIFIED,
    S.PRICE_PENDING,
    S.PROFITABLE,
    S.RISK_REVIEW,
    S.ACTIONABLE,
    S.LISTING_CANDIDATE,
    S.LISTED,
    S.SALE_RECEIVED,
    S.REVALIDATION_REQUIRED,
    S.APPROVAL_REQUIRED,
    S.APPROVED,
    S.EXECUTING,
    S.FULFILLMENT_PENDING,
]

_EDGES: list[tuple] = [
    (S.DISCOVERED, S.MATCH_PENDING, "matching queued"),
    (S.MATCH_PENDING, S.MATCH_VERIFIED, "match confidence >= minimum"),
    (S.MATCH_PENDING, S.BLOCKED, "variant mismatch / conflicting identifiers"),
    (S.MATCH_VERIFIED, S.PRICE_PENDING, "pricing queued"),
    (S.PRICE_PENDING, S.PROFITABLE, "profit and margin thresholds met"),
    (S.PRICE_PENDING, S.REJECTED, "below minimum profit or margin"),
    (S.PRICE_PENDING, S.BLOCKED, "no usable price on one side"),
    (S.PROFITABLE, S.BLOCKED, "hard blocker found after pricing"),
    (S.PROFITABLE, S.RISK_REVIEW, "risk scoring"),
    (S.RISK_REVIEW, S.ACTIONABLE, "risk within limit"),
    (S.RISK_REVIEW, S.REJECTED, "risk above maximum"),
    (S.RISK_REVIEW, S.BLOCKED, "hard risk blocker"),
    (S.ACTIONABLE, S.LISTING_CANDIDATE, "listing candidate created"),
    (S.ACTIONABLE, S.REVALIDATION_REQUIRED, "data went stale"),
    (S.LISTING_CANDIDATE, S.LISTED, "published on target marketplace", True),
    (S.LISTING_CANDIDATE, S.REVALIDATION_REQUIRED, "data went stale"),
    (S.LISTING_CANDIDATE, S.BLOCKED, "compliance block"),
    (S.LISTED, S.SALE_RECEIVED, "sale event received"),
    (S.LISTED, S.REVALIDATION_REQUIRED, "monitor detected change"),
    (S.LISTED, S.EXPIRED, "listing expired"),
    (S.SALE_RECEIVED, S.REVALIDATION_REQUIRED, "mandatory post-sale revalidation"),
    (S.REVALIDATION_REQUIRED, S.APPROVAL_REQUIRED, "revalidation passed"),
    (S.REVALIDATION_REQUIRED, S.ACTIONABLE, "revalidated before listing"),
    (S.REVALIDATION_REQUIRED, S.LISTED, "revalidated while listed"),
    (S.REVALIDATION_REQUIRED, S.REJECTED, "no longer profitable"),
    (S.REVALIDATION_REQUIRED, S.BLOCKED, "compliance or availability block"),
    (S.APPROVAL_REQUIRED, S.APPROVED, "operator approved source purchase"),
    (S.APPROVAL_REQUIRED, S.REJECTED, "operator rejected"),
    (S.APPROVAL_REQUIRED, S.REVALIDATION_REQUIRED, "approval data went stale"),
    (S.APPROVED, S.EXECUTING, "source purchase started", True),
    (S.EXECUTING, S.FULFILLMENT_PENDING, "source purchased", True),
    (S.FULFILLMENT_PENDING, S.FULFILLED, "shipped to customer", True),
    (S.FULFILLED, S.COMPLETED, "delivered and settled"),
    (S.FULFILLED, S.FAILED, "post-shipment failure"),
    (S.BLOCKED, S.MATCH_PENDING, "block cleared - re-evaluate"),
    (S.BLOCKED, S.REVALIDATION_REQUIRED, "block cleared after sale"),
    (S.BLOCKED, S.REJECTED, "block confirmed"),
]

_EDGES += [(state, S.FAILED, "unrecoverable error") for state in _ACTIVE]
_EDGES += [(state, S.CANCELLED, "cancelled by operator") for state in _ACTIVE]
_EXPIRABLE = (
    S.DISCOVERED,
    S.MATCH_PENDING,
    S.MATCH_VERIFIED,
    S.PRICE_PENDING,
    S.PROFITABLE,
    S.RISK_REVIEW,
    S.ACTIONABLE,
    S.LISTING_CANDIDATE,
)
_FILTERABLE = (
    S.DISCOVERED,
    S.MATCH_PENDING,
    S.MATCH_VERIFIED,
    S.PROFITABLE,
    S.ACTIONABLE,
    S.LISTING_CANDIDATE,
)
_EDGES += [(state, S.EXPIRED, "exceeded maximum age") for state in _EXPIRABLE]
_EDGES += [(state, S.REJECTED, "filtered out") for state in _FILTERABLE]

OPPORTUNITY_MACHINE = build(
    "opportunity",
    S.DISCOVERED,
    _EDGES,
    terminal=(S.COMPLETED, S.REJECTED, S.EXPIRED, S.FAILED, S.CANCELLED),
)
