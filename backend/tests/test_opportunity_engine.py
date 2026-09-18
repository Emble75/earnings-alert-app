"""Opportunity filters. Each test names a rule from the specification."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest

from app.core.clock import utcnow
from app.core.ids import reference
from app.models.enums import (
    DeliverySpeed,
    IdentifierType,
    OpportunityState,
    ProductCondition,
    StockStatus,
)
from app.models.market import SourceOffer, TargetListing
from app.models.opportunity import Opportunity
from app.models.product import Product, ProductIdentifier
from app.services.opportunity_service import OpportunityService

EAN = "4548736134584"


@pytest.fixture
def scenario(session, config, providers):
    """A healthy, clearly profitable opportunity we can then damage."""

    def _build(**overrides):
        now = utcnow()
        product = Product(
            title="Sony WH-1000XM5",
            brand="Sony",
            model="WH-1000XM5",
            condition=ProductCondition.NEW,
            attributes={"color": "black"},
            primary_identifier_type=IdentifierType.EAN,
            primary_identifier_value=EAN,
        )
        session.add(product)
        session.flush()
        session.add(
            ProductIdentifier(
                product_id=product.id, identifier_type=IdentifierType.EAN, value=EAN, source="test"
            )
        )
        offer = SourceOffer(
            product_id=product.id,
            provider="amazon-demo",
            external_id="AMZ-TEST",
            title="Sony WH-1000XM5 Black",
            brand="Sony",
            model="WH-1000XM5",
            condition=ProductCondition.NEW,
            currency="EUR",
            price=Decimal(overrides.get("source_price", "199.00")),
            shipping_cost=Decimal("0.00"),
            price_timestamp=overrides.get("price_timestamp", now),
            stock_status=overrides.get("stock_status", StockStatus.IN_STOCK),
            available_quantity=overrides.get("available_quantity", 20),
            stock_confidence=Decimal("0.95"),
            inventory_timestamp=overrides.get("inventory_timestamp", now),
            delivery_min_days=overrides.get("delivery_min_days", 1),
            delivery_max_days=overrides.get("delivery_max_days", 2),
            delivery_speed=DeliverySpeed.FAST,
            delivery_timestamp=now,
            attributes=dict(overrides.get("source_attributes", {"color": "black"})),
            raw_payload={"identifiers": {"EAN": EAN}},
        )
        listing = TargetListing(
            product_id=product.id,
            provider="ebay-demo",
            external_id="EBAY-TEST",
            title="Sony WH-1000XM5 Black",
            brand="Sony",
            model="WH-1000XM5",
            condition=overrides.get("target_condition", ProductCondition.NEW),
            currency="EUR",
            price=Decimal(overrides.get("target_price", "319.00")),
            shipping_price=Decimal("0.00"),
            price_timestamp=now,
            quantity=1,
            attributes=dict(overrides.get("target_attributes", {"color": "black"})),
            raw_payload={"identifiers": {"EAN": EAN}},
        )
        session.add_all([offer, listing])
        session.flush()
        opportunity = Opportunity(
            reference=reference("OPP"),
            product_id=product.id,
            source_offer_id=offer.id,
            target_listing_id=listing.id,
            state=OpportunityState.DISCOVERED,
            currency="EUR",
            quantity=1,
            expires_at=now + timedelta(days=1),
        )
        session.add(opportunity)
        session.flush()
        return opportunity, offer, listing, product

    return _build


@pytest.fixture
def service(session, config, providers):
    return OpportunityService(session, config, providers)


def test_a_healthy_opportunity_becomes_actionable(scenario, service):
    opportunity, *_ = scenario()
    result = service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.ACTIONABLE
    assert result.decision.value == "PASS"
    assert opportunity.expected_net_profit >= Decimal("20")
    assert opportunity.profit_margin >= Decimal("0.15")
    assert opportunity.risk_score <= 35


def test_profit_below_the_minimum_is_rejected(scenario, service):
    """Spec: profit < EUR 20 -> REJECT."""
    opportunity, *_ = scenario(source_price="300.00", target_price="330.00")
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.REJECTED
    assert "below the minimum" in opportunity.rejected_reason


def test_margin_below_the_minimum_is_rejected(scenario, service, session, config):
    """Clears the 20 EUR cash floor but not the 15 % margin floor.

    Prices are chosen to stay inside the capital limit so that this test
    isolates the margin rule rather than tripping capital protection.
    """
    opportunity, *_ = scenario(source_price="220.00", target_price="300.00")
    service.evaluate(opportunity)
    assert opportunity.expected_net_profit >= config.minimum_net_profit
    assert opportunity.profit_margin < config.minimum_profit_margin
    assert opportunity.state is OpportunityState.REJECTED
    assert "margin" in opportunity.rejected_reason


def test_match_confidence_below_the_minimum_is_rejected(scenario, service, session):
    """Spec: match confidence < 95 -> REJECT."""
    opportunity, offer, listing, _ = scenario()
    # Remove the corroborating identifiers from both sides.
    offer.raw_payload = {}
    listing.raw_payload = {}
    offer.model = None
    listing.model = None
    session.query(ProductIdentifier).delete()
    session.flush()
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.REJECTED
    assert "confidence" in opportunity.rejected_reason


def test_variant_mismatch_blocks(scenario, service):
    """Spec: variant mismatch -> BLOCK."""
    opportunity, *_ = scenario(
        source_attributes={"color": "black"}, target_attributes={"color": "silver"}
    )
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert "color" in opportunity.blocked_reason


def test_unknown_inventory_blocks(scenario, service):
    """Spec: inventory unknown -> BLOCK."""
    opportunity, *_ = scenario(stock_status=StockStatus.UNKNOWN)
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert "UNKNOWN" in opportunity.blocked_reason


def test_out_of_stock_blocks(scenario, service):
    opportunity, *_ = scenario(stock_status=StockStatus.OUT_OF_STOCK)
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert "out of stock" in opportunity.blocked_reason


def test_infeasible_delivery_blocks(scenario, service):
    opportunity, *_ = scenario(delivery_min_days=8, delivery_max_days=14)
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert "delivery" in opportunity.blocked_reason


def test_price_anomaly_blocks_instead_of_being_believed(scenario, service):
    """Spec: a 50 -> 150 gap must not be treated as EUR 100 of profit."""
    opportunity, *_ = scenario(source_price="50.00", target_price="150.00")
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert "anomalous" in opportunity.blocked_reason


def test_stale_price_is_reported_as_stale(scenario, service, config):
    """Spec: stale price -> REVALIDATE."""
    stale_at = utcnow() - timedelta(seconds=config.max_price_age_seconds + 600)
    opportunity, *_ = scenario(price_timestamp=stale_at)
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert any("old" in reason for reason in opportunity.decision_reasons)


def test_staleness_lists_each_aged_input(scenario, service, config, session):
    opportunity, *_ = scenario()
    service.evaluate(opportunity)
    assert service.staleness(opportunity) == []
    opportunity.source_price_timestamp = utcnow() - timedelta(days=2)
    opportunity.inventory_timestamp = None
    session.flush()
    stale = service.staleness(opportunity)
    assert any("source price" in s for s in stale)
    assert any("inventory has never been observed" in s for s in stale)


def test_condition_mismatch_blocks(scenario, service):
    opportunity, *_ = scenario(target_condition=ProductCondition.USED)
    service.evaluate(opportunity)
    assert opportunity.state is OpportunityState.BLOCKED
    assert "condition" in opportunity.blocked_reason


def test_every_decision_is_explained(scenario, service):
    opportunity, *_ = scenario()
    service.evaluate(opportunity)
    assert opportunity.decision_reasons
    assert opportunity.risk_assessments
    assert opportunity.profit_calculations
    scenarios = {c.scenario.value for c in opportunity.profit_calculations}
    assert scenarios == {"BEST_CASE", "BASE_CASE", "WORST_CASE"}


def test_expiry_moves_aged_opportunities_out_of_the_working_set(scenario, service, session):
    opportunity, *_ = scenario()
    service.evaluate(opportunity)
    opportunity.expires_at = utcnow() - timedelta(seconds=1)
    session.flush()
    assert service.expire_stale() == 1
    assert opportunity.state is OpportunityState.EXPIRED


def test_transitions_are_audited(scenario, service, session):
    opportunity, *_ = scenario()
    service.evaluate(opportunity)
    from app.models.ops import AuditLog

    rows = session.query(AuditLog).filter(AuditLog.entity_type == "opportunity").all()
    assert rows
    assert all(row.occurred_at is not None for row in rows)
    assert any(row.new_state == OpportunityState.ACTIONABLE.value for row in rows)
