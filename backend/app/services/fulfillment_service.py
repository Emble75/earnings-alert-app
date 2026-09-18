"""Fulfilment orchestration: receive -> inspect -> repack -> ship -> tracking.

The provider does the work; this service records it, enforces the order of
operations and gates dispatch on a passed inspection.  Shipments are created
under an idempotency key, so a retried worker reuses the existing label rather
than buying a second one.

Costs recorded here are cash only: packaging material and postage.  Manual
handling contributes zero, deliberately.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.compliance.rules import ComplianceContext
from app.compliance.service import ComplianceService
from app.core.clock import utcnow
from app.core.errors import ConflictError, NotFoundError
from app.core.ids import deterministic_key
from app.core.money import Money
from app.fulfillment.base import FulfillmentProvider
from app.models.enums import (
    ComplianceCheckType,
    FulfillmentState,
    InspectionResult,
    OpportunityState,
    OrderState,
    ProductCondition,
    ShipmentState,
)
from app.models.fulfillment import FulfillmentOrder, Inspection, Shipment, WarehouseReceipt
from app.models.opportunity import Opportunity
from app.models.order import Order, SourceOrder
from app.models.product import Product
from app.providers.readonly import ResearchModeError
from app.providers.registry import ProviderBundle
from app.services.audit_service import AuditService
from app.services.opportunity_service import OpportunityService
from app.services.settings_service import BusinessConfig
from app.state_machines.shipment import SHIPMENT_MACHINE


class FulfillmentService:
    def __init__(
        self, session: Session, config: BusinessConfig, providers: ProviderBundle
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency
        self.audit = AuditService(session)
        self.compliance = ComplianceService(session)

    @property
    def provider(self) -> FulfillmentProvider:
        return self.providers.fulfillment

    # -- lifecycle ----------------------------------------------------------
    def ensure_fulfillment_order(self, order: Order) -> FulfillmentOrder:
        existing = self.session.execute(
            select(FulfillmentOrder).where(FulfillmentOrder.order_id == order.id)
        ).scalars().first()
        if existing is not None:
            return existing
        fulfillment = FulfillmentOrder(
            order_id=order.id,
            provider=self.provider.name,
            mode=self.provider.mode,
            state=FulfillmentState.PENDING,
            currency=self.currency,
            fee_breakdown=[
                {"fee": name, "amount": str(amount.amount)}
                for name, amount in self.provider.fee_schedule().items()
            ],
            provider_fees=sum(
                (fee.amount for fee in self.provider.fee_schedule().values()), Decimal("0")
            ),
            started_at=utcnow(),
        )
        self.session.add(fulfillment)
        self.session.flush()
        self.audit.record(
            "fulfillment.created",
            entity_type="fulfillment_order",
            entity_id=fulfillment.id,
            new_state=FulfillmentState.PENDING.value,
            meta={"order": order.reference, "provider": self.provider.name},
        )
        return fulfillment

    def mark_source_shipped(self, order: Order, *, tracking_number: str | None = None,
                            carrier: str | None = None) -> Order:
        source_order = self._source_order(order)
        source_order.tracking_number = tracking_number or source_order.tracking_number
        source_order.carrier = carrier or source_order.carrier
        source_order.state = source_order.state.__class__.SHIPPED
        self.session.flush()
        from app.services.order_service import OrderService

        return OrderService(self.session, self.config, self.providers).transition(
            order,
            OrderState.SOURCE_SHIPPING,
            event_type="source_shipped",
            message=f"source dispatched ({carrier or 'carrier unknown'})",
        )

    def receive(
        self,
        order: Order,
        *,
        received_quantity: int,
        package_intact: bool | None = None,
        carrier: str | None = None,
        tracking_number: str | None = None,
        notes: str = "",
    ) -> WarehouseReceipt:
        """Record the parcel arriving with the operator."""
        from app.services.order_service import OrderService

        orders = OrderService(self.session, self.config, self.providers)
        if order.state is OrderState.SOURCE_PURCHASED:
            orders.transition(order, OrderState.SOURCE_SHIPPING, event_type="source_shipped")
        if order.state is not OrderState.SOURCE_SHIPPING:
            raise ConflictError(
                f"cannot receive goods for an order in state {order.state.value}",
                context={"order": order.reference},
            )

        fulfillment = self.ensure_fulfillment_order(order)
        source_order = self._source_order(order)
        inbound = self.provider.create_inbound_shipment(
            order_reference=order.reference, quantity=order.quantity
        )
        record = self.provider.receive_shipment(
            inbound=inbound,
            received_quantity=received_quantity,
            package_intact=package_intact,
            carrier=carrier or source_order.carrier,
            tracking_number=tracking_number or source_order.tracking_number,
            notes=notes,
        )
        receipt = WarehouseReceipt(
            fulfillment_order_id=fulfillment.id,
            source_order_id=source_order.id,
            received_at=record.received_at,
            received_quantity=record.received_quantity,
            expected_quantity=order.quantity,
            carrier=record.carrier,
            tracking_number=record.tracking_number,
            package_intact=record.package_intact,
            location=record.location,
            notes=record.notes,
        )
        self.session.add(receipt)
        fulfillment.state = FulfillmentState.RECEIVED
        fulfillment.original_package = package_intact
        self.session.flush()

        orders.transition(order, OrderState.SOURCE_RECEIVED, event_type="source_received")
        orders.transition(order, OrderState.INSPECTION, event_type="inspection_started")
        self.audit.record(
            "fulfillment.received",
            entity_type="fulfillment_order",
            entity_id=fulfillment.id,
            new_state=FulfillmentState.RECEIVED.value,
            meta={"received_quantity": received_quantity, "order": order.reference},
        )
        return receipt

    def inspect(
        self,
        order: Order,
        *,
        observed_identifier: str | None = None,
        observed_condition: ProductCondition = ProductCondition.NEW,
        observed_quantity: int | None = None,
        accessories_complete: bool = True,
        user_id: int | None = None,
        notes: str = "",
    ) -> Inspection:
        """Verify SKU, quantity and condition before anything ships onward."""
        if order.state is not OrderState.INSPECTION:
            raise ConflictError(
                f"order must be in INSPECTION to be inspected (it is {order.state.value})",
                context={"order": order.reference},
            )
        fulfillment = self.ensure_fulfillment_order(order)
        receipt = self.session.execute(
            select(WarehouseReceipt)
            .where(WarehouseReceipt.fulfillment_order_id == fulfillment.id)
            .order_by(WarehouseReceipt.received_at.desc())
        ).scalars().first()

        product = self.session.get(Product, order.product_id) if order.product_id else None
        expected_identifier = product.primary_identifier_value if product else None
        expected_condition = product.condition if product else ProductCondition.NEW

        outcome = self.provider.inspect_product(
            expected_identifier=expected_identifier,
            expected_condition=expected_condition,
            expected_quantity=order.quantity,
            observed={
                "identifier": observed_identifier if observed_identifier else expected_identifier,
                "condition": observed_condition,
                "quantity": observed_quantity if observed_quantity is not None else order.quantity,
                "accessories_complete": accessories_complete,
            },
        )
        inspection = Inspection(
            fulfillment_order_id=fulfillment.id,
            warehouse_receipt_id=receipt.id if receipt else None,
            inspected_at=utcnow(),
            inspected_by_user_id=user_id,
            result=outcome.result,
            sku_verified=outcome.sku_verified,
            quantity_verified=outcome.quantity_verified,
            condition_verified=outcome.condition_verified,
            accessories_verified=outcome.accessories_verified,
            expected_identifier=expected_identifier,
            observed_identifier=outcome.observed_identifier,
            observed_condition=outcome.observed_condition,
            observed_quantity=outcome.observed_quantity,
            findings=outcome.findings,
            notes=notes,
        )
        self.session.add(inspection)
        fulfillment.state = FulfillmentState.INSPECTED
        fulfillment.received_condition = outcome.observed_condition
        self.session.flush()

        from app.services.order_service import OrderService

        orders = OrderService(self.session, self.config, self.providers)
        if outcome.passed:
            orders.transition(order, OrderState.FULFILLMENT, event_type="inspection_passed")
        else:
            orders.fail(order, reason=f"inspection failed: {'; '.join(outcome.findings)}")
        self.audit.record(
            "fulfillment.inspected",
            entity_type="fulfillment_order",
            entity_id=fulfillment.id,
            meta={"result": outcome.result.value, "findings": outcome.findings},
        )
        return inspection

    def repack(
        self, order: Order, *, original_package_usable: bool, reason: str = ""
    ) -> FulfillmentOrder:
        """Prepare the parcel for dispatch (legitimate shipping preparation only)."""
        fulfillment = self.ensure_fulfillment_order(order)
        plan = self.provider.repack(
            original_package_usable=original_package_usable,
            packaging_cost=Money(self.config.packaging_cost, self.currency),
            reason=reason,
        )
        fulfillment.repack_required = plan.repack_required
        fulfillment.repacked = plan.repack_required
        fulfillment.packaging_type = plan.packaging_type
        fulfillment.packaging_cost = plan.packaging_cost.amount
        fulfillment.state = FulfillmentState.REPACKED
        self.session.flush()
        self.audit.record(
            "fulfillment.repacked",
            entity_type="fulfillment_order",
            entity_id=fulfillment.id,
            meta={"packaging_type": plan.packaging_type, "cost": str(plan.packaging_cost.amount)},
        )
        return fulfillment

    def ship(self, order: Order, *, carrier: str | None = None, service: str | None = None) -> Shipment:
        """Create the outbound shipment and upload tracking. Idempotent."""
        if self.providers.is_read_only:
            raise ResearchModeError("shipping to a buyer")
        if order.state is not OrderState.FULFILLMENT:
            raise ConflictError(
                f"order must be in FULFILLMENT to ship (it is {order.state.value})",
                context={"order": order.reference},
            )
        fulfillment = self.ensure_fulfillment_order(order)
        inspection = self.session.execute(
            select(Inspection)
            .where(Inspection.fulfillment_order_id == fulfillment.id)
            .order_by(Inspection.inspected_at.desc())
        ).scalars().first()

        self.compliance.require(
            ComplianceCheckType.FULFILLMENT,
            ComplianceContext(
                ship_to=dict(order.ship_to),
                inspection_passed=inspection is not None and inspection.result is InspectionResult.PASS,
                carrier=carrier or "DHL",
                tracking_number=None,
                research_mode=self.providers.is_read_only,
            ),
            entity_type="order",
            entity_id=order.id,
        )

        idempotency_key = deterministic_key("shipment", order.reference, "outbound")
        existing = self.session.execute(
            select(Shipment).where(Shipment.idempotency_key == idempotency_key)
        ).scalars().first()
        if existing is not None:
            self.audit.record(
                "fulfillment.shipment_replay",
                entity_type="shipment",
                entity_id=existing.id,
                meta={"order": order.reference},
            )
            return existing

        plan = self.provider.repack(
            original_package_usable=not fulfillment.repack_required,
            packaging_cost=Money(fulfillment.packaging_cost or Decimal("0"), self.currency),
        )
        readiness = self.provider.prepare_outbound_shipment(destination=dict(order.ship_to), plan=plan)
        if not readiness["ready"]:
            raise ConflictError(
                f"destination address incomplete: missing {readiness['missing_fields']}",
                context={"order": order.reference},
            )

        shipping_cost = Money(self.config.operator_to_customer_shipping_cost, self.currency)
        outbound = self.provider.create_outbound_shipment(
            order_reference=order.reference,
            destination=dict(order.ship_to),
            shipping_cost=shipping_cost,
            idempotency_key=idempotency_key,
            carrier=carrier,
            service=service,
        )
        shipment = Shipment(
            order_id=order.id,
            fulfillment_order_id=fulfillment.id,
            direction="OUTBOUND",
            state=ShipmentState.PENDING,
            carrier=outbound.carrier,
            service=outbound.service,
            tracking_number=outbound.tracking_number,
            tracking_url=outbound.tracking_url,
            destination=dict(order.ship_to),
            shipping_cost=outbound.shipping_cost.amount,
            currency=self.currency,
            idempotency_key=idempotency_key,
        )
        self.session.add(shipment)
        self.session.flush()

        self._advance_shipment(shipment, ShipmentState.LABEL_CREATED, "label created")
        fulfillment.state = FulfillmentState.OUTBOUND_CREATED
        self.session.flush()

        from app.services.order_service import OrderService

        orders = OrderService(self.session, self.config, self.providers)
        orders.transition(order, OrderState.OUTBOUND_SHIPPING, event_type="outbound_shipment_created")

        tracking = self.provider.generate_tracking(shipment=outbound)
        if tracking:
            uploaded = self.providers.target.upload_tracking(
                order.external_order_id,
                carrier=outbound.carrier,
                tracking_number=tracking,
                idempotency_key=deterministic_key("tracking", order.reference, tracking),
            )
            if uploaded:
                shipment.tracking_uploaded_at = utcnow()
                fulfillment.state = FulfillmentState.TRACKING_ENTERED
                self._advance_shipment(shipment, ShipmentState.SHIPPED, "handed to carrier")
                shipment.shipped_at = utcnow()
                shipment.estimated_delivery = outbound.estimated_delivery
                self.session.flush()
                orders.transition(order, OrderState.SHIPPED, event_type="shipped")

        opportunity = (
            self.session.get(Opportunity, order.opportunity_id) if order.opportunity_id else None
        )
        if opportunity is not None and opportunity.state is OpportunityState.FULFILLMENT_PENDING:
            OpportunityService(self.session, self.config, self.providers).transition(
                opportunity, OpportunityState.FULFILLED, reason="shipped to the buyer"
            )
        self.audit.record(
            "fulfillment.shipped",
            entity_type="shipment",
            entity_id=shipment.id,
            new_state=shipment.state.value,
            meta={"tracking_number": shipment.tracking_number, "carrier": shipment.carrier},
        )
        return shipment

    def _advance_shipment(self, shipment: Shipment, target: ShipmentState, message: str) -> Shipment:
        SHIPMENT_MACHINE.validate(shipment.state, target)
        previous = shipment.state
        shipment.state = target
        shipment.events = [
            *shipment.events,
            {"from": previous.value, "to": target.value, "at": utcnow().isoformat(), "message": message},
        ]
        if target is ShipmentState.LABEL_CREATED:
            shipment.label_created_at = utcnow()
        self.session.flush()
        return shipment

    def update_tracking(self, shipment: Shipment, *, state: ShipmentState, message: str = "") -> Shipment:
        self._advance_shipment(shipment, state, message or state.value)
        if state is ShipmentState.DELIVERED:
            shipment.actual_delivery = utcnow()
            order = self.session.get(Order, shipment.order_id)
            if order is not None and order.state is OrderState.SHIPPED:
                from app.services.order_service import OrderService

                OrderService(self.session, self.config, self.providers).transition(
                    order, OrderState.DELIVERED, event_type="delivered"
                )
        elif state is ShipmentState.EXCEPTION:
            shipment.exception_reason = message
        self.session.flush()
        self.audit.record(
            "shipment.tracking_updated",
            entity_type="shipment",
            entity_id=shipment.id,
            new_state=state.value,
            meta={"message": message},
        )
        return shipment

    def _source_order(self, order: Order) -> SourceOrder:
        source_order = self.session.execute(
            select(SourceOrder).where(SourceOrder.order_id == order.id)
        ).scalars().first()
        if source_order is None:
            raise NotFoundError(
                "no source order exists for this order", context={"order": order.reference}
            )
        return source_order
