"""Manual fulfilment - the v1 provider.

The operator is the warehouse.  Every operation below is a record of
something a person did, and every external fee is zero unless real money was
spent on packaging or postage.

What is deliberately absent: labour rate, handling-time cost, hourly wage,
storage allocation, opportunity cost.  The operator spending twenty minutes on
a parcel does not change the net cash profit by one cent, and the model says
so.  Operational exposure from manual handling is accounted for in the *risk*
engine, where it belongs, not as a phantom cost.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from app.core.clock import utcnow
from app.core.ids import deterministic_key
from app.core.money import Money
from app.fulfillment.base import (
    FulfillmentProvider,
    InboundShipment,
    InspectionOutcome,
    OutboundShipment,
    PackagingPlan,
    ReceiptRecord,
    ReturnOutcome,
)
from app.models.enums import FulfillmentMode, InspectionResult, ProductCondition

#: Conditions that are acceptable substitutes for one another on receipt.
_CONDITION_EQUIVALENTS = {
    ProductCondition.NEW: {ProductCondition.NEW},
    ProductCondition.NEW_OTHER: {ProductCondition.NEW, ProductCondition.NEW_OTHER},
    ProductCondition.REFURBISHED: {ProductCondition.REFURBISHED},
    ProductCondition.USED: {ProductCondition.USED, ProductCondition.REFURBISHED},
}


class ManualFulfillmentProvider(FulfillmentProvider):
    name = "manual"
    mode = FulfillmentMode.MANUAL

    def __init__(self, *, currency: str = "EUR", default_carrier: str = "DHL") -> None:
        self.currency = currency
        self.default_carrier = default_carrier
        self._shipments: dict[str, OutboundShipment] = {}

    def _zero(self) -> Money:
        return Money.zero(self.currency)

    def fee_schedule(self) -> dict[str, Money]:
        """All zero: manual handling has no external fee.

        A future 3PL provider returns real receiving/pick/pack/storage/
        outbound/return fees here and nothing else in the system changes.
        """
        return {
            "receiving_fee": self._zero(),
            "storage_fee": self._zero(),
            "pick_fee": self._zero(),
            "pack_fee": self._zero(),
            "handling_fee": self._zero(),
            "outbound_fee": self._zero(),
            "return_fee": self._zero(),
        }

    # -- inbound ------------------------------------------------------------
    def create_inbound_shipment(
        self, *, order_reference: str, quantity: int, expected_arrival=None
    ) -> InboundShipment:
        return InboundShipment(
            reference=f"IN-{order_reference}",
            expected_quantity=quantity,
            expected_arrival=expected_arrival,
            raw={"mode": "manual", "note": "source ships directly to the operator"},
        )

    def receive_shipment(
        self, *, inbound: InboundShipment, received_quantity: int, **kwargs: Any
    ) -> ReceiptRecord:
        return ReceiptRecord(
            received_at=kwargs.get("received_at") or utcnow(),
            received_quantity=received_quantity,
            package_intact=kwargs.get("package_intact"),
            carrier=kwargs.get("carrier") or inbound.carrier,
            tracking_number=kwargs.get("tracking_number") or inbound.tracking_number,
            location=kwargs.get("location", "operator"),
            notes=kwargs.get("notes", ""),
        )

    # -- inspection ---------------------------------------------------------
    def inspect_shipment(
        self, *, receipt: ReceiptRecord, expected_quantity: int
    ) -> InspectionOutcome:
        if receipt.received_quantity != expected_quantity:
            return InspectionOutcome(
                result=InspectionResult.FAIL_WRONG_QUANTITY,
                quantity_verified=False,
                observed_quantity=receipt.received_quantity,
                findings=[
                    f"received {receipt.received_quantity}, expected {expected_quantity}",
                ],
            )
        damaged = receipt.package_intact is False
        findings = ["outer package damaged on arrival"] if damaged else []
        return InspectionOutcome(
            result=InspectionResult.FAIL_DAMAGED if damaged else InspectionResult.PASS,
            quantity_verified=True,
            observed_quantity=receipt.received_quantity,
            findings=findings,
        )

    def inspect_product(
        self,
        *,
        expected_identifier: str | None,
        expected_condition: ProductCondition,
        expected_quantity: int,
        observed: dict[str, Any],
    ) -> InspectionOutcome:
        observed_identifier = observed.get("identifier")
        observed_condition = observed.get("condition") or ProductCondition.UNKNOWN
        if isinstance(observed_condition, str):
            observed_condition = ProductCondition(observed_condition)
        observed_quantity = int(observed.get("quantity", expected_quantity))
        accessories_ok = bool(observed.get("accessories_complete", True))

        sku_ok = self.verify_sku(expected=expected_identifier, observed=observed_identifier)
        quantity_ok = self.verify_quantity(expected=expected_quantity, observed=observed_quantity)
        condition_ok = self.verify_condition(expected=expected_condition, observed=observed_condition)

        findings: list[str] = []
        result = InspectionResult.PASS
        if not sku_ok:
            findings.append(f"identifier mismatch: expected {expected_identifier}, got {observed_identifier}")
            result = InspectionResult.FAIL_WRONG_ITEM
        elif not quantity_ok:
            findings.append(f"quantity mismatch: expected {expected_quantity}, got {observed_quantity}")
            result = InspectionResult.FAIL_WRONG_QUANTITY
        elif not condition_ok:
            findings.append(
                f"condition mismatch: expected {expected_condition.value}, got {observed_condition.value}"
            )
            result = InspectionResult.FAIL_CONDITION
        elif not accessories_ok:
            findings.append("accessories missing from the box")
            result = InspectionResult.FAIL_MISSING_ACCESSORIES

        return InspectionOutcome(
            result=result,
            sku_verified=sku_ok,
            quantity_verified=quantity_ok,
            condition_verified=condition_ok,
            accessories_verified=accessories_ok,
            observed_identifier=observed_identifier,
            observed_condition=observed_condition,
            observed_quantity=observed_quantity,
            findings=findings,
        )

    def verify_sku(self, *, expected: str | None, observed: str | None) -> bool:
        # Unverifiable is not the same as verified: with nothing to compare
        # against, the check cannot pass.
        if not expected or not observed:
            return False
        return "".join(ch for ch in expected if ch.isalnum()).upper() == "".join(
            ch for ch in observed if ch.isalnum()
        ).upper()

    def verify_quantity(self, *, expected: int, observed: int) -> bool:
        return expected == observed

    def verify_condition(self, *, expected: ProductCondition, observed: ProductCondition) -> bool:
        if observed is ProductCondition.UNKNOWN:
            return False
        return observed in _CONDITION_EQUIVALENTS.get(expected, {expected})

    # -- packaging ----------------------------------------------------------
    def repack(
        self, *, original_package_usable: bool, packaging_cost: Money, reason: str = ""
    ) -> PackagingPlan:
        """Prepare the parcel for dispatch.

        This is ordinary shipping preparation: a suitable box, the correct
        address and the correct return information. It does not, and must not,
        involve misrepresenting the seller, the origin or the product.
        """
        if original_package_usable:
            return PackagingPlan(
                repack_required=False,
                packaging_type="original",
                packaging_cost=self._zero(),
                reason=reason or "original packaging is suitable for dispatch",
            )
        return PackagingPlan(
            repack_required=True,
            packaging_type="own_box",
            packaging_cost=packaging_cost,
            reason=reason or "repacked into our own box for safe transit",
        )

    def prepare_outbound_shipment(
        self, *, destination: dict[str, Any], plan: PackagingPlan
    ) -> dict[str, Any]:
        missing = [
            field for field in ("name", "street", "postal_code", "city", "country")
            if not destination.get(field)
        ]
        return {
            "ready": not missing,
            "missing_fields": missing,
            "packaging_type": plan.packaging_type,
            "repacked": plan.repack_required,
        }

    def create_outbound_shipment(
        self,
        *,
        order_reference: str,
        destination: dict[str, Any],
        shipping_cost: Money,
        idempotency_key: str,
        carrier: str | None = None,
        service: str | None = None,
    ) -> OutboundShipment:
        existing = self._shipments.get(idempotency_key)
        if existing is not None:
            return OutboundShipment(
                reference=existing.reference,
                carrier=existing.carrier,
                service=existing.service,
                tracking_number=existing.tracking_number,
                shipping_cost=existing.shipping_cost,
                label_created_at=existing.label_created_at,
                estimated_delivery=existing.estimated_delivery,
                tracking_url=existing.tracking_url,
                already_created=True,
                raw=existing.raw,
            )
        now = utcnow()
        tracking = f"MAN{deterministic_key(order_reference, idempotency_key)[:12].upper()}"
        shipment = OutboundShipment(
            reference=f"OUT-{order_reference}",
            carrier=carrier or self.default_carrier,
            service=service or "standard",
            tracking_number=tracking,
            shipping_cost=shipping_cost,
            label_created_at=now,
            estimated_delivery=now + timedelta(days=2),
            tracking_url=f"https://example.invalid/track/{tracking}",
            raw={"mode": "manual", "destination_country": destination.get("country")},
        )
        self._shipments[idempotency_key] = shipment
        return shipment

    def generate_tracking(self, *, shipment: OutboundShipment) -> str | None:
        return shipment.tracking_number

    # -- returns ------------------------------------------------------------
    def process_return(
        self, *, order_reference: str, return_shipping_cost: Money, source_cost: Money, recovery_rate
    ) -> ReturnOutcome:
        recovery = source_cost * recovery_rate
        return ReturnOutcome(
            accepted=True,
            return_shipping_cost=return_shipping_cost,
            recovery_value=recovery,
            notes=f"manual return handling for {order_reference}",
        )
