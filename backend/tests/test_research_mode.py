"""Research mode: real analysis, no possibility of acting on it."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.config import Settings
from app.models.enums import OpportunityState, ProductCondition, StockStatus
from app.providers.readonly import ResearchModeError
from app.providers.registry import build_providers
from app.services.research_service import ResearchInput, ResearchService, parse_csv

EAN = "4548736134584"


@pytest.fixture
def research_providers():
    return build_providers(Settings(research_mode=True))


@pytest.fixture
def service(session, config, research_providers):
    return ResearchService(session, config, research_providers)


def profitable() -> ResearchInput:
    """A real-shaped product that clears every threshold."""
    return ResearchInput(
        title="Sony WH-1000XM5 Wireless Headphones, Black",
        ean=EAN,
        brand="Sony",
        model="WH-1000XM5",
        source_price=Decimal("199.00"),
        target_price=Decimal("319.00"),
        source_stock=StockStatus.IN_STOCK,
        source_delivery_days=2,
        source_quantity_available=20,
        competitor_count=11,
        lowest_competitor_price=Decimal("309.00"),
        median_competitor_price=Decimal("319.00"),
        highest_competitor_price=Decimal("349.90"),
        condition=ProductCondition.NEW,
    )


def test_a_hand_entered_product_is_fully_analysed(service):
    outcome = service.analyse([profitable()])

    assert outcome.summary()["analysed"] == 1
    assert outcome.summary()["actionable"] == 1
    opportunity = outcome.created[0]
    assert opportunity.state is OpportunityState.ACTIONABLE
    assert opportunity.expected_net_profit > Decimal("20")
    assert opportunity.profit_margin >= Decimal("0.15")
    assert opportunity.risk_score is not None
    assert opportunity.match_confidence >= Decimal("95")
    # The full evidence is there, exactly as for an automatically discovered one.
    assert len(opportunity.profit_calculations) == 3
    assert opportunity.risk_assessments[-1].factors


def test_the_same_thresholds_apply_to_hand_entered_products(service):
    thin = profitable()
    thin.source_price = Decimal("300.00")
    thin.target_price = Decimal("319.00")
    outcome = service.analyse([thin])
    assert outcome.created[0].state is OpportunityState.REJECTED
    assert "below the minimum" in (outcome.created[0].rejected_reason or "")


def test_a_product_without_an_ean_cannot_be_verified(service):
    """Stated plainly rather than silently assumed."""
    unverifiable = profitable()
    unverifiable.ean = None
    outcome = service.analyse([unverifiable])
    opportunity = outcome.created[0]
    assert opportunity.state is OpportunityState.REJECTED
    assert "confidence" in (opportunity.rejected_reason or "")


def test_unknown_stock_blocks_a_hand_entered_product(service):
    unknown = profitable()
    unknown.source_stock = StockStatus.UNKNOWN
    outcome = service.analyse([unknown])
    assert outcome.created[0].state is OpportunityState.BLOCKED


def test_one_bad_row_does_not_lose_the_others(service):
    good = profitable()
    broken = profitable()
    broken.source_price = Decimal("-5")
    outcome = service.analyse([good, broken])
    assert outcome.summary()["analysed"] >= 1
    assert any(o.state is OpportunityState.ACTIONABLE for o in outcome.created)


# -- CSV parsing ------------------------------------------------------------
def test_csv_round_trip():
    from app.services.research_service import CSV_TEMPLATE

    rows, errors = parse_csv(CSV_TEMPLATE)
    assert errors == []
    assert len(rows) == 1
    assert rows[0].ean == EAN
    assert rows[0].source_price == Decimal("199.00")
    assert rows[0].source_stock is StockStatus.IN_STOCK


def test_csv_accepts_a_semicolon_file_with_comma_decimals():
    """What Excel produces in most of continental Europe."""
    content = (
        "title;ean;source_price;target_price\n"
        "Test product;4548736134584;€199,00;1.319,50\n"
    )
    rows, errors = parse_csv(content)
    assert errors == []
    assert rows[0].source_price == Decimal("199.00")
    assert rows[0].target_price == Decimal("1319.50")


def test_csv_accepts_a_tab_separated_file():
    content = "title\tean\tsource_price\ttarget_price\nTest\t4548736134584\t199.00\t319.00\n"
    rows, errors = parse_csv(content)
    assert errors == []
    assert rows[0].target_price == Decimal("319.00")


def test_csv_missing_a_required_column_is_refused():
    from app.core.errors import ValidationError

    with pytest.raises(ValidationError) as exc:
        parse_csv("title,ean\nSomething,123\n")
    assert "source_price" in str(exc.value)


def test_csv_reports_bad_rows_without_discarding_good_ones():
    content = (
        "title,ean,source_price,target_price\n"
        "Good product,4548736134584,199.00,319.00\n"
        "Bad product,123,not-a-number,319.00\n"
    )
    rows, errors = parse_csv(content)
    assert len(rows) == 1
    assert len(errors) == 1
    assert "row 3" in errors[0]


# -- the safety guarantee ---------------------------------------------------
def test_research_mode_refuses_to_publish(session, config, research_providers):
    """Even a fully actionable opportunity cannot be listed."""
    from app.listing.engine import ListingEngine

    service = ResearchService(session, config, research_providers)
    opportunity = service.analyse([profitable()]).created[0]
    assert opportunity.state is OpportunityState.ACTIONABLE

    engine = ListingEngine(session, config, research_providers)
    # Computing the minimum viable price is analysis and stays available.
    candidate = engine.create_listing_candidate(opportunity)
    assert candidate.minimum_sale_price.is_positive()

    # Publishing is not.
    with pytest.raises(ResearchModeError):
        engine.publish_listing(opportunity, candidate.listing)


def test_research_mode_refuses_to_approve_or_purchase(session, config, research_providers):
    from app.core.money import Money
    from app.models.order import Order
    from app.services.order_service import OrderService

    orders = OrderService(session, config, research_providers)
    order = Order(
        reference="ORD-TEST",
        provider="manual-research",
        external_order_id="X-1",
        currency="EUR",
        quantity=1,
        sale_price=Decimal("319.00"),
        buyer_shipping_paid=Decimal("0"),
        capital_required=Decimal("200.00"),
    )
    session.add(order)
    session.flush()

    with pytest.raises(ResearchModeError):
        orders.approve(order, user_id=None)
    with pytest.raises(ResearchModeError):
        orders.execute(order)
    assert Money(order.sale_price) == Money("319.00")


def test_research_mode_compliance_blocks_outward_actions():
    from app.compliance.rules import (
        ComplianceContext,
        check_fulfillment,
        check_listing,
        check_order,
    )

    ctx = ComplianceContext(research_mode=True)
    for check in (check_listing, check_order, check_fulfillment):
        result = check(ctx)
        assert result.is_blocking
        assert "research mode" in (result.blocked_reason() or "")


def test_a_rejection_tells_the_operator_what_to_add(service):
    """An accurate error that cannot be acted on is a bad error."""
    incomplete = profitable()
    incomplete.brand = None
    incomplete.model = None
    outcome = service.analyse([incomplete])

    opportunity = outcome.created[0]
    assert opportunity.state is OpportunityState.REJECTED
    reason = opportunity.rejected_reason or ""
    assert "brand" in reason and "model" in reason
    assert "analyse it again" in reason


# -- skipping sign-in on a local install ------------------------------------
def test_sign_in_may_be_skipped_only_when_nothing_can_be_spent():
    """The flag alone is never enough."""
    from app.core.config import Settings

    # Research mode: permitted.
    assert Settings(local_no_auth=True, research_mode=True).local_no_auth_permitted is True
    # Demo mode: permitted.
    assert Settings(local_no_auth=True, demo_mode=True).local_no_auth_permitted is True
    # Able to trade: refused, whatever the flag says.
    live = Settings(
        local_no_auth=True,
        research_mode=False,
        demo_mode=False,
        simulation_mode=False,
        amazon_api_base_url="https://example.invalid",
        amazon_api_key="k",
        amazon_api_secret="s",
        ebay_api_base_url="https://example.invalid",
        ebay_client_id="c",
        ebay_client_secret="s",
    )
    assert live.local_no_auth_permitted is False
    assert live.auth_required is True
    # Production: refused.
    assert (
        Settings(local_no_auth=True, research_mode=True, environment="production")
        .local_no_auth_permitted
        is False
    )
    # Not requested: sign-in required.
    assert Settings(research_mode=True).auth_required is True
