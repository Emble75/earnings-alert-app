"""The fulfilment provider interface.

v1 is :class:`~app.fulfillment.manual.ManualFulfillmentProvider`: the operator
receives the parcel, checks it, repacks it if needed and ships it.  The
interface exists anyway so that a 3PL is a provider swap, not a rewrite of the
order engine.

Cost model note: ``fee_schedule()`` returns the *external* fees a provider
charges.  The manual provider returns zero for every operation, because the
operator's own time is not a cash cost and this system refuses to pretend
otherwise.  A 3PL will return real receiving/pick/pack/storage fees, and the
profit engine will pick them up through the same field.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.core.money import Money
from app.models.enums import FulfillmentMode, InspectionResult, ProductCondition


@dataclass(frozen=True)
class InboundShipment:
    reference: str
    expected_quantity: int
    carrier: str | None = None
    tracking_number: str | None = None
    expected_arrival: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ReceiptRecord:
    received_at: datetime
    received_quantity: int
    package_intact: bool | None = None
    carrier: str | None = None
    tracking_number: str | None = None
    location: str | None = None
    notes: str = ""


@dataclass(frozen=True)
class InspectionOutcome:
    result: InspectionResult
    sku_verified: bool = False
    quantity_verified: bool = False
    condition_verified: bool = False
    accessories_verified: bool = False
    observed_identifier: str | None = None
    observed_condition: ProductCondition | None = None
    observed_quantity: int | None = None
    findings: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.result is InspectionResult.PASS


@dataclass(frozen=True)
class PackagingPlan:
    repack_required: bool
    packaging_type: str
    packaging_cost: Money
    reason: str = ""
    weight_grams: int | None = None
    dimensions_cm: tuple[int, int, int] | None = None


@dataclass(frozen=True)
class OutboundShipment:
    reference: str
    carrier: str
    service: str
    tracking_number: str | None
    shipping_cost: Money
    label_created_at: datetime
    estimated_delivery: datetime | None = None
    tracking_url: str | None = None
    already_created: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ReturnOutcome:
    accepted: bool
    return_shipping_cost: Money
    recovery_value: Money
    inspection: InspectionOutcome | None = None
    notes: str = ""


class FulfillmentProvider(ABC):
    """Everything that happens between "we bought it" and "the buyer has it"."""

    name: str = "fulfillment"
    mode: FulfillmentMode = FulfillmentMode.MANUAL

    @abstractmethod
    def fee_schedule(self) -> dict[str, Money]:
        """External fees per operation. Manual fulfilment returns all zeros."""

    @abstractmethod
    def create_inbound_shipment(
        self, *, order_reference: str, quantity: int, expected_arrival: datetime | None = None
    ) -> InboundShipment: ...

    @abstractmethod
    def receive_shipment(
        self, *, inbound: InboundShipment, received_quantity: int, **kwargs: Any
    ) -> ReceiptRecord: ...

    @abstractmethod
    def inspect_shipment(self, *, receipt: ReceiptRecord, expected_quantity: int) -> InspectionOutcome: ...

    @abstractmethod
    def inspect_product(
        self,
        *,
        expected_identifier: str | None,
        expected_condition: ProductCondition,
        expected_quantity: int,
        observed: dict[str, Any],
    ) -> InspectionOutcome: ...

    @abstractmethod
    def verify_sku(self, *, expected: str | None, observed: str | None) -> bool: ...

    @abstractmethod
    def verify_quantity(self, *, expected: int, observed: int) -> bool: ...

    @abstractmethod
    def verify_condition(
        self, *, expected: ProductCondition, observed: ProductCondition
    ) -> bool: ...

    @abstractmethod
    def repack(
        self, *, original_package_usable: bool, packaging_cost: Money, reason: str = ""
    ) -> PackagingPlan: ...

    @abstractmethod
    def prepare_outbound_shipment(
        self, *, destination: dict[str, Any], plan: PackagingPlan
    ) -> dict[str, Any]: ...

    @abstractmethod
    def create_outbound_shipment(
        self,
        *,
        order_reference: str,
        destination: dict[str, Any],
        shipping_cost: Money,
        idempotency_key: str,
        carrier: str | None = None,
        service: str | None = None,
    ) -> OutboundShipment: ...

    @abstractmethod
    def generate_tracking(self, *, shipment: OutboundShipment) -> str | None: ...

    @abstractmethod
    def process_return(
        self, *, order_reference: str, return_shipping_cost: Money, source_cost: Money, recovery_rate
    ) -> ReturnOutcome: ...
