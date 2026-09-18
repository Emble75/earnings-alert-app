"""Returns and realized profit.

Expected profit is a forecast.  Realized profit is what actually landed, and
the variance between them is the most honest performance signal the system
produces - so both are computed from stored facts, never adjusted to look
better.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import ConflictError, NotFoundError
from app.core.money import Money
from app.models.enums import (
    InspectionResult,
    NotificationEvent,
    OrderState,
    ReturnState,
    ScenarioType,
)
from app.models.fulfillment import Return, Shipment
from app.models.opportunity import Opportunity, ProfitCalculation
from app.models.order import Order, SourceOrder
from app.providers.registry import ProviderBundle
from app.services.audit_service import AuditService
from app.services.capital_service import CapitalService
from app.services.settings_service import BusinessConfig
from app.state_machines.shipment import RETURN_MACHINE


class ReturnService:
    def __init__(
        self, session: Session, config: BusinessConfig, providers: ProviderBundle
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency
        self.audit = AuditService(session)

    # -- lifecycle ----------------------------------------------------------
    def request(
        self,
        order: Order,
        *,
        reason: str,
        external_return_id: str | None = None,
        buyer_comment: str = "",
    ) -> Return:
        existing = self.session.execute(
            select(Return).where(
                Return.order_id == order.id,
                Return.state.not_in([ReturnState.CLOSED.value]),
            )
        ).scalars().first()
        if existing is not None:
            return existing

        record = Return(
            order_id=order.id,
            provider=self.providers.target.name,
            external_return_id=external_return_id,
            state=ReturnState.RETURN_REQUESTED,
            reason=reason,
            buyer_comment=buyer_comment,
            currency=self.currency,
            requested_at=utcnow(),
        )
        self.session.add(record)
        self.session.flush()

        from app.services.order_service import OrderService

        orders = OrderService(self.session, self.config, self.providers)
        if order.state in (OrderState.SHIPPED, OrderState.DELIVERED):
            orders.transition(
                order, OrderState.RETURN_REQUESTED, event_type="return_requested", message=reason
            )
        self.audit.record(
            "return.requested",
            entity_type="return",
            entity_id=record.id,
            new_state=ReturnState.RETURN_REQUESTED.value,
            meta={"order": order.reference, "reason": reason},
        )
        return record

    def transition(self, record: Return, target: ReturnState, *, message: str = "") -> Return:
        RETURN_MACHINE.validate(record.state, target)
        previous = record.state
        record.state = target
        now = utcnow()
        if target is ReturnState.RETURN_AUTHORIZED:
            record.authorized_at = now
        elif target is ReturnState.RETURN_RECEIVED:
            record.received_at = now
        elif target is ReturnState.REFUNDED:
            record.refunded_at = now
        elif target is ReturnState.CLOSED:
            record.closed_at = now
        self.session.flush()
        self.audit.record(
            "return.transition",
            entity_type="return",
            entity_id=record.id,
            old_state=previous.value,
            new_state=target.value,
            meta={"message": message},
        )
        return record

    def receive(self, record: Return, *, inspection_result: InspectionResult) -> Return:
        if record.state is ReturnState.RETURN_AUTHORIZED:
            self.transition(record, ReturnState.RETURN_IN_TRANSIT, message="buyer shipped it back")
        self.transition(record, ReturnState.RETURN_RECEIVED, message="received by the operator")
        record.inspection_result = inspection_result
        self.transition(record, ReturnState.INSPECTION_REQUIRED)
        self.session.flush()
        return record

    def refund(self, record: Return, *, refund_amount: Money | None = None) -> Return:
        """Settle the return and book its real cost against the order."""
        order = self.session.get(Order, record.order_id)
        if order is None:
            raise NotFoundError("return has no order")
        if record.state is ReturnState.INSPECTION_REQUIRED:
            self.transition(record, ReturnState.REFUND_REQUIRED)
        if record.state is not ReturnState.REFUND_REQUIRED:
            raise ConflictError(
                f"return must be in REFUND_REQUIRED to refund (it is {record.state.value})"
            )

        source_order = self.session.execute(
            select(SourceOrder).where(SourceOrder.order_id == order.id)
        ).scalars().first()
        source_cost = Money(
            (source_order.total_cost if source_order and source_order.total_cost else Decimal("0")),
            self.currency,
        )
        outcome = self.providers.fulfillment.process_return(
            order_reference=order.reference,
            return_shipping_cost=Money(self.config.return_shipping_cost, self.currency),
            source_cost=source_cost,
            recovery_rate=self.config.return_value_recovery_rate,
        )

        refund = refund_amount or Money(order.sale_price, self.currency) + Money(
            order.buyer_shipping_paid, self.currency
        )
        record.refund_amount = refund.amount
        record.return_shipping_cost = outcome.return_shipping_cost.amount
        record.restocking_recovery = outcome.recovery_value.amount
        # Fees the marketplace gives back on a refund reduce the damage; what
        # it keeps does not, so it stays in the total below.
        record.total_return_cost = (
            outcome.return_shipping_cost.amount
            + source_cost.amount
            - outcome.recovery_value.amount
        )
        self.transition(record, ReturnState.REFUNDED, message=f"refunded {refund}")
        self.transition(record, ReturnState.CLOSED, message="return closed")

        from app.services.order_service import OrderService

        orders = OrderService(self.session, self.config, self.providers)
        if order.state is OrderState.RETURN_REQUESTED:
            orders.transition(order, OrderState.RETURNED, event_type="returned")
        self.finalize(order)
        return record

    # -- realized profit ----------------------------------------------------
    def finalize(self, order: Order) -> Order:
        """Compute realized profit from what actually happened."""
        source_order = self.session.execute(
            select(SourceOrder).where(SourceOrder.order_id == order.id)
        ).scalars().first()
        shipments = list(
            self.session.execute(select(Shipment).where(Shipment.order_id == order.id)).scalars()
        )
        returns = list(
            self.session.execute(select(Return).where(Return.order_id == order.id)).scalars()
        )
        base = self.session.execute(
            select(ProfitCalculation)
            .where(
                ProfitCalculation.order_id == order.id,
                ProfitCalculation.scenario == ScenarioType.BASE_CASE.value,
            )
            .order_by(ProfitCalculation.calculated_at.desc())
            .limit(1)
        ).scalars().first()

        zero = Money.zero(self.currency)
        returned = any(r.state is ReturnState.CLOSED and r.refund_amount > 0 for r in returns)

        revenue = (
            zero
            if returned
            else Money(order.sale_price, self.currency) + Money(order.buyer_shipping_paid, self.currency)
        )
        source_cost = Money(
            (source_order.total_cost if source_order and source_order.total_cost else Decimal("0")),
            self.currency,
        )
        # A return that came back to us recovers part of the goods value.
        recovery = sum((r.restocking_recovery for r in returns), Decimal("0"))
        realized_source_cost = Money(max(source_cost.amount - recovery, Decimal("0")), self.currency)

        # Marketplace fees: refunded orders usually return the variable part.
        fees = Money(base.marketplace_fees + base.payment_fees, self.currency) if base else zero
        if returned and base is not None:
            fees = zero

        shipping = Money(
            sum((s.shipping_cost for s in shipments), Decimal("0")), self.currency
        )
        packaging = Money(base.packaging_cost if base else Decimal("0"), self.currency)
        return_cost = Money(
            sum((r.return_shipping_cost for r in returns), Decimal("0")), self.currency
        )
        other = Money(base.other_variable_costs if base else Decimal("0"), self.currency)

        net = revenue - realized_source_cost - fees - shipping - packaging - return_cost - other

        order.realized_revenue = revenue.amount
        order.realized_source_cost = realized_source_cost.amount
        order.realized_fees = fees.amount
        order.realized_shipping = shipping.amount
        order.realized_packaging = packaging.amount
        order.realized_return_cost = return_cost.amount
        order.realized_other_costs = other.amount
        order.realized_net_profit = net.amount
        if order.expected_net_profit is not None:
            order.profit_variance = net.amount - order.expected_net_profit
        order.completed_at = utcnow()

        CapitalService(self.session, self.config).release_for_order(
            order.id, note="order settled"
        )

        from app.services.order_service import OrderService

        orders = OrderService(self.session, self.config, self.providers)
        if order.state in (OrderState.DELIVERED, OrderState.RETURNED, OrderState.RETURN_REQUESTED):
            orders.transition(
                order,
                OrderState.COMPLETED,
                event_type="completed",
                message=f"realized net profit {net}",
                payload={
                    "realized_net_profit": str(net.amount),
                    "expected_net_profit": str(order.expected_net_profit or ""),
                    "variance": str(order.profit_variance or ""),
                },
            )
        opportunity = (
            self.session.get(Opportunity, order.opportunity_id) if order.opportunity_id else None
        )
        if opportunity is not None and opportunity.state.value == "FULFILLED":
            from app.models.enums import OpportunityState
            from app.services.opportunity_service import OpportunityService

            OpportunityService(self.session, self.config, self.providers).transition(
                opportunity, OpportunityState.COMPLETED, reason="order settled"
            )
        self.session.flush()
        self.audit.record(
            "order.realized_profit",
            entity_type="order",
            entity_id=order.id,
            meta={
                "realized_net_profit": str(net.amount),
                "expected_net_profit": str(order.expected_net_profit or ""),
                "variance": str(order.profit_variance or ""),
                "notification": NotificationEvent.PROFIT_REALIZED.value,
            },
        )
        return order
