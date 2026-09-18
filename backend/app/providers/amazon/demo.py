"""Demo Amazon source provider.

Serves the demo catalogue with deterministic, slightly drifting prices so the
price-history and volatility machinery has something real to chew on.  It
never contacts Amazon and never spends money: ``purchase`` records a
simulated order and is idempotent on the supplied key.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta
from decimal import Decimal
from typing import Any

from app.core.clock import utcnow
from app.core.money import Money
from app.matching.text import tokenize
from app.models.enums import DeliverySpeed, ProductCondition, StockStatus
from app.providers.base import OfferSnapshot, PurchaseRequest, PurchaseResult, SourceProvider
from app.providers.demo_data import DEMO_CATALOG, source_external_id


def _drift(seed: str, bucket: int, spread: Decimal) -> Decimal:
    """Deterministic price drift in ``[-spread, +spread]``.

    Derived from a hash so that the same offer at the same hour always yields
    the same price - demo data must be reproducible to be useful for testing.
    """
    digest = hashlib.sha256(f"{seed}:{bucket}".encode()).digest()
    position = Decimal(digest[0]) / Decimal(255)  # 0..1
    return (position * 2 - 1) * spread


class DemoAmazonProvider(SourceProvider):
    name = "amazon-demo"
    is_live = False

    def __init__(self, *, currency: str = "EUR", drift_percent: Decimal = Decimal("1.5")) -> None:
        self.currency = currency
        self.drift_percent = drift_percent
        self._placed: dict[str, PurchaseResult] = {}

    # -- internals ----------------------------------------------------------
    def _snapshot(self, entry: dict[str, Any]) -> OfferSnapshot:
        now = utcnow()
        source = entry["source"]
        base = Decimal(source["price"])
        bucket = int(now.timestamp() // 3600)
        drifted = base * (Decimal(100) + _drift(entry["key"], bucket, self.drift_percent)) / Decimal(100)
        stock_status = StockStatus(source["stock"])
        return OfferSnapshot(
            external_id=source_external_id(entry),
            title=entry["title"],
            price=Money(drifted, self.currency) if stock_status is not StockStatus.OUT_OF_STOCK else None,
            shipping_cost=Money(source["shipping"], self.currency),
            stock_status=stock_status,
            observed_at=now,
            identifiers={
                "EAN": entry["ean"],
                "MPN": entry["mpn"],
                "ASIN": entry["asin"],
            },
            brand=entry["brand"],
            manufacturer=entry["manufacturer"],
            model=entry["model"],
            condition=ProductCondition.NEW,
            available_quantity=source["quantity"],
            stock_confidence=Decimal(source["stock_confidence"]),
            max_order_quantity=min(source["quantity"], 10) if source["quantity"] else 0,
            delivery_min_days=source["delivery_min"],
            delivery_max_days=source["delivery_max"],
            delivery_speed=DeliverySpeed(source["speed"]),
            is_fast_shipping_eligible=source["fast_eligible"],
            seller_id="A1DEMOSELLER" if not source["sold_by_marketplace"] else "AMAZON-RETAIL",
            seller_name="Demo Seller" if not source["sold_by_marketplace"] else "Amazon",
            sold_by_marketplace=source["sold_by_marketplace"],
            url=f"https://example.invalid/amazon/{entry['asin']}",
            attributes=dict(entry["attributes"]),
            raw={"demo": True, "key": entry["key"], "category": entry["category"]},
        )

    # -- SourceProvider -----------------------------------------------------
    def health(self) -> dict[str, Any]:
        return {"provider": self.name, "status": "HEALTHY", "live": False, "catalog": len(DEMO_CATALOG)}

    def search(self, query: str, *, limit: int = 20) -> list[OfferSnapshot]:
        terms = tokenize(query)
        results = []
        for entry in DEMO_CATALOG:
            haystack = tokenize(f"{entry['title']} {entry['brand']} {entry['model']} {entry['category']}")
            if not terms or terms & haystack:
                results.append(self._snapshot(entry))
        return results[:limit]

    def get_offer(self, external_id: str) -> OfferSnapshot | None:
        for entry in DEMO_CATALOG:
            if source_external_id(entry) == external_id:
                return self._snapshot(entry)
        return None

    def get_offers(self, external_ids: list[str]) -> list[OfferSnapshot]:
        wanted = set(external_ids)
        return [self._snapshot(e) for e in DEMO_CATALOG if source_external_id(e) in wanted]

    def find_by_identifier(self, identifier_type: str, value: str) -> list[OfferSnapshot]:
        key = identifier_type.upper()
        normalized = str(value).strip().upper()
        matches = []
        for entry in DEMO_CATALOG:
            candidate = {"EAN": entry["ean"], "MPN": entry["mpn"], "ASIN": entry["asin"]}.get(key)
            if candidate and candidate.upper() == normalized:
                matches.append(self._snapshot(entry))
        return matches

    def purchase(self, request: PurchaseRequest) -> PurchaseResult:
        """Simulate a purchase.

        Two protections are modelled faithfully because they are the ones that
        matter in production: the call is idempotent on the key, and the offer
        is re-checked against ``max_unit_price`` and live stock before any
        "money" moves.
        """
        if request.idempotency_key in self._placed:
            previous = self._placed[request.idempotency_key]
            return PurchaseResult(
                success=previous.success,
                external_order_id=previous.external_order_id,
                unit_price=previous.unit_price,
                shipping_cost=previous.shipping_cost,
                total_cost=previous.total_cost,
                estimated_delivery=previous.estimated_delivery,
                message="idempotent replay of an existing simulated purchase",
                already_placed=True,
                raw=previous.raw,
            )

        offer = self.get_offer(request.offer_external_id)
        if offer is None:
            return PurchaseResult(False, None, None, None, None, message="offer no longer exists")
        if offer.stock_status is StockStatus.OUT_OF_STOCK or offer.price is None:
            return PurchaseResult(False, None, None, None, None, message="offer is out of stock")
        if offer.available_quantity is not None and offer.available_quantity < request.quantity:
            return PurchaseResult(
                False, None, None, None, None, message="insufficient quantity available at source"
            )
        if offer.price > request.max_unit_price:
            return PurchaseResult(
                False,
                None,
                None,
                None,
                None,
                message=(
                    f"source price {offer.price} exceeds the approved ceiling "
                    f"{request.max_unit_price}; purchase refused"
                ),
            )

        total = offer.price * request.quantity + offer.shipping_cost
        eta_days = offer.delivery_max_days or 3
        result = PurchaseResult(
            success=True,
            external_order_id=f"AMZ-SIM-{request.idempotency_key[:12].upper()}",
            unit_price=offer.price,
            shipping_cost=offer.shipping_cost,
            total_cost=total,
            estimated_delivery=utcnow() + timedelta(days=eta_days),
            message="simulated purchase recorded; no real order was placed",
            raw={"demo": True, "offer": offer.external_id, "quantity": request.quantity},
        )
        self._placed[request.idempotency_key] = result
        return result
