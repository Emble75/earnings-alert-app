"""Compliance gates stop actions; they never enable one."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.compliance.rules import (
    ComplianceContext,
    check_fulfillment,
    check_listing,
    check_order,
    check_seller_requirements,
)
from app.compliance.service import ComplianceService
from app.core.errors import ComplianceBlockedError
from app.models.enums import ComplianceCheckType, DecisionOutcome, ProductCondition, StockStatus


def valid_listing_ctx() -> ComplianceContext:
    return ComplianceContext(
        title="Sony WH-1000XM5 Wireless Headphones, Black",
        condition=ProductCondition.NEW,
        declared_condition_matches_source=True,
        identifiers={"EAN": "4548736134584"},
        price=Decimal("319.00"),
        match_is_verified=True,
        handling_time_days=1,
    )


def valid_order_ctx() -> ComplianceContext:
    return ComplianceContext(
        source_stock_status=StockStatus.IN_STOCK,
        source_available_quantity=10,
        required_quantity=1,
        source_delivery_max_days=2,
        buyer_delivery_expectation_days=5,
        match_is_verified=True,
    )


def test_a_valid_listing_passes():
    assert check_listing(valid_listing_ctx()).outcome is DecisionOutcome.PASS


def test_a_listing_must_state_its_condition():
    ctx = valid_listing_ctx()
    ctx.condition = ProductCondition.UNKNOWN
    result = check_listing(ctx)
    assert result.is_blocking


def test_a_listing_may_not_misstate_the_condition_of_the_goods():
    ctx = valid_listing_ctx()
    ctx.declared_condition_matches_source = False
    result = check_listing(ctx)
    assert result.is_blocking
    assert "condition" in (result.blocked_reason() or "")


def test_an_unverified_match_cannot_be_listed():
    ctx = valid_listing_ctx()
    ctx.match_is_verified = False
    assert check_listing(ctx).is_blocking


def test_unknown_source_availability_blocks_the_order():
    ctx = valid_order_ctx()
    ctx.source_stock_status = StockStatus.UNKNOWN
    result = check_order(ctx)
    assert result.is_blocking
    assert "unknown" in (result.blocked_reason() or "").lower()


def test_a_delivery_promise_we_cannot_keep_blocks_the_order():
    ctx = valid_order_ctx()
    ctx.source_delivery_max_days = 10
    assert check_order(ctx).is_blocking


def test_dispatch_requires_a_passed_inspection():
    ctx = ComplianceContext(
        ship_to={
            "name": "A", "street": "B", "postal_code": "1", "city": "C", "country": "DE",
        },
        inspection_passed=False,
    )
    assert check_fulfillment(ctx).is_blocking


def test_dispatch_requires_a_complete_address():
    ctx = ComplianceContext(ship_to={"name": "A"}, inspection_passed=True)
    result = check_fulfillment(ctx)
    assert result.is_blocking
    assert "incomplete" in (result.blocked_reason() or "")


def test_tracking_without_a_carrier_is_refused():
    ctx = ComplianceContext(
        ship_to={"name": "A", "street": "B", "postal_code": "1", "city": "C", "country": "DE"},
        inspection_passed=True,
        tracking_number="XYZ",
        carrier=None,
    )
    result = check_fulfillment(ctx)
    assert result.is_blocking
    assert "carrier" in (result.blocked_reason() or "")


def test_an_inactive_seller_account_blocks_listing():
    ctx = valid_listing_ctx()
    ctx.seller_account_active = False
    assert check_listing(ctx).is_blocking
    assert check_seller_requirements(ctx).is_blocking


def test_the_service_persists_every_verdict(session):
    service = ComplianceService(session)
    result = service.check(
        ComplianceCheckType.LISTING, valid_listing_ctx(), entity_type="opportunity", entity_id=1
    )
    assert result.outcome is DecisionOutcome.PASS
    from app.models.ops import ComplianceCheck

    rows = session.query(ComplianceCheck).all()
    assert len(rows) == 1
    assert rows[0].results, "the rules that ran must be recorded"


def test_require_raises_on_a_block(session):
    service = ComplianceService(session)
    ctx = valid_order_ctx()
    ctx.source_stock_status = StockStatus.OUT_OF_STOCK
    with pytest.raises(ComplianceBlockedError):
        service.require(ComplianceCheckType.ORDER, ctx, entity_type="order", entity_id=1)
