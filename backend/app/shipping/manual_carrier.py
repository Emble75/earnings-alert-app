"""Shipping provider used by manual fulfilment.

Quotes come from the operator's configured flat rate rather than a live
carrier API.  That is honest for v1: the operator buys labels in their own
carrier portal, and the configured rate is what they actually pay.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from app.core.clock import utcnow
from app.core.ids import deterministic_key
from app.core.money import Money
from app.models.enums import ShipmentState
from app.providers.base import ShippingProvider, TrackingUpdate


class ManualShippingProvider(ShippingProvider):
    name = "manual-carrier"

    def __init__(
        self,
        *,
        currency: str = "EUR",
        flat_rate: Decimal | str = "5.99",
        carrier: str = "DHL",
        heavy_parcel_grams: int = 5000,
        heavy_surcharge: Decimal | str = "4.00",
    ) -> None:
        self.currency = currency
        self.flat_rate = Money(flat_rate, currency)
        self.carrier = carrier
        self.heavy_parcel_grams = heavy_parcel_grams
        self.heavy_surcharge = Money(heavy_surcharge, currency)
        self._labels: dict[str, dict[str, Any]] = {}

    def quote(self, *, weight_grams: int, destination: dict[str, Any]) -> Money:
        quote = self.flat_rate
        if weight_grams > self.heavy_parcel_grams:
            quote = quote + self.heavy_surcharge
        return quote

    def create_label(
        self, *, order_reference: str, destination: dict[str, Any], idempotency_key: str
    ) -> dict[str, Any]:
        if idempotency_key in self._labels:
            return {**self._labels[idempotency_key], "already_created": True}
        suffix = deterministic_key(order_reference, idempotency_key)[:12].upper()
        tracking = f"{self.carrier[:3].upper()}{suffix}"
        label = {
            "carrier": self.carrier,
            "service": "standard",
            "tracking_number": tracking,
            "tracking_url": f"https://example.invalid/track/{tracking}",
            "created_at": utcnow().isoformat(),
            "estimated_delivery": (utcnow() + timedelta(days=2)).isoformat(),
            "already_created": False,
        }
        self._labels[idempotency_key] = label
        return label

    def track(self, tracking_number: str, *, carrier: str) -> TrackingUpdate | None:
        return TrackingUpdate(
            tracking_number=tracking_number,
            carrier=carrier,
            status=ShipmentState.IN_TRANSIT.value,
            observed_at=utcnow(),
            estimated_delivery=utcnow() + timedelta(days=1),
            events=[{"status": "IN_TRANSIT", "at": utcnow().isoformat()}],
        )
