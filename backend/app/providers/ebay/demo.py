"""Demo eBay target marketplace provider.

Publishes to an in-memory store, reports a deterministic competitive picture
and can synthesise a sale so the whole sell-first workflow - listing, sale,
revalidation, approval, purchase, fulfilment - can be exercised end to end
without credentials.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from app.core.clock import utcnow
from app.core.ids import deterministic_key
from app.core.money import Money
from app.matching.text import tokenize
from app.models.enums import ProductCondition
from app.providers.base import (
    ListingSnapshot,
    MarketStats,
    PublishRequest,
    PublishResult,
    SaleEvent,
    TargetMarketplaceProvider,
)
from app.providers.demo_data import DEMO_CATALOG, target_external_id


class DemoEbayProvider(TargetMarketplaceProvider):
    name = "ebay-demo"
    is_live = False

    def __init__(self, *, currency: str = "EUR", webhook_secret: str = "") -> None:
        self.currency = currency
        self.webhook_secret = webhook_secret
        self._listings: dict[str, dict[str, Any]] = {}
        self._published_keys: dict[str, str] = {}
        self._sales: list[SaleEvent] = []
        self._tracking: dict[str, dict[str, str]] = {}

    # -- internals ----------------------------------------------------------
    def _market_snapshot(self, entry: dict[str, Any]) -> ListingSnapshot:
        target = entry["target"]
        return ListingSnapshot(
            external_id=target_external_id(entry),
            title=entry["title"],
            price=Money(target["price"], self.currency),
            shipping_price=Money(target["shipping"], self.currency),
            observed_at=utcnow(),
            identifiers={"EAN": entry["ean"], "MPN": entry["mpn"]},
            brand=entry["brand"],
            model=entry["model"],
            condition=ProductCondition.NEW,
            seller_id="DEMO-MARKET",
            quantity=1,
            sold_quantity=target["sold_30d"],
            category_id=entry["category"],
            url=f"https://example.invalid/ebay/{entry['key']}",
            attributes=dict(entry["attributes"]),
            raw={"demo": True, "key": entry["key"]},
        )

    # -- TargetMarketplaceProvider -----------------------------------------
    def health(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "status": "HEALTHY",
            "live": False,
            "listings": len(self._listings),
        }

    def search_listings(self, query: str, *, limit: int = 20) -> list[ListingSnapshot]:
        terms = tokenize(query)
        results = []
        for entry in DEMO_CATALOG:
            haystack = tokenize(f"{entry['title']} {entry['brand']} {entry['model']}")
            if not terms or terms & haystack:
                results.append(self._market_snapshot(entry))
        return results[:limit]

    def find_by_identifier(self, identifier_type: str, value: str) -> list[ListingSnapshot]:
        key = identifier_type.upper()
        normalized = str(value).strip().upper()
        results = []
        for entry in DEMO_CATALOG:
            candidate = {"EAN": entry["ean"], "MPN": entry["mpn"]}.get(key)
            if candidate and candidate.upper() == normalized:
                results.append(self._market_snapshot(entry))
        return results

    def get_market_stats(
        self, *, identifier: str | None = None, query: str | None = None
    ) -> MarketStats:
        entry = None
        if identifier:
            entry = next((e for e in DEMO_CATALOG if e["ean"] == identifier), None)
        if entry is None and query:
            terms = tokenize(query)
            entry = next(
                (e for e in DEMO_CATALOG if terms & tokenize(f"{e['title']} {e['model']}")), None
            )
        if entry is None:
            return MarketStats(
                observed_at=utcnow(),
                competitor_count=0,
                seller_count=0,
                lowest_price=None,
                median_price=None,
                highest_price=None,
                realistic_sale_price=None,
            )
        target = entry["target"]
        return MarketStats(
            observed_at=utcnow(),
            competitor_count=target["competitors"],
            seller_count=target["sellers"],
            lowest_price=Money(target["lowest"], self.currency),
            median_price=Money(target["median"], self.currency),
            highest_price=Money(target["highest"], self.currency),
            realistic_sale_price=Money(target["realistic"], self.currency),
            sold_last_30d=target["sold_30d"],
            price_volatility=Decimal(target["volatility"]),
            distribution={
                "lowest": target["lowest"],
                "median": target["median"],
                "highest": target["highest"],
            },
        )

    def publish_listing(self, request: PublishRequest) -> PublishResult:
        if request.idempotency_key in self._published_keys:
            external_id = self._published_keys[request.idempotency_key]
            return PublishResult(
                success=True,
                external_id=external_id,
                url=f"https://example.invalid/ebay/listing/{external_id}",
                message="idempotent replay - listing already published",
                already_published=True,
            )
        external_id = f"EBAY-SIM-{request.idempotency_key[:10].upper()}"
        self._listings[external_id] = {
            "sku": request.sku,
            "title": request.title,
            "price": request.price,
            "shipping_price": request.shipping_price or Money.zero(self.currency),
            "quantity": request.quantity,
            "condition": request.condition,
            "identifiers": dict(request.identifiers),
            "published_at": utcnow(),
            "state": "PUBLISHED",
        }
        self._published_keys[request.idempotency_key] = external_id
        return PublishResult(
            success=True,
            external_id=external_id,
            url=f"https://example.invalid/ebay/listing/{external_id}",
            message="simulated listing published",
        )

    def update_listing(
        self, external_id: str, *, price: Money | None = None, quantity: int | None = None
    ) -> PublishResult:
        listing = self._listings.get(external_id)
        if listing is None:
            return PublishResult(False, external_id, message="unknown listing")
        if price is not None:
            listing["price"] = price
        if quantity is not None:
            listing["quantity"] = quantity
        return PublishResult(True, external_id, message="simulated listing updated")

    def end_listing(self, external_id: str, *, reason: str = "") -> PublishResult:
        listing = self._listings.get(external_id)
        if listing is None:
            return PublishResult(False, external_id, message="unknown listing")
        listing["state"] = "ENDED"
        listing["ended_reason"] = reason
        return PublishResult(True, external_id, message="simulated listing ended")

    def get_listing_status(self, external_id: str) -> ListingSnapshot | None:
        listing = self._listings.get(external_id)
        if listing is None:
            return None
        return ListingSnapshot(
            external_id=external_id,
            title=listing["title"],
            price=listing["price"],
            shipping_price=listing["shipping_price"],
            observed_at=utcnow(),
            identifiers=listing["identifiers"],
            condition=listing["condition"],
            quantity=listing["quantity"],
            raw={"state": listing["state"]},
        )

    def fetch_sales(self, *, since: datetime | None = None) -> list[SaleEvent]:
        if since is None:
            return list(self._sales)
        return [sale for sale in self._sales if sale.sold_at >= since]

    def upload_tracking(
        self, external_order_id: str, *, carrier: str, tracking_number: str, idempotency_key: str
    ) -> bool:
        existing = self._tracking.get(idempotency_key)
        if existing:
            return True
        self._tracking[idempotency_key] = {
            "order": external_order_id,
            "carrier": carrier,
            "tracking_number": tracking_number,
        }
        return True

    def verify_webhook(self, payload: bytes, signature: str | None) -> bool:
        """HMAC-SHA256 verification.

        With no configured secret the demo provider accepts unsigned payloads,
        because demo mode has no real money at stake. A live provider must
        never do this, which is why the live adapter overrides it.
        """
        if not self.webhook_secret:
            return True
        if not signature:
            return False
        expected = hmac.new(self.webhook_secret.encode(), payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    # -- demo affordances ---------------------------------------------------
    def simulate_sale(
        self,
        *,
        listing_external_id: str,
        sale_price: Money | None = None,
        quantity: int = 1,
        buyer_shipping_paid: Money | None = None,
    ) -> SaleEvent:
        """Produce a sale event for a published demo listing."""
        listing = self._listings.get(listing_external_id)
        if listing is None:
            raise KeyError(f"unknown demo listing: {listing_external_id}")
        price = sale_price or listing["price"]
        event = SaleEvent(
            external_order_id=f"EBAY-ORD-{deterministic_key(listing_external_id, quantity)[:10].upper()}",
            sku=listing["sku"],
            listing_external_id=listing_external_id,
            quantity=quantity,
            sale_price=price,
            buyer_shipping_paid=buyer_shipping_paid or Money.zero(self.currency),
            sold_at=utcnow(),
            ship_to={
                "name": "Demo Buyer",
                "street": "Musterstrasse 1",
                "postal_code": "10115",
                "city": "Berlin",
                "country": "DE",
            },
            buyer_reference="demo-buyer-001",
            delivery_deadline=utcnow() + timedelta(days=5),
            raw={"demo": True},
        )
        self._sales.append(event)
        return event
