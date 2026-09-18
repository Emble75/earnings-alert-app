"""Domain enumerations.

Every value is a stable string: it is what gets written to the database, to
the audit log and to the API, so members may be added but never renamed or
repurposed.
"""

from __future__ import annotations

from enum import StrEnum as _StrEnum


class StrEnum(_StrEnum):
    """Base for all domain enums (``str``-valued, stable across releases)."""


# ---------------------------------------------------------------------------
# Opportunity lifecycle
# ---------------------------------------------------------------------------
class OpportunityState(StrEnum):
    DISCOVERED = "DISCOVERED"
    MATCH_PENDING = "MATCH_PENDING"
    MATCH_VERIFIED = "MATCH_VERIFIED"
    PRICE_PENDING = "PRICE_PENDING"
    PROFITABLE = "PROFITABLE"
    RISK_REVIEW = "RISK_REVIEW"
    ACTIONABLE = "ACTIONABLE"
    LISTING_CANDIDATE = "LISTING_CANDIDATE"
    LISTED = "LISTED"
    SALE_RECEIVED = "SALE_RECEIVED"
    REVALIDATION_REQUIRED = "REVALIDATION_REQUIRED"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    APPROVED = "APPROVED"
    EXECUTING = "EXECUTING"
    FULFILLMENT_PENDING = "FULFILLMENT_PENDING"
    FULFILLED = "FULFILLED"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    BLOCKED = "BLOCKED"


class OrderState(StrEnum):
    SALE_RECEIVED = "SALE_RECEIVED"
    VALIDATING = "VALIDATING"
    REVALIDATION_REQUIRED = "REVALIDATION_REQUIRED"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    APPROVED = "APPROVED"
    SOURCE_PURCHASE_PENDING = "SOURCE_PURCHASE_PENDING"
    SOURCE_PURCHASED = "SOURCE_PURCHASED"
    SOURCE_SHIPPING = "SOURCE_SHIPPING"
    SOURCE_RECEIVED = "SOURCE_RECEIVED"
    INSPECTION = "INSPECTION"
    FULFILLMENT = "FULFILLMENT"
    OUTBOUND_SHIPPING = "OUTBOUND_SHIPPING"
    SHIPPED = "SHIPPED"
    DELIVERED = "DELIVERED"
    RETURN_REQUESTED = "RETURN_REQUESTED"
    RETURNED = "RETURNED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    BLOCKED = "BLOCKED"


class ShipmentState(StrEnum):
    PENDING = "PENDING"
    LABEL_CREATED = "LABEL_CREATED"
    SHIPPED = "SHIPPED"
    IN_TRANSIT = "IN_TRANSIT"
    OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY"
    DELIVERED = "DELIVERED"
    EXCEPTION = "EXCEPTION"
    LOST = "LOST"
    RETURNED = "RETURNED"


class ReturnState(StrEnum):
    RETURN_REQUESTED = "RETURN_REQUESTED"
    RETURN_AUTHORIZED = "RETURN_AUTHORIZED"
    RETURN_IN_TRANSIT = "RETURN_IN_TRANSIT"
    RETURN_RECEIVED = "RETURN_RECEIVED"
    INSPECTION_REQUIRED = "INSPECTION_REQUIRED"
    REFUND_REQUIRED = "REFUND_REQUIRED"
    REFUNDED = "REFUNDED"
    CLOSED = "CLOSED"


class ListingState(StrEnum):
    DRAFT = "DRAFT"
    CANDIDATE = "CANDIDATE"
    VALIDATED = "VALIDATED"
    PUBLISHED = "PUBLISHED"
    UPDATING = "UPDATING"
    PAUSED = "PAUSED"
    ENDED = "ENDED"
    FAILED = "FAILED"


# ---------------------------------------------------------------------------
# Product / matching
# ---------------------------------------------------------------------------
class IdentifierType(StrEnum):
    EAN = "EAN"
    GTIN = "GTIN"
    UPC = "UPC"
    ISBN = "ISBN"
    MPN = "MPN"
    ASIN = "ASIN"
    EPID = "EPID"
    SKU = "SKU"
    MODEL = "MODEL"


class MatchStatus(StrEnum):
    MATCHED = "MATCHED"
    UNKNOWN = "UNKNOWN"
    BLOCKED = "BLOCKED"
    REVIEW = "REVIEW"


class MatchMethod(StrEnum):
    IDENTIFIER = "IDENTIFIER"
    BRAND_MPN = "BRAND_MPN"
    ATTRIBUTES = "ATTRIBUTES"
    TITLE = "TITLE"
    MANUAL = "MANUAL"


class ProductCondition(StrEnum):
    NEW = "NEW"
    NEW_OTHER = "NEW_OTHER"
    REFURBISHED = "REFURBISHED"
    USED = "USED"
    DAMAGED = "DAMAGED"
    UNKNOWN = "UNKNOWN"


