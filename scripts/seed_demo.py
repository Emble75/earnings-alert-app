#!/usr/bin/env python
"""Seed the database with demo opportunities and walk one order to completion.

Useful for a first look at the console, and for checking a deployment without
touching a real marketplace. It refuses to run outside demo/simulation mode.

    python scripts/seed_demo.py [--full-order]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.core.config import get_settings  # noqa: E402
from app.core.logging import configure_logging  # noqa: E402
from app.db.session import session_scope  # noqa: E402
from app.listing.engine import ListingEngine  # noqa: E402
from app.models.enums import OpportunityState, ProductCondition, ShipmentState  # noqa: E402
from app.providers.registry import get_providers  # noqa: E402
from app.services.fulfillment_service import FulfillmentService  # noqa: E402
from app.services.opportunity_service import OpportunityService  # noqa: E402
from app.services.order_service import OrderService  # noqa: E402
from app.services.return_service import ReturnService  # noqa: E402
from app.services.settings_service import SettingsService  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--full-order",
        action="store_true",
        help="also list, sell, approve, purchase, fulfil and complete one order",
    )
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level, "console")
    if not (settings.effective_demo_mode or settings.simulation_mode):
        print("refusing to seed: this deployment is configured for live trading", file=sys.stderr)
        return 2

    providers = get_providers()
    with session_scope() as session:
        config = SettingsService(session).ensure_defaults()
        opportunities = OpportunityService(session, config, providers)

        discovered = opportunities.discover("")
        actionable = []
        for opportunity in discovered:
            opportunities.evaluate(opportunity)
            if opportunity.state is OpportunityState.ACTIONABLE:
                actionable.append(opportunity)

        print(f"discovered {len(discovered)} opportunities, {len(actionable)} actionable")
        for opportunity in discovered:
            reason = opportunity.blocked_reason or opportunity.rejected_reason or ""
            print(
                f"  {opportunity.reference}  {opportunity.state.value:<18}"
                f" profit={opportunity.expected_net_profit}  risk={opportunity.risk_score}"
                f"  {reason[:60]}"
            )

        if not args.full_order or not actionable:
            return 0

        opportunity = actionable[0]
        listings = ListingEngine(session, config, providers)
        candidate = listings.create_listing_candidate(opportunity)
        listing = listings.publish_listing(opportunity, candidate.listing)
        print(f"\nlisted {listing.sku} at {listing.price} (floor {listing.minimum_sale_price})")

        sale = providers.target.simulate_sale(listing_external_id=listing.external_id)
        orders = OrderService(session, config, providers)
        order = orders.ingest_sale(sale)
        outcome = orders.revalidate(order)
        print(f"sale {order.reference}: revalidation ok={outcome.ok} state={order.state.value}")
        if not outcome.ok:
            print("  problems:", "; ".join(outcome.problems))
            return 0

        orders.approve(order, user_id=None, note="seeded demo approval")
        source_order = orders.execute(order)
        print(f"purchased {source_order.external_order_id} for {source_order.total_cost}")

        fulfillment = FulfillmentService(session, config, providers)
        fulfillment.receive(order, received_quantity=1, package_intact=True, carrier="DHL")
        fulfillment.inspect(order, observed_condition=ProductCondition.NEW)
        fulfillment.repack(order, original_package_usable=False)
        shipment = fulfillment.ship(order)
        fulfillment.update_tracking(shipment, state=ShipmentState.IN_TRANSIT)
        fulfillment.update_tracking(shipment, state=ShipmentState.DELIVERED)
        ReturnService(session, config, providers).finalize(order)

        print(
            f"completed {order.reference}: expected {order.expected_net_profit}, "
            f"realized {order.realized_net_profit}, variance {order.profit_variance}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
