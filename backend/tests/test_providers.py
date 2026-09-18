"""Provider contracts, resilience and the demo/live selection rule."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.config import Settings
from app.core.errors import CircuitOpenError, ProviderError, ProviderRateLimitedError
from app.core.money import Money
from app.models.enums import ExecutionMode, FulfillmentMode, ProductCondition, StockStatus
from app.providers.base import PurchaseRequest
from app.providers.registry import build_fulfillment_provider, build_providers
from app.providers.resilience import CircuitBreaker, ProviderGuard, RateLimit, RetryPolicy


def test_missing_credentials_force_demo_mode_rather_than_a_live_call():
    settings = Settings(
        demo_mode=False,
        simulation_mode=False,
        amazon_api_base_url="https://example.invalid",
        amazon_api_key="key",
        amazon_api_secret="secret",
        # eBay credentials deliberately absent
        ebay_api_base_url="",
    )
    assert settings.effective_demo_mode is True
    bundle = build_providers(settings)
    assert bundle.execution_mode is ExecutionMode.DEMO
    assert bundle.source.is_live is False
    assert bundle.target.is_live is False


def test_simulation_mode_is_distinct_from_demo_mode():
    settings = Settings(
        demo_mode=False,
        simulation_mode=True,
        amazon_api_base_url="https://example.invalid",
        amazon_api_key="k",
        amazon_api_secret="s",
        ebay_api_base_url="https://example.invalid",
        ebay_client_id="c",
        ebay_client_secret="s",
    )
    assert settings.effective_demo_mode is False
    assert build_providers(settings).execution_mode is ExecutionMode.SIMULATION


def test_demo_source_offers_carry_everything_the_engines_need(providers):
    offers = providers.source.search("")
    assert offers
    for offer in offers:
        assert offer.external_id and offer.title
        assert offer.identifiers.get("EAN")
        assert offer.observed_at is not None
        assert isinstance(offer.stock_confidence, Decimal)
        if offer.stock_status is not StockStatus.OUT_OF_STOCK:
            assert offer.price is not None
            assert isinstance(offer.price, Money)


def test_a_purchase_is_idempotent_on_its_key(providers):
    offer = providers.source.search("")[0]
    request = PurchaseRequest(
        offer_external_id=offer.external_id,
        quantity=1,
        max_unit_price=Money("10000.00"),
        idempotency_key="test-key-1",
    )
    first = providers.source.purchase(request)
    second = providers.source.purchase(request)
    assert first.success and second.success
    assert second.already_placed is True
    assert second.external_order_id == first.external_order_id


def test_a_purchase_above_the_ceiling_is_refused(providers):
    offer = providers.source.search("")[0]
    result = providers.source.purchase(
        PurchaseRequest(
            offer_external_id=offer.external_id,
            quantity=1,
            max_unit_price=Money("0.01"),
            idempotency_key="test-key-2",
        )
    )
    assert result.success is False
    assert "exceeds the approved ceiling" in result.message


def test_an_out_of_stock_offer_cannot_be_purchased(providers):
    offers = providers.source.search("")
    out_of_stock = next(
        (o for o in providers.source.get_offers([o.external_id for o in offers])
         if o.stock_status is StockStatus.OUT_OF_STOCK),
        None,
    )
    assert out_of_stock is not None, "the demo catalogue must contain an out-of-stock item"
    result = providers.source.purchase(
        PurchaseRequest(
            offer_external_id=out_of_stock.external_id,
            quantity=1,
            max_unit_price=Money("10000.00"),
            idempotency_key="test-key-3",
        )
    )
    assert result.success is False


def test_market_stats_never_present_the_highest_price_as_achievable(providers):
    stats = providers.target.get_market_stats(identifier="4548736134584")
    assert stats.realistic_sale_price is not None
    assert stats.realistic_sale_price <= stats.highest_price


def test_publishing_is_idempotent(providers):
    from app.providers.base import PublishRequest

    request = PublishRequest(
        sku="SKU-TEST",
        title="Test listing",
        description="d",
        price=Money("100.00"),
        quantity=1,
        condition=ProductCondition.NEW,
        idempotency_key="publish-key-1",
    )
    first = providers.target.publish_listing(request)
    second = providers.target.publish_listing(request)
    assert second.already_published is True
    assert second.external_id == first.external_id


def test_the_demo_webhook_verifier_checks_a_configured_secret():
    from app.providers.ebay.demo import DemoEbayProvider

    provider = DemoEbayProvider(webhook_secret="s3cret")
    assert provider.verify_webhook(b"{}", None) is False
    assert provider.verify_webhook(b"{}", "wrong") is False

    import hashlib
    import hmac

    signature = hmac.new(b"s3cret", b"{}", hashlib.sha256).hexdigest()
    assert provider.verify_webhook(b"{}", signature) is True


def test_the_live_webhook_verifier_fails_closed():
    from app.providers.http_gateway import HttpTargetProvider

    provider = HttpTargetProvider(base_url="https://example.invalid", webhook_secret="")
    assert provider.verify_webhook(b"{}", "anything") is False


def test_a_live_provider_without_a_base_url_refuses_to_construct():
    from app.providers.http_gateway import HttpSourceProvider

    with pytest.raises(ProviderError):
        HttpSourceProvider(base_url="")


def test_manual_fulfilment_charges_nothing_for_handling():
    provider = build_fulfillment_provider(FulfillmentMode.MANUAL)
    schedule = provider.fee_schedule()
    assert set(schedule) == {
        "receiving_fee",
        "storage_fee",
        "pick_fee",
        "pack_fee",
        "handling_fee",
        "outbound_fee",
        "return_fee",
    }
    assert all(fee.is_zero() for fee in schedule.values())


def test_an_unimplemented_fulfilment_mode_fails_loudly():
    with pytest.raises(NotImplementedError):
        build_fulfillment_provider(FulfillmentMode.EXTERNAL_3PL)


def test_manual_inspection_refuses_to_pass_what_it_cannot_verify():
    provider = build_fulfillment_provider(FulfillmentMode.MANUAL)
    assert provider.verify_sku(expected=None, observed="X") is False
    assert provider.verify_sku(expected="X", observed=None) is False
    assert provider.verify_condition(
        expected=ProductCondition.NEW, observed=ProductCondition.UNKNOWN
    ) is False


def test_outbound_shipments_are_idempotent():
    provider = build_fulfillment_provider(FulfillmentMode.MANUAL)
    kwargs = {
        "order_reference": "ORD-1",
        "destination": {"country": "DE"},
        "shipping_cost": Money("5.99"),
        "idempotency_key": "ship-1",
    }
    first = provider.create_outbound_shipment(**kwargs)
    second = provider.create_outbound_shipment(**kwargs)
    assert second.already_created is True
    assert second.tracking_number == first.tracking_number


def test_the_rate_limiter_refuses_when_it_cannot_block():
    limiter = RateLimit(max_calls=2, per_seconds=60)
    limiter.acquire(block=False)
    limiter.acquire(block=False)
    with pytest.raises(ProviderRateLimitedError):
        limiter.acquire(block=False)


def test_the_circuit_opens_after_repeated_failures():
    breaker = CircuitBreaker(failure_threshold=3, reset_timeout=60)
    assert breaker.state == "CLOSED"
    for _ in range(3):
        breaker.record_failure()
    assert breaker.state == "OPEN"
    with pytest.raises(CircuitOpenError):
        breaker.before_call("test")
    breaker.record_success()
    assert breaker.state == "CLOSED"


def test_the_guard_retries_retryable_errors_and_gives_up_cleanly():
    attempts = {"count": 0}

    def flaky():
        attempts["count"] += 1
        raise ProviderError("temporary", retryable=True)

    guard = ProviderGuard(
        provider="test", retry=RetryPolicy(attempts=3, base_delay=0), sleeper=lambda _: None
    )
    with pytest.raises(ProviderError):
        guard.call("flaky", flaky)
    assert attempts["count"] == 3


def test_the_guard_does_not_retry_a_non_retryable_error():
    attempts = {"count": 0}

    def broken():
        attempts["count"] += 1
        raise ProviderError("permanent", retryable=False)

    guard = ProviderGuard(
        provider="test", retry=RetryPolicy(attempts=3, base_delay=0), sleeper=lambda _: None
    )
    with pytest.raises(ProviderError):
        guard.call("broken", broken)
    assert attempts["count"] == 1


# ---------------------------------------------------------------------------
# Research mode: real data in, nothing out.
# ---------------------------------------------------------------------------
def _research_providers():
    from app.core.config import Settings

    return build_providers(Settings(research_mode=True))


def test_research_mode_is_reported_as_read_only():
    bundle = _research_providers()
    assert bundle.execution_mode is ExecutionMode.RESEARCH
    assert bundle.is_read_only is True
    assert bundle.describe()["read_only"] is True


def test_research_mode_still_reads_market_data():
    """The whole point: real analysis needs real reads."""
    bundle = _research_providers()
    assert len(bundle.source.search("")) > 0
    assert bundle.source.get_offer("AMZ-B09XS7JWHH") is not None
    assert bundle.target.get_market_stats(identifier="4548736134584").competitor_count > 0
    assert bundle.source.health()["read_only"] is True


def test_research_mode_cannot_purchase():
    from app.providers.readonly import ResearchModeError

    bundle = _research_providers()
    with pytest.raises(ResearchModeError):
        bundle.source.purchase(
            PurchaseRequest(
                offer_external_id="AMZ-B09XS7JWHH",
                quantity=1,
                max_unit_price=Money("10000.00"),
                idempotency_key="research-attempt",
            )
        )


def test_research_mode_cannot_list_update_end_or_upload_tracking():
    from app.providers.base import PublishRequest
    from app.providers.readonly import ResearchModeError

    bundle = _research_providers()
    with pytest.raises(ResearchModeError):
        bundle.target.publish_listing(
            PublishRequest(
                sku="X", title="t", description="d", price=Money("10.00"),
                quantity=1, condition=ProductCondition.NEW, idempotency_key="k",
            )
        )
    with pytest.raises(ResearchModeError):
        bundle.target.update_listing("X", price=Money("1.00"))
    with pytest.raises(ResearchModeError):
        bundle.target.end_listing("X")
    with pytest.raises(ResearchModeError):
        bundle.target.upload_tracking("X", carrier="DHL", tracking_number="1", idempotency_key="k")


def test_research_mode_uses_live_data_when_credentials_exist():
    """Research mode is the one mode that may point at live credentials."""
    from app.core.config import Settings

    settings = Settings(
        research_mode=True,
        amazon_api_base_url="https://example.invalid",
        amazon_api_key="k",
        amazon_api_secret="s",
        ebay_api_base_url="https://example.invalid",
        ebay_client_id="c",
        ebay_client_secret="s",
    )
    bundle = build_providers(settings)
    assert bundle.execution_mode is ExecutionMode.RESEARCH
    assert bundle.is_read_only is True
    # The real adapters are wrapped, so the data is live but the writes are gone.
    assert "amazon" in bundle.source.name
    assert bundle.describe()["demo_mode"] is False


def test_research_mode_beats_every_other_mode():
    """It must not be downgraded by demo or simulation settings."""
    from app.core.config import Settings

    for demo, simulation in ((True, True), (True, False), (False, True), (False, False)):
        settings = Settings(research_mode=True, demo_mode=demo, simulation_mode=simulation)
        assert build_providers(settings).execution_mode is ExecutionMode.RESEARCH
