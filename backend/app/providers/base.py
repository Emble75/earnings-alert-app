"""Provider interfaces.

The arbitrage engines never import Amazon or eBay.  They depend on the
protocols below, which is what makes "add another source marketplace" a new
adapter rather than a rewrite.  Every method that costs money or touches an
external system takes an ``idempotency_key``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.core.money import Money
from app.models.enums import DeliverySpeed, ProductCondition, StockStatus


# ---------------------------------------------------------------------------
# Data transfer objects
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class OfferSnapshot:
    """A point-in-time observation of a purchasable source offer."""

    external_id: str
    title: str
    price: Money | None
    shipping_cost: Money
    stock_status: StockStatus
    observed_at: datetime
    identifiers: dict[str, str] = field(default_factory=dict)
    brand: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    condition: ProductCondition = ProductCondition.UNKNOWN
    available_quantity: int | None = None
    stock_confidence: Decimal = Decimal("0")
    max_order_quantity: int | None = None
    delivery_min_days: int | None = None
    delivery_max_days: int | None = None
    delivery_speed: DeliverySpeed = DeliverySpeed.UNKNOWN
    is_fast_shipping_eligible: bool = False
    seller_id: str | None = None
    seller_name: str | None = None
    sold_by_marketplace: bool = False
    url: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
    #: A price that requires a coupon or membership. Never used as the base
    #: purchase price - those conditions may not hold when we actually buy.
    conditional_price: Money | None = None
    conditional_price_note: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ListingSnapshot:
    """An observation of a listing on the target marketplace."""

    external_id: str
    title: str
    price: Money | None
    shipping_price: Money
    observed_at: datetime
    identifiers: dict[str, str] = field(default_factory=dict)
    brand: str | None = None
    model: str | None = None
    condition: ProductCondition = ProductCondition.UNKNOWN
    seller_id: str | None = None
    quantity: int = 1
    sold_quantity: int | None = None
    category_id: str | None = None
    url: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MarketStats:
    """Aggregated competitive picture for one product."""

    observed_at: datetime
    competitor_count: int
    seller_count: int
    lowest_price: Money | None
    median_price: Money | None
    highest_price: Money | None
    #: What we actually expect to sell at - never simply the highest observed
    #: price. Derived by the provider from the price distribution.
    realistic_sale_price: Money | None
    sold_last_30d: int | None = None
    price_volatility: Decimal | None = None
    distribution: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PurchaseRequest:
    offer_external_id: str
    quantity: int
    max_unit_price: Money
    """Hard ceiling. The provider must refuse rather than pay more - this is
    the last defence against a price change between approval and purchase."""
    idempotency_key: str
    ship_to: dict[str, Any] = field(default_factory=dict)
    reference: str | None = None


@dataclass(frozen=True)
class PurchaseResult:
    success: bool
    external_order_id: str | None
    unit_price: Money | None
    shipping_cost: Money | None
    total_cost: Money | None
    estimated_delivery: datetime | None = None
    message: str = ""
    already_placed: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PublishRequest:
    sku: str
    title: str
    description: str
    price: Money
    quantity: int
    condition: ProductCondition
    idempotency_key: str
    category_id: str | None = None
    identifiers: dict[str, str] = field(default_factory=dict)
    image_urls: list[str] = field(default_factory=list)
    shipping_price: Money | None = None
    handling_time_days: int = 1
    attributes: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PublishResult:
    success: bool
    external_id: str | None
    url: str | None = None
    message: str = ""
    already_published: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SaleEvent:
    """A sale reported by the target marketplace."""

    external_order_id: str
    sku: str | None
    listing_external_id: str | None
    quantity: int
    sale_price: Money
    buyer_shipping_paid: Money
    sold_at: datetime
    ship_to: dict[str, Any] = field(default_factory=dict)
    buyer_reference: str | None = None
    delivery_deadline: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TrackingUpdate:
    tracking_number: str
    carrier: str
    status: str
    observed_at: datetime
    estimated_delivery: datetime | None = None
    actual_delivery: datetime | None = None
    events: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Interfaces
# ---------------------------------------------------------------------------
class Provider(ABC):
    """Common provider surface."""

    name: str = "provider"
    is_live: bool = False

    @abstractmethod
    def health(self) -> dict[str, Any]:
        """Report reachability and rate-limit headroom."""


class SourceProvider(Provider):
    """A marketplace we buy from."""

    @abstractmethod
    def search(self, query: str, *, limit: int = 20) -> list[OfferSnapshot]: ...

    @abstractmethod
    def get_offer(self, external_id: str) -> OfferSnapshot | None: ...

    @abstractmethod
    def get_offers(self, external_ids: list[str]) -> list[OfferSnapshot]: ...

    @abstractmethod
    def find_by_identifier(self, identifier_type: str, value: str) -> list[OfferSnapshot]: ...

    @abstractmethod
    def purchase(self, request: PurchaseRequest) -> PurchaseResult:
        """Buy. Must be idempotent on ``request.idempotency_key``."""


class TargetMarketplaceProvider(Provider):
    """A marketplace we sell on."""

    @abstractmethod
    def search_listings(self, query: str, *, limit: int = 20) -> list[ListingSnapshot]: ...

    @abstractmethod
    def find_by_identifier(self, identifier_type: str, value: str) -> list[ListingSnapshot]: ...

    @abstractmethod
    def get_market_stats(
        self, *, identifier: str | None = None, query: str | None = None
    ) -> MarketStats: ...

    @abstractmethod
    def publish_listing(self, request: PublishRequest) -> PublishResult: ...

    @abstractmethod
    def update_listing(
        self, external_id: str, *, price: Money | None = None, quantity: int | None = None
    ) -> PublishResult: ...

    @abstractmethod
    def end_listing(self, external_id: str, *, reason: str = "") -> PublishResult: ...

    @abstractmethod
    def get_listing_status(self, external_id: str) -> ListingSnapshot | None: ...

    @abstractmethod
    def fetch_sales(self, *, since: datetime | None = None) -> list[SaleEvent]: ...

    @abstractmethod
    def upload_tracking(
        self,
        external_order_id: str,
        *,
        carrier: str,
        tracking_number: str,
        idempotency_key: str,
    ) -> bool: ...

    @abstractmethod
    def verify_webhook(self, payload: bytes, signature: str | None) -> bool:
        """Authenticate an inbound webhook before anything is created from it."""


class PriceProvider(ABC):
    @abstractmethod
    def get_price(self, external_id: str) -> Money | None: ...


class InventoryProvider(ABC):
    @abstractmethod
    def get_stock(self, external_id: str) -> tuple[StockStatus, int | None]: ...


class ShippingProvider(ABC):
    @abstractmethod
    def quote(self, *, weight_grams: int, destination: dict[str, Any]) -> Money: ...

    @abstractmethod
    def create_label(
        self, *, order_reference: str, destination: dict[str, Any], idempotency_key: str
    ) -> dict[str, Any]: ...

    @abstractmethod
    def track(self, tracking_number: str, *, carrier: str) -> TrackingUpdate | None: ...


class NotificationProvider(ABC):
    channel: str = "in_app"

    @abstractmethod
    def send(self, *, subject: str, body: str, payload: dict[str, Any] | None = None) -> bool: ...
