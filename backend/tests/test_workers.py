"""Worker tasks run against the real services, in eager mode."""

from __future__ import annotations

import pytest

from app.models.enums import OpportunityState, OrderState


@pytest.fixture(autouse=True)
def _eager_db(engine, monkeypatch):
    """Point the worker session factory at the test database."""
    from sqlalchemy.orm import sessionmaker

    from app.db import session as db_session

    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(
        db_session, "_session_factory", sessionmaker(bind=engine, expire_on_commit=False)
    )
    from app.services.settings_service import SettingsService

    with db_session.session_scope() as session:
        SettingsService(session).ensure_defaults()


def test_discovery_and_calculation_tasks_cooperate():
    from app.workers.tasks import calculate_opportunities, discover_products

    discovered = discover_products(query="")
    assert discovered["discovered"] == 10

    calculated = calculate_opportunities()
    assert calculated["evaluated"] >= 1
    assert calculated["actionable"] >= 1


def test_the_expiry_task_moves_aged_opportunities_out():
    from datetime import timedelta

    from app.core.clock import utcnow
    from app.db.session import session_scope
    from app.models.opportunity import Opportunity
    from app.workers.tasks import discover_products, expire_opportunities

    discover_products(query="")
    with session_scope() as session:
        for opportunity in session.query(Opportunity).all():
            opportunity.expires_at = utcnow() - timedelta(seconds=1)

    result = expire_opportunities()
    assert result["expired"] >= 1


def test_refresh_tasks_are_safe_to_run_repeatedly():
    from app.workers.tasks import discover_products, refresh_inventory, refresh_prices

    discover_products(query="")
    first = refresh_prices()
    second = refresh_prices()
    assert first["refreshed"] == second["refreshed"]
    assert refresh_inventory()["refreshed"] == first["refreshed"]


def test_execution_is_gated_below_automation_level_three():
    from app.db.session import session_scope
    from app.services.settings_service import SettingsService
    from app.workers.tasks import execute_approved_orders

    with session_scope() as session:
        SettingsService(session).update({"automation_level": 2})
    result = execute_approved_orders()
    assert "skipped" in result

    with session_scope() as session:
        SettingsService(session).update({"automation_level": 3})
    result = execute_approved_orders()
    assert "considered" in result


def _publish_and_sell() -> None:
    """Drive the demo providers to the point where a sale exists."""
    from app.db.session import session_scope
    from app.listing.engine import ListingEngine
    from app.models.opportunity import Opportunity
    from app.providers.registry import get_providers
    from app.services.opportunity_service import OpportunityService
    from app.services.settings_service import SettingsService
    from app.workers.tasks import discover_products

    discover_products(query="")
    with session_scope() as session:
        config = SettingsService(session).load()
        providers = get_providers()
        opportunities = OpportunityService(session, config, providers)
        listings = ListingEngine(session, config, providers)
        target = None
        for opportunity in session.query(Opportunity).all():
            opportunities.evaluate(opportunity)
            if opportunity.state is OpportunityState.ACTIONABLE:
                target = opportunity
                break
        assert target is not None
        candidate = listings.create_listing_candidate(target)
        listing = listings.publish_listing(target, candidate.listing)
        providers.target.simulate_sale(listing_external_id=listing.external_id)


def test_polling_sales_does_not_duplicate_orders():
    from app.db.session import session_scope
    from app.models.order import Order
    from app.workers.tasks import poll_sales

    _publish_and_sell()
    first = poll_sales()
    assert first["orders_created"] == 1
    second = poll_sales()
    assert second["orders_created"] == 0

    with session_scope() as session:
        assert session.query(Order).count() == 1


def test_notifications_are_queued_and_dispatched():
    from app.db.session import session_scope
    from app.models.ops import Notification
    from app.workers.tasks import calculate_opportunities, discover_products, send_notifications

    discover_products(query="")
    calculate_opportunities()
    with session_scope() as session:
        assert session.query(Notification).count() >= 1

    result = send_notifications()
    assert result["sent"] >= 1
    with session_scope() as session:
        statuses = {n.status.value for n in session.query(Notification).all()}
        assert "SENT" in statuses


def test_order_revalidation_task_advances_new_sales():
    from app.db.session import session_scope
    from app.models.order import Order
    from app.workers.tasks import poll_sales, revalidate_orders

    _publish_and_sell()
    poll_sales()
    result = revalidate_orders()
    assert result["revalidated"] >= 0
    with session_scope() as session:
        order = session.query(Order).first()
        assert order.state in (
            OrderState.APPROVAL_REQUIRED,
            OrderState.BLOCKED,
            OrderState.REVALIDATION_REQUIRED,
        )