# ---------------------------------------------------------------------------
# Inventory / delivery / risk
# ---------------------------------------------------------------------------
class StockStatus(StrEnum):
    IN_STOCK = "IN_STOCK"
    LOW_STOCK = "LOW_STOCK"
    OUT_OF_STOCK = "OUT_OF_STOCK"
    UNKNOWN = "UNKNOWN"


class DeliverySpeed(StrEnum):
    EXPRESS = "EXPRESS"
    FAST = "FAST"
    STANDARD = "STANDARD"
    SLOW = "SLOW"
    UNKNOWN = "UNKNOWN"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MODERATE = "MODERATE"
    ELEVATED = "ELEVATED"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class DecisionOutcome(StrEnum):
    PASS = "PASS"
    REVIEW = "REVIEW"
    REJECT = "REJECT"
    BLOCK = "BLOCK"


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------
class FulfillmentMode(StrEnum):
    MANUAL = "MANUAL"
    EXTERNAL_3PL = "EXTERNAL_3PL"
    WAREHOUSE = "WAREHOUSE"


class FulfillmentState(StrEnum):
    PENDING = "PENDING"
    INBOUND_CREATED = "INBOUND_CREATED"
    SOURCE_DELIVERED = "SOURCE_DELIVERED"
    RECEIVED = "RECEIVED"
    INSPECTED = "INSPECTED"
    REPACKED = "REPACKED"
    OUTBOUND_PREPARED = "OUTBOUND_PREPARED"
    OUTBOUND_CREATED = "OUTBOUND_CREATED"
    TRACKING_ENTERED = "TRACKING_ENTERED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class InspectionResult(StrEnum):
    PASS = "PASS"
    FAIL_WRONG_ITEM = "FAIL_WRONG_ITEM"
    FAIL_WRONG_QUANTITY = "FAIL_WRONG_QUANTITY"
    FAIL_CONDITION = "FAIL_CONDITION"
    FAIL_MISSING_ACCESSORIES = "FAIL_MISSING_ACCESSORIES"
    FAIL_DAMAGED = "FAIL_DAMAGED"
    PENDING = "PENDING"


class SourceOrderState(StrEnum):
    PENDING = "PENDING"
    PLACED = "PLACED"
    CONFIRMED = "CONFIRMED"
    SHIPPED = "SHIPPED"
    DELIVERED = "DELIVERED"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"
    REFUNDED = "REFUNDED"


class NotificationChannel(StrEnum):
    EMAIL = "EMAIL"
    TELEGRAM = "TELEGRAM"
    DISCORD = "DISCORD"
    IN_APP = "IN_APP"


class NotificationEvent(StrEnum):
    HIGH_VALUE_OPPORTUNITY = "HIGH_VALUE_OPPORTUNITY"
    LISTING_PUBLISHED = "LISTING_PUBLISHED"
    SALE_RECEIVED = "SALE_RECEIVED"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    SOURCE_PRICE_CHANGED = "SOURCE_PRICE_CHANGED"
    SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
    RISK_INCREASED = "RISK_INCREASED"
    SHIPMENT_DELAYED = "SHIPMENT_DELAYED"
    DELIVERY_EXCEPTION = "DELIVERY_EXCEPTION"
    RETURN_REQUESTED = "RETURN_REQUESTED"
    ORDER_COMPLETED = "ORDER_COMPLETED"
    PROFIT_REALIZED = "PROFIT_REALIZED"
    COMPLIANCE_BLOCKED = "COMPLIANCE_BLOCKED"
    CAPITAL_LIMIT_REACHED = "CAPITAL_LIMIT_REACHED"


class NotificationStatus(StrEnum):
    PENDING = "PENDING"
    SENT = "SENT"
    FAILED = "FAILED"
    SUPPRESSED = "SUPPRESSED"


class ComplianceCheckType(StrEnum):
    LISTING = "LISTING"
    ORDER = "ORDER"
    FULFILLMENT = "FULFILLMENT"
    MARKETPLACE_POLICY = "MARKETPLACE_POLICY"
    SELLER_REQUIREMENTS = "SELLER_REQUIREMENTS"


class UserRole(StrEnum):
    OPERATOR = "OPERATOR"
    ADMIN = "ADMIN"
    VIEWER = "VIEWER"


class ExecutionMode(StrEnum):
    LIVE = "LIVE"
    SIMULATION = "SIMULATION"
    DEMO = "DEMO"


class ScenarioType(StrEnum):
    BEST_CASE = "BEST_CASE"
    BASE_CASE = "BASE_CASE"
    WORST_CASE = "WORST_CASE"


class PriceTrend(StrEnum):
    RISING = "RISING"
    STABLE = "STABLE"
    FALLING = "FALLING"
    UNKNOWN = "UNKNOWN"


class CapitalReservationState(StrEnum):
    RESERVED = "RESERVED"
    COMMITTED = "COMMITTED"
    RELEASED = "RELEASED"
