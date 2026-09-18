"""Live provider adapters over a documented JSON gateway contract.

Amazon's SP-API and eBay's Sell/Browse APIs each have their own auth dance,
throttling rules and payload shapes, and neither can be exercised honestly
without real credentials.  Rather than ship untested guesses at those wire
formats, the live adapters speak one small, stable JSON contract (documented
in ``docs/providers.md``) and leave the marketplace-specific translation in a
single, replaceable place.

Two ways to use this in production:

1. Point ``*_API_BASE_URL`` at a thin gateway of your own that speaks this
   contract and holds the marketplace SDK.
2. Subclass :class:`HttpSourceProvider` / :class:`HttpTargetProvider` and
   override ``_get``/``_post`` plus the parsers with the real endpoints.

Either way the engines above never change.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

import httpx

from app.core.clock import utcnow
from app.core.errors import ProviderError, ProviderRateLimitedError
from app.core.money import Money
from app.models.enums import DeliverySpeed, ProductCondition, StockStatus
from app.providers.base import (
    ListingSnapshot,
    MarketStats,
    OfferSnapshot,
    PublishRequest,
    PublishResult,
    PurchaseRequest,
    PurchaseResult,
    SaleEvent,
    SourceProvider,
    TargetMarketplaceProvider,
)
from app.providers.resilience import ProviderGuard, RateLimit


def _money(value: Any, currency: str) -> Money | None:
    if value is None or value == "":
        return None
    if isinstance(value, float):
        # A gateway that sends floats for money is a gateway we cannot trust
        # to the cent; convert via str and record it in the docs as a defect.
        value = repr(value)
    return Money(str(value), currency)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


class _HttpBase:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str = "",
        api_secret: str = "",
        currency: str = "EUR",
        marketplace: str = "",
        timeout: float = 20.0,
        max_calls_per_minute: int = 60,
        client: httpx.Client | None = None,
    ) -> None:
        if not base_url:
            raise ProviderError(
                f"{self.name} requires a base URL; set the provider's *_API_BASE_URL",
                retryable=False,
            )
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.api_secret = api_secret
        self.currency = currency
        self.marketplace = marketplace
        self._client = client or httpx.Client(timeout=timeout)
        self.guard = ProviderGuard(
            provider=self.name, rate_limit=RateLimit(max_calls_per_minute, 60.0)
        )

    name = "http"

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "X-Marketplace": self.marketplace}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            response = self._client.request(method, url, headers=self._headers(), **kwargs)
        except httpx.RequestError as exc:
            raise ProviderError(f"{self.name}: {exc}", context={"url": path}, retryable=True) from exc
        if response.status_code == 429:
            raise ProviderRateLimitedError(
                f"{self.name} rate limited", context={"retry_after": response.headers.get("Retry-After")}
            )
        if response.status_code >= 500:
            raise ProviderError(
                f"{self.name} returned {response.status_code}", context={"url": path}, retryable=True
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"{self.name} returned {response.status_code}: {response.text[:300]}",
                context={"url": path},
                retryable=False,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderError(f"{self.name} returned non-JSON", retryable=False) from exc

    def _get(self, path: str, **params: Any) -> dict[str, Any]:
        clean = {k: v for k, v in params.items() if v is not None}
        return self.guard.call(f"GET {path}", self._request, "GET", path, params=clean)

    def _post(self, path: str, payload: dict[str, Any], *, idempotency_key: str | None = None) -> dict:
        kwargs: dict[str, Any] = {"json": payload}
        if idempotency_key:
            kwargs["headers"] = {**self._headers(), "Idempotency-Key": idempotency_key}
        return self.guard.call(f"POST {path}", self._request, "POST", path, **kwargs)

    def health(self) -> dict[str, Any]:
        try:
            payload = self._get("/health")
            status = payload.get("status", "HEALTHY")
        except ProviderError as exc:
            return {"provider": self.name, "status": "UNHEALTHY", "live": True, "error": str(exc)}
        return {
            "provider": self.name,
            "status": status,
            "live": True,
            "circuit": self.guard.breaker.state,
        }


class HttpSourceProvider(_HttpBase, SourceProvider):
    """Live source marketplace adapter (Amazon in v1)."""

    name = "amazon"
    is_live = True

    def _to_offer(self, payload: dict[str, Any]) -> OfferSnapshot:
        return OfferSnapshot(
            external_id=str(payload["external_id"]),
            title=payload.get("title", ""),
            price=_money(payload.get("price"), self.currency),
            shipping_cost=_money(payload.get("shipping_cost"), self.currency) or Money.zero(self.currency),
            stock_status=StockStatus(payload.get("stock_status", "UNKNOWN")),
            observed_at=_parse_dt(payload.get("observed_at")) or utcnow(),
            identifiers={k.upper(): str(v) for k, v in (payload.get("identifiers") or {}).items() if v},
            brand=payload.get("brand"),
            manufacturer=payload.get("manufacturer"),
            model=payload.get("model"),
            condition=ProductCondition(payload.get("condition", "UNKNOWN")),
            available_quantity=payload.get("available_quantity"),
            stock_confidence=Decimal(str(payload.get("stock_confidence", "0"))),
            max_order_quantity=payload.get("max_order_quantity"),
            delivery_min_days=payload.get("delivery_min_days"),
            delivery_max_days=payload.get("delivery_max_days"),
            delivery_speed=DeliverySpeed(payload.get("delivery_speed", "UNKNOWN")),
            is_fast_shipping_eligible=bool(payload.get("is_fast_shipping_eligible", False)),
            seller_id=payload.get("seller_id"),
            seller_name=payload.get("seller_name"),
            sold_by_marketplace=bool(payload.get("sold_by_marketplace", False)),
            url=payload.get("url"),
            attributes=payload.get("attributes") or {},
            conditional_price=_money(payload.get("conditional_price"), self.currency),
            conditional_price_note=payload.get("conditional_price_note"),
            raw=payload,
        )

    def search(self, query: str, *, limit: int = 20) -> list[OfferSnapshot]:
        payload = self._get("/offers/search", q=query, limit=limit)
        return [self._to_offer(item) for item in payload.get("offers", [])]

    def get_offer(self, external_id: str) -> OfferSnapshot | None:
        payload = self._get(f"/offers/{external_id}")
        offer = payload.get("offer")
        return self._to_offer(offer) if offer else None

    def get_offers(self, external_ids: list[str]) -> list[OfferSnapshot]:
        payload = self._get("/offers", ids=",".join(external_ids))
        return [self._to_offer(item) for item in payload.get("offers", [])]

    def find_by_identifier(self, identifier_type: str, value: str) -> list[OfferSnapshot]:
        payload = self._get("/offers/by-identifier", type=identifier_type, value=value)
        return [self._to_offer(item) for item in payload.get("offers", [])]

    def purchase(self, request: PurchaseRequest) -> PurchaseResult:
        payload = self._post(
            "/purchases",
            {
                "offer_external_id": request.offer_external_id,
                "quantity": request.quantity,
                # The ceiling travels with the request so the gateway refuses
                # a price that moved after approval, rather than paying it.
                "max_unit_price": str(request.max_unit_price.amount),
                "currency": request.max_unit_price.currency,
                "ship_to": request.ship_to,
                "reference": request.reference,
            },
            idempotency_key=request.idempotency_key,
        )
        return PurchaseResult(
            success=bool(payload.get("success")),
            external_order_id=payload.get("external_order_id"),
            unit_price=_money(payload.get("unit_price"), self.currency),
            shipping_cost=_money(payload.get("shipping_cost"), self.currency),
            total_cost=_money(payload.get("total_cost"), self.currency),
            estimated_delivery=_parse_dt(payload.get("estimated_delivery")),
            message=payload.get("message", ""),
            already_placed=bool(payload.get("already_placed")),
            raw=payload,
        )


class HttpTargetProvider(_HttpBase, TargetMarketplaceProvider):
    """Live target marketplace adapter (eBay in v1)."""

    name = "ebay"
    is_live = True

    def __init__(self, *, webhook_secret: str = "", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.webhook_secret = webhook_secret

    def _to_listing(self, payload: dict[str, Any]) -> ListingSnapshot:
        return ListingSnapshot(
            external_id=str(payload["external_id"]),
            title=payload.get("title", ""),
            price=_money(payload.get("price"), self.currency),
            shipping_price=_money(payload.get("shipping_price"), self.currency)
            or Money.zero(self.currency),
            observed_at=_parse_dt(payload.get("observed_at")) or utcnow(),
            identifiers={k.upper(): str(v) for k, v in (payload.get("identifiers") or {}).items() if v},
            brand=payload.get("brand"),
            model=payload.get("model"),
            condition=ProductCondition(payload.get("condition", "UNKNOWN")),
            seller_id=payload.get("seller_id"),
            quantity=int(payload.get("quantity", 1)),
            sold_quantity=payload.get("sold_quantity"),
            category_id=payload.get("category_id"),
            url=payload.get("url"),
            attributes=payload.get("attributes") or {},
            raw=payload,
        )

    def search_listings(self, query: str, *, limit: int = 20) -> list[ListingSnapshot]:
        payload = self._get("/listings/search", q=query, limit=limit)
        return [self._to_listing(item) for item in payload.get("listings", [])]

    def find_by_identifier(self, identifier_type: str, value: str) -> list[ListingSnapshot]:
        payload = self._get("/listings/by-identifier", type=identifier_type, value=value)
        return [self._to_listing(item) for item in payload.get("listings", [])]

    def get_market_stats(
        self, *, identifier: str | None = None, query: str | None = None
    ) -> MarketStats:
        payload = self._get("/market/stats", identifier=identifier, q=query)
        return MarketStats(
            observed_at=_parse_dt(payload.get("observed_at")) or utcnow(),
            competitor_count=int(payload.get("competitor_count", 0)),
            seller_count=int(payload.get("seller_count", 0)),
            lowest_price=_money(payload.get("lowest_price"), self.currency),
            median_price=_money(payload.get("median_price"), self.currency),
            highest_price=_money(payload.get("highest_price"), self.currency),
            realistic_sale_price=_money(payload.get("realistic_sale_price"), self.currency),
            sold_last_30d=payload.get("sold_last_30d"),
            price_volatility=(
                Decimal(str(payload["price_volatility"]))
                if payload.get("price_volatility") is not None
                else None
            ),
            distribution=payload.get("distribution") or {},
        )

    def publish_listing(self, request: PublishRequest) -> PublishResult:
        payload = self._post(
            "/listings",
            {
                "sku": request.sku,
                "title": request.title,
                "description": request.description,
                "price": str(request.price.amount),
                "currency": request.price.currency,
                "quantity": request.quantity,
                "condition": request.condition.value,
                "category_id": request.category_id,
                "identifiers": request.identifiers,
                "image_urls": request.image_urls,
                "shipping_price": (
                    str(request.shipping_price.amount) if request.shipping_price else None
                ),
                "handling_time_days": request.handling_time_days,
                "attributes": request.attributes,
            },
            idempotency_key=request.idempotency_key,
        )
        return PublishResult(
            success=bool(payload.get("success")),
            external_id=payload.get("external_id"),
            url=payload.get("url"),
            message=payload.get("message", ""),
            already_published=bool(payload.get("already_published")),
            raw=payload,
        )

    def update_listing(
        self, external_id: str, *, price: Money | None = None, quantity: int | None = None
    ) -> PublishResult:
        payload = self._post(
            f"/listings/{external_id}/update",
            {
                "price": str(price.amount) if price else None,
                "quantity": quantity,
            },
        )
        return PublishResult(
            success=bool(payload.get("success")),
            external_id=external_id,
            message=payload.get("message", ""),
            raw=payload,
        )

    def end_listing(self, external_id: str, *, reason: str = "") -> PublishResult:
        payload = self._post(f"/listings/{external_id}/end", {"reason": reason})
        return PublishResult(
            success=bool(payload.get("success")),
            external_id=external_id,
            message=payload.get("message", ""),
            raw=payload,
        )

    def get_listing_status(self, external_id: str) -> ListingSnapshot | None:
        payload = self._get(f"/listings/{external_id}")
        listing = payload.get("listing")
        return self._to_listing(listing) if listing else None

    def fetch_sales(self, *, since: datetime | None = None) -> list[SaleEvent]:
        payload = self._get("/sales", since=since.isoformat() if since else None)
        events = []
        for item in payload.get("sales", []):
            events.append(
                SaleEvent(
                    external_order_id=str(item["external_order_id"]),
                    sku=item.get("sku"),
                    listing_external_id=item.get("listing_external_id"),
                    quantity=int(item.get("quantity", 1)),
                    sale_price=_money(item.get("sale_price"), self.currency)
                    or Money.zero(self.currency),
                    buyer_shipping_paid=_money(item.get("buyer_shipping_paid"), self.currency)
                    or Money.zero(self.currency),
                    sold_at=_parse_dt(item.get("sold_at")) or utcnow(),
                    ship_to=item.get("ship_to") or {},
                    buyer_reference=item.get("buyer_reference"),
                    delivery_deadline=_parse_dt(item.get("delivery_deadline")),
                    raw=item,
                )
            )
        return events

    def upload_tracking(
        self, external_order_id: str, *, carrier: str, tracking_number: str, idempotency_key: str
    ) -> bool:
        payload = self._post(
            f"/orders/{external_order_id}/tracking",
            {"carrier": carrier, "tracking_number": tracking_number},
            idempotency_key=idempotency_key,
        )
        return bool(payload.get("success"))

    def verify_webhook(self, payload: bytes, signature: str | None) -> bool:
        """Reject everything when no secret is configured.

        An unauthenticated webhook can create orders, so a live provider fails
        closed - the opposite of the demo provider's behaviour.
        """
        import hashlib
        import hmac

        if not self.webhook_secret or not signature:
            return False
        expected = hmac.new(self.webhook_secret.encode(), payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)
