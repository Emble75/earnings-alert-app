"""The order engine: sale -> revalidation -> approval -> purchase.

This is where the system spends real money, so the rules are strict:

* A sale creates an order exactly once, however many times the webhook is
  delivered.
* Every order goes through a *live* revalidation before an approval screen is
  ever shown.  The numbers the operator approves are numbers fetched after the
  sale, not the ones that justified the listing.
* ``APPROVAL_REQUIRED`` is only reachable from ``REVALIDATION_REQUIRED``, and
  ``APPROVED`` only from ``APPROVAL_REQUIRED``.  The state machine makes a
  purchase-without-approval unreachable rather than merely discouraged.
* The purchase carries a hard price ceiling and an idempotency key, so a
  retry cannot buy twice and a price move cannot be paid silently.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.compliance.rules import ComplianceContext
from app.compliance.service import ComplianceService
from app.core.clock import age_seconds, utcnow
from app.core.errors import (
    ComplianceBlockedError,
    ConflictError,
    LimitExceededError,
    NotFoundError,
    ValidationError,
)
from app.core.ids import deterministic_key, reference
from app.core.money import Money
from app.models.enums import (
    ComplianceCheckType,
    DecisionOutcome,
    ExecutionMode,
    OpportunityState,
    OrderState,
    SourceOrderState,
)
from app.models.market import SourceOffer, TargetListing
from app.models.opportunity import Opportunity, ProfitCalculation
from app.models.order import CapitalReservation, Order, OrderEvent, SourceOrder
from app.models.product import Product
from app.profit.engine import ProfitBreakdown, calculate_profit, inputs_from_config
from app.profit.scenarios import ScenarioSet, build_scenarios
from app.providers.base import PurchaseRequest, SaleEvent
from app.providers.registry import ProviderBundle
from app.risk.engine import RiskAssessmentResult, risk_reserve_for
from app.services.audit_service import AuditService
from app.services.capital_service import CapitalCheck, CapitalService
from app.services.idempotency import IdempotencyService
from app.services.opportunity_service import OpportunityService
from app.services.settings_service import BusinessConfig
from app.state_machines.order import ORDER_MACHINE


@dataclass
class RevalidationOutcome:
    ok: bool
    order: Order
    scenarios: ScenarioSet | None
    risk: RiskAssessmentResult | None
    capital: CapitalCheck | None
    problems: list[str]
    checks: dict[str, str]

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "problems": self.problems,
            "checks": self.checks,
            "risk_score": self.risk.score if self.risk else None,
            "expected_net_profit": (
                str(self.scenarios.base_case.net_profit.amount) if self.scenarios else None
            ),
            "worst_case_net_profit": (
                str(self.scenarios.worst_case.net_profit.amount) if self.scenarios else None
            ),
            "capital": self.capital.to_dict() if self.capital else None,
            "revalidated_at": utcnow().isoformat(),
        }


class OrderService:
    def __init__(
        self, session: Session, config: BusinessConfig, providers: ProviderBundle
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency
        self.audit = AuditService(session)
        self.compliance = ComplianceService(session)
        self.capital = CapitalService(session, config)
        self.idempotency = IdempotencyService(session)
        self.opportunities = OpportunityService(session, config, providers)

    # -- state --------------------------------------------------------------
    def transition(
        self,
        order: Order,
        target: OrderState,
        *,
        event_type: str,
        message: str = "",
        actor: str = "system",
        actor_user_id: int | None = None,
        payload: dict | None = None,
        idempotency_key: str | None = None,
    ) -> Order:
        ORDER_MACHINE.validate(order.state, target)
        previous = order.state
        order.state = target
        # The event key is scoped to the event type: one logical action gets
        # one row, but two different actions driven by the same underlying
        # operation (dispatching a purchase and recording its confirmation)
        # are distinct events and must not collide.
        event_key = f"{event_type}:{idempotency_key}" if idempotency_key else None
        self.session.add(
            OrderEvent(
                order_id=order.id,
                event_type=event_type,
                from_state=previous,
                to_state=target,
                actor=actor,
                actor_user_id=actor_user_id,
                message=message,
                payload=payload or {},
                idempotency_key=event_key,
                occurred_at=utcnow(),
            )
        )
        self.session.flush()
        self.audit.record(
            f"order.{event_type}",
            entity_type="order",
            entity_id=order.id,
            actor=actor,
            actor_user_id=actor_user_id,
            old_state=previous.value,
            new_state=target.value,
            meta={"reference": order.reference, "message": message},
        )
        return order

    # -- sale ingestion -----------------------------------------------------
    def ingest_sale(self, event: SaleEvent) -> Order:
        """Create an order from a sale, exactly once.

        The unique constraint on ``(provider, external_order_id)`` is the real
        guarantee; the lookup below just makes a redelivery cheap and quiet.
        """
        provider = self.providers.target.name
        existing = self.session.execute(
            select(Order).where(
                Order.provider == provider, Order.external_order_id == event.external_order_id
            )
        ).scalars().first()
        if existing is not None:
            self.audit.record(
                "order.duplicate_sale_ignored",
                entity_type="order",
                entity_id=existing.id,
                meta={"external_order_id": event.external_order_id},
            )
            return existing

        listing = None
        if event.listing_external_id:
            listing = self.session.execute(
                select(TargetListing).where(
                    TargetListing.provider == provider,
                    TargetListing.external_id == event.listing_external_id,
                )
            ).scalars().first()
        if listing is None and event.sku:
            listing = self.session.execute(
                select(TargetListing).where(TargetListing.sku == event.sku)
            ).scalars().first()

        opportunity = None
        if listing is not None:
            opportunity = (
                self.session.get(Opportunity, listing.opportunity_id)
                if listing.opportunity_id
                else self.session.execute(
                    select(Opportunity).where(Opportunity.target_listing_id == listing.id)
                ).scalars().first()
            )

        order = Order(
            reference=reference("ORD"),
            opportunity_id=opportunity.id if opportunity else None,
            target_listing_id=listing.id if listing else None,
            product_id=listing.product_id if listing else None,
            provider=provider,
            external_order_id=event.external_order_id,
            state=OrderState.SALE_RECEIVED,
            execution_mode=self.providers.execution_mode,
            currency=self.currency,
            quantity=event.quantity,
            sale_price=event.sale_price.amount,
            buyer_shipping_paid=event.buyer_shipping_paid.amount,
            sold_at=event.sold_at,
            buyer_reference=event.buyer_reference,
            ship_to=dict(event.ship_to),
            buyer_delivery_deadline=event.delivery_deadline,
            raw_payload=dict(event.raw),
        )
        self.session.add(order)
        self.session.flush()
        self.session.add(
            OrderEvent(
                order_id=order.id,
                event_type="sale_received",
                to_state=OrderState.SALE_RECEIVED,
                actor=provider,
                message=f"sale of {event.quantity} at {event.sale_price}",
                payload={"external_order_id": event.external_order_id},
                idempotency_key=deterministic_key("sale", provider, event.external_order_id),
                occurred_at=utcnow(),
            )
        )
        self.session.flush()
        self.audit.record(
            "order.sale_received",
            entity_type="order",
            entity_id=order.id,
            new_state=OrderState.SALE_RECEIVED.value,
            meta={"external_order_id": event.external_order_id, "sale_price": str(event.sale_price.amount)},
        )

        if opportunity is not None and opportunity.state is OpportunityState.LISTED:
            self.opportunities.transition(
                opportunity, OpportunityState.SALE_RECEIVED, reason="sale received"
            )
        return order

    # -- revalidation -------------------------------------------------------
    def revalidate(self, order: Order) -> RevalidationOutcome:
        """Re-check everything against live data before asking for approval."""
        if order.state is OrderState.SALE_RECEIVED:
            self.transition(order, OrderState.VALIDATING, event_type="validating")
        elif order.state in (OrderState.REVALIDATION_REQUIRED, OrderState.APPROVAL_REQUIRED):
            if order.state is OrderState.APPROVAL_REQUIRED:
                self.transition(
                    order,
                    OrderState.REVALIDATION_REQUIRED,
                    event_type="revalidation_required",
                    message="approval data went stale",
                )
            self.transition(order, OrderState.VALIDATING, event_type="revalidating")
        elif order.state is not OrderState.VALIDATING:
            raise ConflictError(
                f"order in state {order.state.value} cannot be revalidated",
                context={"order": order.reference},
            )

        opportunity = self.session.get(Opportunity, order.opportunity_id) if order.opportunity_id else None
        if opportunity is None:
            problems = ["the sale cannot be linked to a known opportunity"]
            return self._block(order, problems, None, None, None, {})

        # 1. Live data ------------------------------------------------------
        self.opportunities.refresh_market_data(opportunity)
        offer = self.session.get(SourceOffer, opportunity.source_offer_id)
        product = self.session.get(Product, opportunity.product_id)
        if offer is None or offer.price is None:
            return self._block(order, ["the source offer is no longer available"], None, None, None, {})

        problems: list[str] = []
        checks: dict[str, str] = {}

        # 2. Match ----------------------------------------------------------
        match = self.opportunities.match_offer_to_listing(
            offer, self.session.get(TargetListing, opportunity.target_listing_id)
        )
        checks["product_match"] = f"{match.status.value} at {match.confidence}"
        if match.confidence < self.config.minimum_match_confidence or not match.is_match:
            problems.append(
                f"product match is {match.status.value} at {match.confidence} "
                f"(needs {self.config.minimum_match_confidence})"
            )

        # 3. Freshness ------------------------------------------------------
        stale = self.opportunities.staleness(opportunity)
        checks["data_freshness"] = "fresh" if not stale else "; ".join(stale)
        problems.extend(stale)

        # 4. Availability and delivery --------------------------------------
        checks["source_availability"] = offer.stock_status.value
        checks["source_delivery_estimate"] = (
            f"{offer.delivery_min_days}-{offer.delivery_max_days} days"
            if offer.delivery_max_days is not None
            else "unknown"
        )

        # 5. Economics against the *actual* sale price ----------------------
        sale_price = Money(order.sale_price, self.currency)
        source_price = Money(offer.price, self.currency)
        inputs = inputs_from_config(
            self.config,
            sale_price=sale_price,
            source_unit_price=source_price,
            quantity=order.quantity,
            buyer_shipping_paid=Money(order.buyer_shipping_paid, self.currency),
            source_shipping_cost=Money(offer.shipping_cost or Decimal("0"), self.currency),
        )
        listing = self.session.get(TargetListing, opportunity.target_listing_id)
        competition = self.opportunities.market.latest_competition(opportunity.product_id)
        base_for_risk = calculate_profit(inputs)
        risk = self.opportunities.assess_risk_for(
            opportunity, offer, listing, match, base_for_risk, competition
        )
        inputs = replace(
            inputs,
            risk_reserve_override=risk_reserve_for(risk, sale_price, self.config.risk_reserve_percent),
        )
        scenarios = build_scenarios(inputs, self.config)
        base = scenarios.base_case

        checks["expected_net_profit"] = str(base.net_profit.amount)
        checks["worst_case_net_profit"] = str(scenarios.worst_case.net_profit.amount)
        minimum_profit = Money(self.config.minimum_net_profit, self.currency)
        if base.net_profit < minimum_profit:
            problems.append(
                f"expected net profit {base.net_profit} is now below the minimum {minimum_profit}"
            )
        if base.profit_margin is None or base.profit_margin < self.config.minimum_profit_margin:
            problems.append(
                f"margin {base.profit_margin} is now below the minimum "
                f"{self.config.minimum_profit_margin}"
            )

        checks["risk_score"] = str(risk.score)
        if risk.is_blocking:
            problems.extend(risk.blockers)
        elif risk.score > self.config.maximum_risk_score:
            problems.append(
                f"risk score {risk.score} exceeds the maximum {self.config.maximum_risk_score}"
            )

        # 6. Capital --------------------------------------------------------
        capital_check = self.capital.check(
            base.capital_required, product_id=order.product_id, quantity=order.quantity
        )
        checks["capital_required"] = str(base.capital_required.amount)
        if not capital_check.allowed:
            problems.extend(capital_check.violations)

        # 7. Compliance -----------------------------------------------------
        compliance = self.compliance.check(
            ComplianceCheckType.ORDER,
            ComplianceContext(
                source_stock_status=offer.stock_status,
                source_available_quantity=offer.available_quantity,
                required_quantity=order.quantity,
                source_delivery_max_days=offer.delivery_max_days,
                buyer_delivery_expectation_days=self.config.target_delivery_expectation_days,
                match_is_verified=match.is_match
                and match.confidence >= self.config.minimum_match_confidence,
                automation_level=self.config.automation_level,
                identifiers=(
                    {i.identifier_type.value: i.value for i in product.identifiers} if product else {}
                ),
            ),
            entity_type="order",
            entity_id=order.id,
        )
        checks["compliance"] = compliance.outcome.value
        if compliance.is_blocking:
            problems.append(compliance.blocked_reason() or "compliance blocked this order")

        # -- record ---------------------------------------------------------
        order.expected_net_profit = base.net_profit.amount
        order.worst_case_net_profit = scenarios.worst_case.net_profit.amount
        order.expected_margin = base.profit_margin
        order.expected_roi = base.roi
        order.capital_required = base.capital_required.amount
        order.approved_source_unit_price = source_price.amount
        order.risk_score = risk.score
        order.match_confidence = match.confidence
        order.revalidated_at = utcnow()
        self._store_calculations(order, scenarios)

        outcome = RevalidationOutcome(
            ok=not problems,
            order=order,
            scenarios=scenarios,
            risk=risk,
            capital=capital_check,
            problems=problems,
            checks=checks,
        )
        order.revalidation_result = outcome.to_dict()
        self.session.flush()

        if problems:
            return self._block(order, problems, scenarios, risk, capital_check, checks)

        self.transition(
            order,
            OrderState.REVALIDATION_REQUIRED,
            event_type="revalidated",
            message="live revalidation passed",
            payload={"checks": checks},
        )
        self.transition(
            order,
            OrderState.APPROVAL_REQUIRED,
            event_type="approval_required",
            message="awaiting operator approval of the source purchase",
        )
        order.approval_required_at = utcnow()
        if opportunity.state in (OpportunityState.SALE_RECEIVED, OpportunityState.REVALIDATION_REQUIRED):
            if opportunity.state is OpportunityState.SALE_RECEIVED:
                self.opportunities.transition(
                    opportunity, OpportunityState.REVALIDATION_REQUIRED, reason="post-sale revalidation"
                )
            self.opportunities.transition(
                opportunity, OpportunityState.APPROVAL_REQUIRED, reason="revalidation passed"
            )
        self.session.flush()
        return outcome

    def _block(
        self,
        order: Order,
        problems: list[str],
        scenarios: ScenarioSet | None,
        risk: RiskAssessmentResult | None,
        capital: CapitalCheck | None,
        checks: dict[str, str],
    ) -> RevalidationOutcome:
        order.blocked_reason = "; ".join(problems)
        outcome = RevalidationOutcome(
            ok=False,
            order=order,
            scenarios=scenarios,
            risk=risk,
            capital=capital,
            problems=problems,
            checks=checks,
        )
        order.revalidation_result = outcome.to_dict()
        self.transition(
            order,
            OrderState.BLOCKED,
            event_type="blocked",
            message="; ".join(problems)[:500],
            payload={"problems": problems},
        )
        return outcome

    def _store_calculations(self, order: Order, scenarios: ScenarioSet) -> None:
        from app.models.enums import ScenarioType

        now = utcnow()
        for scenario_type, breakdown in (
            (ScenarioType.BEST_CASE, scenarios.best_case),
            (ScenarioType.BASE_CASE, scenarios.base_case),
            (ScenarioType.WORST_CASE, scenarios.worst_case),
        ):
            self.session.add(
                ProfitCalculation(
                    order_id=order.id,
                    opportunity_id=order.opportunity_id,
                    scenario=scenario_type,
                    currency=breakdown.currency,
                    quantity=breakdown.quantity,
                    sale_revenue=breakdown.sale_revenue.amount,
                    buyer_shipping_paid=breakdown.buyer_shipping_paid.amount,
                    source_purchase_cost=breakdown.source_purchase_cost.amount,
                    source_shipping_cost=breakdown.source_shipping_cost.amount,
                    marketplace_fees=breakdown.marketplace_fees.amount,
                    payment_fees=breakdown.payment_fees.amount,
                    fulfillment_cost=breakdown.fulfillment_cost.amount,
                    outbound_shipping_cost=breakdown.outbound_shipping_cost.amount,
                    packaging_cost=breakdown.packaging_cost.amount,
                    expected_return_cost=breakdown.expected_return_cost.amount,
                    risk_reserve=breakdown.risk_reserve.amount,
                    other_variable_costs=breakdown.other_variable_costs.amount,
                    total_costs=breakdown.total_costs.amount,
                    net_profit=breakdown.net_profit.amount,
                    profit_margin=breakdown.profit_margin,
                    roi=breakdown.roi,
                    capital_required=breakdown.capital_required.amount,
                    inputs=breakdown.to_dict(),
                    fee_breakdown=breakdown.fee_lines,
                    assumptions=breakdown.assumptions,
                    profit_model_version=breakdown.profit_model_version,
                    fee_model_version=breakdown.fee_model_version,
                    calculated_at=now,
                )
            )
        self.session.flush()

    # -- approval -----------------------------------------------------------
    def approval_summary(self, order: Order) -> dict:
        """Everything the one-click approval screen needs, and nothing implicit."""
        base = self._latest_calculation(order)
        worst = self._latest_calculation(order, scenario="WORST_CASE")
        offer = None
        opportunity = self.session.get(Opportunity, order.opportunity_id) if order.opportunity_id else None
        if opportunity is not None:
            offer = self.session.get(SourceOffer, opportunity.source_offer_id)

        return {
            "order_reference": order.reference,
            "state": order.state.value,
            "execution_mode": order.execution_mode.value,
            "currency": order.currency,
            "quantity": order.quantity,
            "sale": {
                "sale_price": str(order.sale_price),
                "buyer_shipping_paid": str(order.buyer_shipping_paid),
                "sold_at": order.sold_at.isoformat() if order.sold_at else None,
                "delivery_deadline": (
                    order.buyer_delivery_deadline.isoformat() if order.buyer_delivery_deadline else None
                ),
            },
            "source": {
                "price": str(offer.price) if offer and offer.price is not None else None,
                "shipping": str(offer.shipping_cost) if offer else None,
                "availability": offer.stock_status.value if offer else "UNKNOWN",
                "available_quantity": offer.available_quantity if offer else None,
                "delivery_estimate_days": (
                    [offer.delivery_min_days, offer.delivery_max_days] if offer else None
                ),
                "seller": offer.seller_name if offer else None,
            },
            "costs": base["costs"] if base else {},
            "expected_net_profit": str(order.expected_net_profit) if order.expected_net_profit else None,
            "worst_case_net_profit": (
                str(order.worst_case_net_profit) if order.worst_case_net_profit else None
            ),
            "profit_margin": str(order.expected_margin) if order.expected_margin else None,
            "roi": str(order.expected_roi) if order.expected_roi else None,
            "capital_required": str(order.capital_required) if order.capital_required else None,
            "risk_score": order.risk_score,
            "match_confidence": str(order.match_confidence) if order.match_confidence else None,
            "revalidation": order.revalidation_result,
            "worst_case_breakdown": worst,
            "compliance": order.revalidation_result.get("checks", {}).get("compliance"),
            "can_approve": order.state is OrderState.APPROVAL_REQUIRED,
        }

    def _latest_calculation(self, order: Order, *, scenario: str = "BASE_CASE") -> dict | None:
        stmt = (
            select(ProfitCalculation)
            .where(ProfitCalculation.order_id == order.id, ProfitCalculation.scenario == scenario)
            .order_by(ProfitCalculation.calculated_at.desc())
            .limit(1)
        )
        row = self.session.execute(stmt).scalars().first()
        return row.inputs if row is not None else None

    def approve(self, order: Order, *, user_id: int | None, note: str = "") -> Order:
        """The single approval. Reserves capital, then unlocks execution."""
        if order.state is not OrderState.APPROVAL_REQUIRED:
            raise ConflictError(
                f"order must be in APPROVAL_REQUIRED to be approved (it is {order.state.value})",
                context={"order": order.reference},
            )
        # Approving on stale numbers defeats the point of revalidating.
        # age_seconds() normalises naive timestamps: not every database
        # returns timezone-aware values for a timestamptz column.
        age = age_seconds(order.revalidated_at)
        if age is None or age > self.config.max_price_age_seconds:
            self.transition(
                order,
                OrderState.REVALIDATION_REQUIRED,
                event_type="revalidation_required",
                message="approval attempted on stale data",
            )
            raise ConflictError(
                "the approval data is stale; the order has been sent back for revalidation",
                context={"order": order.reference, "age_seconds": age},
            )
        if order.capital_required is None:
            raise ValidationError("order has no capital requirement; revalidate first")

        reservation = self.capital.reserve(
            Money(order.capital_required, self.currency),
            order_id=order.id,
            opportunity_id=order.opportunity_id,
            product_id=order.product_id,
            quantity=order.quantity,
            is_simulated=order.execution_mode is not ExecutionMode.LIVE,
        )
        order.approved_at = utcnow()
        order.approved_by_user_id = user_id
        order.approval_note = note
        self.transition(
            order,
            OrderState.APPROVED,
            event_type="approved",
            message=note or "source purchase approved",
            actor=f"user:{user_id}" if user_id else "operator",
            actor_user_id=user_id,
            payload={"capital_reservation_id": reservation.id},
        )
        opportunity = self.session.get(Opportunity, order.opportunity_id) if order.opportunity_id else None
        if opportunity is not None and opportunity.state is OpportunityState.APPROVAL_REQUIRED:
            self.opportunities.transition(
                opportunity,
                OpportunityState.APPROVED,
                reason="operator approved the source purchase",
                actor=f"user:{user_id}" if user_id else "operator",
                actor_user_id=user_id,
            )
        return order

    # -- execution ----------------------------------------------------------
    def execute(self, order: Order) -> SourceOrder:
        """Buy from the source. Idempotent, price-capped, compliance-gated."""
        if order.state is not OrderState.APPROVED:
            raise ConflictError(
                f"order must be APPROVED before execution (it is {order.state.value})",
                context={"order": order.reference},
            )
        opportunity = self.session.get(Opportunity, order.opportunity_id) if order.opportunity_id else None
        if opportunity is None:
            raise NotFoundError("order has no opportunity to source from")
        offer = self.session.get(SourceOffer, opportunity.source_offer_id)
        if offer is None or offer.price is None:
            raise ConflictError("the source offer is no longer purchasable")

        idempotency_key = deterministic_key(
            "purchase", order.reference, offer.external_id, order.quantity
        )
        existing = self.session.execute(
            select(SourceOrder).where(SourceOrder.idempotency_key == idempotency_key)
        ).scalars().first()
        if existing is not None:
            self.audit.record(
                "order.purchase_replay",
                entity_type="source_order",
                entity_id=existing.id,
                meta={"order": order.reference},
            )
            return existing

        # A final compliance gate immediately before money moves.
        self.compliance.require(
            ComplianceCheckType.ORDER,
            ComplianceContext(
                source_stock_status=offer.stock_status,
                source_available_quantity=offer.available_quantity,
                required_quantity=order.quantity,
                source_delivery_max_days=offer.delivery_max_days,
                buyer_delivery_expectation_days=self.config.target_delivery_expectation_days,
                match_is_verified=(
                    order.match_confidence is not None
                    and order.match_confidence >= self.config.minimum_match_confidence
                ),
                automation_level=self.config.automation_level,
            ),
            entity_type="order",
            entity_id=order.id,
        )

        # The ceiling is the price the approval was based on, not the price we
        # happen to see now. If the source moved above it, the provider refuses
        # and the order goes back for revalidation rather than quietly costing
        # more than the operator agreed to.
        if order.approved_source_unit_price is None:
            raise ValidationError("order has no approved source price; revalidate first")
        approved_unit_price = Money(order.approved_source_unit_price, self.currency)
        ceiling = approved_unit_price
        source_order = SourceOrder(
            order_id=order.id,
            source_offer_id=offer.id,
            provider=self.providers.source.name,
            state=SourceOrderState.PENDING,
            execution_mode=order.execution_mode,
            currency=self.currency,
            quantity=order.quantity,
            unit_price=approved_unit_price.amount,
            idempotency_key=idempotency_key,
        )
        self.session.add(source_order)
        self.session.flush()

        self.transition(
            order,
            OrderState.SOURCE_PURCHASE_PENDING,
            event_type="source_purchase_dispatched",
            message=f"purchasing {order.quantity} at up to {ceiling}",
            idempotency_key=idempotency_key,
        )

        result = self.providers.source.purchase(
            PurchaseRequest(
                offer_external_id=offer.external_id,
                quantity=order.quantity,
                max_unit_price=ceiling,
                idempotency_key=idempotency_key,
                ship_to=dict(order.ship_to),
                reference=order.reference,
            )
        )
        if not result.success:
            source_order.state = SourceOrderState.FAILED
            source_order.failure_reason = result.message
            self.session.flush()
            self.capital.release_for_order(order.id, note="source purchase failed")
            self.transition(
                order,
                OrderState.REVALIDATION_REQUIRED,
                event_type="purchase_failed",
                message=result.message,
                payload={"reason": result.message},
            )
            return source_order

        source_order.state = SourceOrderState.PLACED
        source_order.external_order_id = result.external_order_id
        source_order.unit_price = result.unit_price.amount if result.unit_price else source_order.unit_price
        source_order.shipping_cost = result.shipping_cost.amount if result.shipping_cost else None
        source_order.total_cost = result.total_cost.amount if result.total_cost else None
        source_order.estimated_delivery = result.estimated_delivery
        source_order.placed_at = utcnow()
        source_order.raw_payload = dict(result.raw)
        self.session.flush()

        for res in self.session.execute(
            select(CapitalReservation).where(CapitalReservation.order_id == order.id)
        ).scalars():
            self.capital.commit(res)

        self.transition(
            order,
            OrderState.SOURCE_PURCHASED,
            event_type="source_purchased",
            message=f"source order {result.external_order_id}",
            payload={"external_order_id": result.external_order_id, "replayed": result.already_placed},
            idempotency_key=idempotency_key,
        )
        if opportunity.state is OpportunityState.APPROVED:
            self.opportunities.transition(
                opportunity, OpportunityState.EXECUTING, reason="source purchase started"
            )
        if opportunity.state is OpportunityState.EXECUTING:
            self.opportunities.transition(
                opportunity, OpportunityState.FULFILLMENT_PENDING, reason="source purchased"
            )
        return source_order

    # -- lifecycle helpers --------------------------------------------------
    def cancel(self, order: Order, *, reason: str, user_id: int | None = None) -> Order:
        order.cancellation_reason = reason
        self.capital.release_for_order(order.id, note=f"order cancelled: {reason}")
        return self.transition(
            order,
            OrderState.CANCELLED,
            event_type="cancelled",
            message=reason,
            actor=f"user:{user_id}" if user_id else "operator",
            actor_user_id=user_id,
        )

    def fail(self, order: Order, *, reason: str) -> Order:
        order.failure_reason = reason
        self.capital.release_for_order(order.id, note=f"order failed: {reason}")
        return self.transition(order, OrderState.FAILED, event_type="failed", message=reason)

    def unblock(self, order: Order, *, reason: str = "operator cleared the block") -> Order:
        return self.transition(
            order, OrderState.REVALIDATION_REQUIRED, event_type="unblocked", message=reason
        )


__all__ = [
    "ComplianceBlockedError",
    "LimitExceededError",
    "OrderService",
    "ProfitBreakdown",
    "RevalidationOutcome",
    "DecisionOutcome",
]
