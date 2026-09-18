"""The sell-first money path, and the guarantees that protect it."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.errors import ComplianceBlockedError, ConflictError, LimitExceededError
from app.core.money import Money
from app.listing.engine import ListingEngine
from app.models.enums import (
    CapitalReservationState,
    OpportunityState,
    OrderState,
    ProductCondition,
    ShipmentState,
)
from app.models.order import CapitalReservation, SourceOrder
from app.services.fulfillment_service import FulfillmentService
from app.services.opportunity_service import OpportunityService
from app.services.order_service import OrderService
from app.services.return_service import ReturnService
from app.services.settings_service import SettingsService


@pytest.fixture
def flow(session, config, providers, operator):
    """Everything wired, plus a published listing ready to be sold."""

    class Flow:
        def __init__(self):
            self.operator_id = operator.id
            self.session = session
            self.config = config
            self.providers = providers
            self.opportunities = OpportunityService(session, config, providers)
            self.listings = ListingEngine(session, config, providers)
            self.orders = OrderService(session, config, providers)
            self.fulfillment = FulfillmentService(session, config, providers)
            self.returns = ReturnService(session, config, providers)

        def actionable(self):
            for opportunity in self.opportunities.discover(""):
                self.opportunities.evaluate(opportunity)
                if opportunity.state is OpportunityState.ACTIONABLE:
                    return opportunity
            raise AssertionError("demo catalogue produced no actionable opportunity")

        def listed(self):
            opportunity = self.actionable()
            candidate = self.listings.create_listing_candidate(opportunity)
            listing = self.listings.publish_listing(opportunity, candidate.listing)
            return opportunity, listing

        def sold(self):
            opportunity, listing = self.listed()
            sale = self.providers.target.simulate_sale(listing_external_id=listing.external_id)
            return opportunity, listing, self.orders.ingest_sale(sale), sale

    return Flow()


def test_the_happy_path_runs_end_to_end(flow):
    opportunity, listing, order, _ = flow.sold()
    assert order.state is OrderState.SALE_RECEIVED

    outcome = flow.orders.revalidate(order)
    assert outcome.ok, outcome.problems
    assert order.state is OrderState.APPROVAL_REQUIRED

    flow.orders.approve(order, user_id=flow.operator_id, note="test approval")
    assert order.state is OrderState.APPROVED

    source_order = flow.orders.execute(order)
    assert order.state is OrderState.SOURCE_PURCHASED
    assert source_order.external_order_id

    flow.fulfillment.receive(order, received_quantity=1, package_intact=True, carrier="DHL")
    assert order.state is OrderState.INSPECTION
    inspection = flow.fulfillment.inspect(order, observed_condition=ProductCondition.NEW)
    assert inspection.result.value == "PASS"
    assert order.state is OrderState.FULFILLMENT

    flow.fulfillment.repack(order, original_package_usable=False)
    shipment = flow.fulfillment.ship(order)
    assert order.state is OrderState.SHIPPED
    assert shipment.tracking_number
    assert shipment.tracking_uploaded_at is not None

    flow.fulfillment.update_tracking(shipment, state=ShipmentState.IN_TRANSIT)
    flow.fulfillment.update_tracking(shipment, state=ShipmentState.DELIVERED)
    assert order.state is OrderState.DELIVERED

    flow.returns.finalize(order)
    assert order.state is OrderState.COMPLETED
    assert order.realized_net_profit is not None
    assert order.profit_variance == order.realized_net_profit - order.expected_net_profit


def test_a_purchase_is_impossible_without_an_approval(flow):
    _, _, order, _ = flow.sold()
    with pytest.raises(ConflictError):
        flow.orders.execute(order)
    flow.orders.revalidate(order)
    with pytest.raises(ConflictError):
        flow.orders.execute(order)  # APPROVAL_REQUIRED is still not APPROVED
    assert flow.session.query(SourceOrder).count() == 0


def test_a_duplicate_sale_webhook_creates_one_order(flow):
    _, _, order, sale = flow.sold()
    again = flow.orders.ingest_sale(sale)
    assert again.id == order.id
    from app.models.order import Order

    assert flow.session.query(Order).count() == 1


def test_a_retried_purchase_does_not_buy_twice(flow):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)
    first = flow.orders.execute(order)

    # Simulate a worker that died after purchasing but before committing the
    # state change: the order is back in APPROVED and the task runs again.
    order.state = OrderState.APPROVED
    flow.session.flush()
    second = flow.orders.execute(order)

    assert second.id == first.id
    assert flow.session.query(SourceOrder).count() == 1


def test_a_second_shipment_is_not_created_on_retry(flow):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)
    flow.orders.execute(order)
    flow.fulfillment.receive(order, received_quantity=1, package_intact=True)
    flow.fulfillment.inspect(order, observed_condition=ProductCondition.NEW)
    first = flow.fulfillment.ship(order)

    order.state = OrderState.FULFILLMENT
    flow.session.flush()
    second = flow.fulfillment.ship(order)

    from app.models.fulfillment import Shipment

    assert second.id == first.id
    assert flow.session.query(Shipment).count() == 1


def test_approval_on_stale_data_is_refused_and_sent_back(flow, session):
    from datetime import timedelta

    from app.core.clock import utcnow

    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    order.revalidated_at = utcnow() - timedelta(seconds=flow.config.max_price_age_seconds + 60)
    session.flush()

    with pytest.raises(ConflictError) as exc:
        flow.orders.approve(order, user_id=flow.operator_id)
    assert "stale" in str(exc.value)
    assert order.state is OrderState.REVALIDATION_REQUIRED


def test_capital_is_reserved_on_approval_and_released_on_completion(flow, session):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)

    reservation = session.query(CapitalReservation).filter_by(order_id=order.id).one()
    assert reservation.state is CapitalReservationState.RESERVED
    assert reservation.amount == order.capital_required

    flow.orders.execute(order)
    session.refresh(reservation)
    assert reservation.state is CapitalReservationState.COMMITTED

    flow.fulfillment.receive(order, received_quantity=1, package_intact=True)
    flow.fulfillment.inspect(order, observed_condition=ProductCondition.NEW)
    flow.fulfillment.ship(order)
    shipment = session.query(__import__("app.models.fulfillment", fromlist=["Shipment"]).Shipment).one()
    flow.fulfillment.update_tracking(shipment, state=ShipmentState.IN_TRANSIT)
    flow.fulfillment.update_tracking(shipment, state=ShipmentState.DELIVERED)
    flow.returns.finalize(order)

    session.refresh(reservation)
    assert reservation.state is CapitalReservationState.RELEASED


def test_a_capital_limit_blocks_the_approval(flow, session):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    SettingsService(session).update({"max_capital_per_order": Decimal("10.00")})
    flow.orders.config = SettingsService(session).load()
    flow.orders.capital.config = flow.orders.config

    with pytest.raises(LimitExceededError) as exc:
        flow.orders.approve(order, user_id=flow.operator_id)
    assert "MAX_CAPITAL_PER_ORDER" in str(exc.value)
    assert order.state is OrderState.APPROVAL_REQUIRED
    assert session.query(CapitalReservation).count() == 0


def test_a_price_move_above_the_approved_ceiling_fails_the_purchase(flow, session, monkeypatch):
    """The approval fixes the price we agreed to pay; the provider must refuse more."""
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)

    original = flow.providers.source.get_offer

    def pricier(external_id):
        offer = original(external_id)
        return offer.__class__(**{**offer.__dict__, "price": offer.price * Decimal("1.5")})

    monkeypatch.setattr(flow.providers.source, "get_offer", pricier)
    source_order = flow.orders.execute(order)

    assert source_order.state.value == "FAILED"
    assert "exceeds the approved ceiling" in (source_order.failure_reason or "")
    assert order.state is OrderState.REVALIDATION_REQUIRED
    # The capital must not stay tied up behind a purchase that never happened.
    assert (
        session.query(CapitalReservation).filter_by(order_id=order.id).one().state
        is CapitalReservationState.RELEASED
    )


def test_dispatch_without_a_passed_inspection_is_blocked(flow):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)
    flow.orders.execute(order)
    flow.fulfillment.receive(order, received_quantity=1, package_intact=True)
    # Jump straight to FULFILLMENT without inspecting.
    order.state = OrderState.FULFILLMENT
    flow.session.flush()
    with pytest.raises(ComplianceBlockedError):
        flow.fulfillment.ship(order)


def test_a_wrong_item_fails_inspection_and_the_order(flow):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)
    flow.orders.execute(order)
    flow.fulfillment.receive(order, received_quantity=1, package_intact=True)
    inspection = flow.fulfillment.inspect(order, observed_identifier="0000000000000")
    assert inspection.result.value == "FAIL_WRONG_ITEM"
    assert order.state is OrderState.FAILED


def test_a_return_reduces_realized_profit(flow, session):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)
    flow.orders.execute(order)
    flow.fulfillment.receive(order, received_quantity=1, package_intact=True)
    flow.fulfillment.inspect(order, observed_condition=ProductCondition.NEW)
    shipment = flow.fulfillment.ship(order)
    flow.fulfillment.update_tracking(shipment, state=ShipmentState.IN_TRANSIT)
    flow.fulfillment.update_tracking(shipment, state=ShipmentState.DELIVERED)

    record = flow.returns.request(order, reason="buyer changed their mind")
    flow.returns.transition(record, record.state.__class__.RETURN_AUTHORIZED)
    from app.models.enums import InspectionResult

    flow.returns.receive(record, inspection_result=InspectionResult.PASS)
    flow.returns.refund(record)

    assert order.state is OrderState.COMPLETED
    assert order.realized_net_profit < order.expected_net_profit
    assert order.profit_variance < 0
    assert order.realized_return_cost > Decimal("0")


def test_every_order_transition_is_recorded(flow, session):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    flow.orders.approve(order, user_id=flow.operator_id)

    from app.models.order import OrderEvent

    events = session.query(OrderEvent).filter_by(order_id=order.id).all()
    types = [e.event_type for e in events]
    assert "sale_received" in types
    assert "revalidated" in types
    assert "approval_required" in types
    assert "approved" in types
    assert all(e.occurred_at is not None for e in events)


def test_the_approval_screen_shows_every_number_the_operator_needs(flow):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    summary = flow.orders.approval_summary(order)

    assert summary["can_approve"] is True
    assert summary["sale"]["sale_price"]
    assert summary["source"]["price"]
    assert summary["source"]["availability"] == "IN_STOCK"
    assert summary["expected_net_profit"]
    assert summary["worst_case_net_profit"]
    assert summary["profit_margin"] and summary["roi"]
    assert summary["capital_required"]
    assert summary["risk_score"] is not None
    assert summary["match_confidence"]
    assert summary["compliance"] == "PASS"
    for component in (
        "source_purchase_cost",
        "marketplace_fees",
        "payment_fees",
        "packaging",
        "operator_to_customer_shipping",
        "risk_reserve",
        "fulfillment_cost",
    ):
        assert component in summary["costs"], f"{component} missing from the approval screen"
    assert summary["costs"]["fulfillment_cost"] == "0.00"


def test_worst_case_is_below_base_case_on_the_approval_screen(flow):
    _, _, order, _ = flow.sold()
    flow.orders.revalidate(order)
    assert Money(order.worst_case_net_profit) < Money(order.expected_net_profit)
