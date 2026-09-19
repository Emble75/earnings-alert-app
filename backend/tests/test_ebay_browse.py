"""The eBay Browse adapter, exercised against recorded response shapes.

Nothing here touches the network. The payloads are the shapes eBay documents
for ``item_summary/search`` and ``item``; what is being tested is the
translation into the system's own types, and - more importantly - what the
adapter refuses to do.
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from app.core.errors import ProviderError, ProviderRateLimitedError
from app.core.money import Money
from app.models.enums import ProductCondition
from app.providers.base import PublishRequest
from app.providers.ebay.browse import EbayBrowseProvider, legacy_item_id
from app.providers.resilience import ProviderGuard, RetryPolicy

TOKEN_RESPONSE = {"access_token": "t-abc", "expires_in": 7200, "token_type": "Application Access Token"}

SEARCH_RESPONSE = {
    "total": 2,
    "itemSummaries": [
        {
            "itemId": "v1|123456789012|0",
            "title": "Sony WH-1000XM5 Wireless Kopfhörer Schwarz",
            "price": {"value": "279.00", "currency": "EUR"},
            "shippingOptions": [{"shippingCost": {"value": "4.99", "currency": "EUR"}}],
            "conditionId": "1000",
            "condition": "Neu",
            "itemWebUrl": "https://www.ebay.de/itm/123456789012",
            "seller": {"username": "hifi-shop", "feedbackPercentage": "99.4", "feedbackScore": 5120},
            "buyingOptions": ["FIXED_PRICE"],
            "itemLocation": {"country": "DE"},
            "categories": [{"categoryId": "112529"}],
        },
        {
            "itemId": "v1|998877665544|0",
            "title": "Sony WH-1000XM5 Silber",
            "price": {"value": "299.00", "currency": "EUR"},
            "shippingOptions": [{"shippingCost": {"value": "0.00", "currency": "EUR"}}],
            "conditionId": "3000",
            "itemWebUrl": "https://www.ebay.de/itm/998877665544",
            "seller": {"username": "second-hand", "feedbackPercentage": "98.1", "feedbackScore": 300},
            "buyingOptions": ["FIXED_PRICE"],
        },
    ],
}

ITEM_RESPONSE = {
    "itemId": "v1|123456789012|0",
    "legacyItemId": "123456789012",
    "title": "Sony WH-1000XM5 Wireless Kopfhörer Schwarz",
    "price": {"value": "279.00", "currency": "EUR"},
    "shippingOptions": [{"shippingCost": {"value": "4.99", "currency": "EUR"}}],
    "conditionId": "1000",
    "brand": "Sony",
    "mpn": "WH1000XM5B",
    "ean": ["4548736134584"],
    "gtin": "4548736134584",
    "epid": "15038032391",
    "estimatedAvailableQuantity": 4,
    "itemWebUrl": "https://www.ebay.de/itm/123456789012",
    "seller": {"username": "hifi-shop", "feedbackPercentage": "99.4", "feedbackScore": 5120},
}


class Recorder:
    """A transport that answers from a script and records what was asked."""

    def __init__(self, routes: dict[str, object], *, status: int = 200) -> None:
        self.routes = routes
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for fragment, payload in self.routes.items():
            if fragment in request.url.path:
                if isinstance(payload, int):
                    return httpx.Response(payload, json={"errors": [{"message": "no"}]})
                return httpx.Response(200, json=payload)
        return httpx.Response(404, json={})


def provider(routes: dict[str, object], **kwargs) -> tuple[EbayBrowseProvider, Recorder]:
    recorder = Recorder({"oauth2/token": TOKEN_RESPONSE, **routes})
    client = httpx.Client(transport=httpx.MockTransport(recorder))
    return (
        EbayBrowseProvider(
            client_id="id",
            client_secret="secret",
            client=client,
            # No rate limit and no sleeping: this is a unit test, not a load test.
            guard=ProviderGuard(provider="ebay-browse", retry=RetryPolicy(attempts=1)),
            **kwargs,
        ),
        recorder,
    )


# -- translation ------------------------------------------------------------
def test_a_search_result_carries_the_item_number_that_addresses_it():
    """The whole reason for this adapter: one result, one addressable offer."""
    ebay, _ = provider({"item_summary/search": SEARCH_RESPONSE})
    listings = ebay.search_listings("Sony WH-1000XM5")

    assert [item.external_id for item in listings] == ["123456789012", "998877665544"]
    assert listings[0].url == "https://www.ebay.de/itm/123456789012"
    assert listings[0].price.amount == Decimal("279.00")
    assert listings[0].shipping_price.amount == Decimal("4.99")
    assert listings[0].condition is ProductCondition.NEW
    assert listings[1].condition is ProductCondition.USED
    assert listings[0].seller_id == "hifi-shop"


def test_prices_arrive_as_exact_decimals():
    ebay, _ = provider({"item_summary/search": SEARCH_RESPONSE})
    price = ebay.search_listings("Sony")[0].price
    assert isinstance(price.amount, Decimal)
    assert str(price.amount) == "279.00"


def test_the_restful_id_is_reduced_to_the_number_in_the_address():
    assert legacy_item_id("v1|123456789012|0") == "123456789012"
    assert legacy_item_id("123456789012") == "123456789012"
    assert legacy_item_id("v1|not-a-number|0") is None
    assert legacy_item_id(None) is None


def test_the_detail_endpoint_supplies_the_product_codes_the_matcher_needs():
    ebay, recorder = provider({"get_item_by_legacy_id": ITEM_RESPONSE})
    listing = ebay.get_listing_status("123456789012")

    assert listing.identifiers["EAN"] == "4548736134584"
    assert listing.identifiers["MPN"] == "WH1000XM5B"
    assert listing.identifiers["EPID"] == "15038032391"
    assert listing.brand == "Sony"
    assert "legacy_item_id=123456789012" in str(recorder.requests[-1].url)


def test_an_unknown_item_is_absent_rather_than_an_error():
    ebay, _ = provider({})
    assert ebay.get_listing_status("123456789012") is None


# -- honesty ----------------------------------------------------------------
def test_a_listing_in_another_currency_is_dropped_not_converted():
    """Inventing an exchange rate would put a guess next to exact money."""
    payload = {
        "itemSummaries": [
            {
                "itemId": "v1|111111111111|0",
                "title": "Sony WH-1000XM5",
                "price": {"value": "249.00", "currency": "USD"},
            }
        ]
    }
    ebay, _ = provider({"item_summary/search": payload})
    assert ebay.search_listings("Sony") == []


def test_only_fixed_price_listings_are_searched():
    """An auction has no price until it ends, so it cannot be compared today."""
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE})
    ebay.search_listings("Sony")
    assert "FIXED_PRICE" in str(recorder.requests[-1].url)


def test_an_ean_search_goes_to_the_structured_field():
    """The site cannot find an EAN; the API can, because it indexes gtin."""
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE})
    ebay.find_by_identifier("EAN", "4548736134584")
    assert "gtin=4548736134584" in str(recorder.requests[-1].url)


def test_a_non_product_code_falls_back_to_keywords():
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE})
    ebay.find_by_identifier("ASIN", "B09XS7JWHH")
    url = str(recorder.requests[-1].url)
    assert "q=B09XS7JWHH" in url
    assert "gtin" not in url


def test_market_stats_report_the_median_never_the_highest():
    """The highest asking price is one seller's hope, not a sale price."""
    ebay, _ = provider({"item_summary/search": SEARCH_RESPONSE})
    stats = ebay.get_market_stats(query="Sony WH-1000XM5")

    assert stats.competitor_count == 2
    assert stats.lowest_price.amount == Decimal("279.00")
    assert stats.highest_price.amount == Decimal("299.00")
    assert stats.realistic_sale_price.amount == Decimal("289.00")
    assert stats.realistic_sale_price.amount < stats.highest_price.amount


def test_market_stats_are_empty_rather_than_invented_when_nothing_matches():
    ebay, _ = provider({"item_summary/search": {"itemSummaries": []}})
    stats = ebay.get_market_stats(query="nothing at all")
    assert stats.competitor_count == 0
    assert stats.realistic_sale_price is None


def test_sold_prices_raise_rather_than_fall_back_to_asking_prices():
    """Marketplace Insights needs its own grant. Without it there is no
    sold data, and an asking price labelled "sold" is worse than nothing."""
    ebay, _ = provider({"item_sales/search": 403})
    with pytest.raises(ProviderError) as caught:
        ebay.sold_prices(identifier="4548736134584")
    assert "not enabled for that API" in str(caught.value)


# -- what it refuses to do --------------------------------------------------
@pytest.mark.parametrize(
    "action",
    [
        lambda p: p.publish_listing(
            PublishRequest(
                sku="SKU-1",
                title="Sony WH-1000XM5",
                description="",
                price=Money("279.00", "EUR"),
                quantity=1,
                condition=ProductCondition.NEW,
                idempotency_key="k",
            )
        ),
        lambda p: p.update_listing("1", quantity=0),
        lambda p: p.end_listing("1"),
        lambda p: p.upload_tracking("1", carrier="DHL", tracking_number="1", idempotency_key="k"),
    ],
)
def test_browse_cannot_sell(action):
    """Browse is a public read API. Selling is a different API and a
    different token, so these fail loudly instead of appearing to work."""
    ebay, _ = provider({})
    with pytest.raises(ProviderError) as caught:
        action(ebay)
    assert "Sell API" in str(caught.value)


def test_no_webhook_is_trusted():
    ebay, _ = provider({})
    assert ebay.verify_webhook(b"{}", "signature") is False


def test_our_own_sales_are_not_visible_to_an_application_token():
    ebay, _ = provider({})
    assert ebay.fetch_sales() == []


# -- failure modes ----------------------------------------------------------
def test_bad_credentials_are_not_retried():
    """Wrong keys cannot be fixed by trying again, and retrying them
    just spends the rate limit."""
    recorder = Recorder({"oauth2/token": 401})
    client = httpx.Client(transport=httpx.MockTransport(recorder))
    ebay = EbayBrowseProvider(client_id="id", client_secret="wrong", client=client)

    with pytest.raises(ProviderError) as caught:
        ebay.search_listings("Sony")
    assert caught.value.retryable is False
    assert "EBAY_CLIENT_ID" in str(caught.value)


def test_a_rate_limit_is_reported_as_one():
    ebay, _ = provider({"item_summary/search": 429})
    with pytest.raises(ProviderRateLimitedError):
        ebay.search_listings("Sony")


def test_the_token_is_fetched_once_and_reused():
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE})
    ebay.search_listings("Sony")
    ebay.search_listings("Sony")
    tokens = [r for r in recorder.requests if "oauth2/token" in r.url.path]
    assert len(tokens) == 1


def test_an_expired_token_is_refreshed_once():
    """A 401 mid-session means the token died early; one retry, not a loop."""
    calls = {"search": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/token" in request.url.path:
            return httpx.Response(200, json=TOKEN_RESPONSE)
        calls["search"] += 1
        if calls["search"] == 1:
            return httpx.Response(401, json={"errors": []})
        return httpx.Response(200, json=SEARCH_RESPONSE)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    ebay = EbayBrowseProvider(
        client_id="id",
        client_secret="secret",
        client=client,
        guard=ProviderGuard(provider="ebay-browse", retry=RetryPolicy(attempts=1)),
    )
    assert len(ebay.search_listings("Sony")) == 2
    assert calls["search"] == 2


def test_sandbox_and_production_are_different_hosts():
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE}, environment="sandbox")
    ebay.search_listings("Sony")
    assert "api.sandbox.ebay.com" in str(recorder.requests[-1].url)

    with pytest.raises(ValueError):
        EbayBrowseProvider(client_id="i", client_secret="s", environment="staging")


def test_the_marketplace_header_is_sent():
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE})
    ebay.search_listings("Sony")
    assert recorder.requests[-1].headers["X-EBAY-C-MARKETPLACE-ID"] == "EBAY_DE"


def test_credentials_are_never_put_in_a_url():
    """A secret in a query string ends up in logs and proxies."""
    ebay, recorder = provider({"item_summary/search": SEARCH_RESPONSE})
    ebay.search_listings("Sony")
    for request in recorder.requests:
        assert "secret" not in str(request.url)
        assert "id=id" not in str(request.url)


# -- wiring -----------------------------------------------------------------
def test_browse_keys_alone_enable_reading_but_not_selling():
    """An application key pair is public read access. It is not a seller
    account, and must never be mistaken for the ability to trade."""
    from app.core.config import Settings

    settings = Settings(ebay_client_id="id", ebay_client_secret="secret")
    assert settings.ebay_browse_configured is True
    assert settings.ebay_credentials_present is False
    # And therefore the system still refuses to leave demo mode.
    assert settings.effective_demo_mode is True


def test_research_mode_prefers_browse_over_the_generic_gateway():
    from app.core.config import Settings
    from app.providers.registry import build_providers

    bundle = build_providers(
        Settings(
            research_mode=True,
            ebay_client_id="id",
            ebay_client_secret="secret",
            ebay_api_base_url="https://gateway.invalid",
        )
    )
    assert "ebay-browse" in bundle.target.name
    # Wrapped, so live data in and no possibility of acting on it.
    assert bundle.is_read_only is True
    assert bundle.target.reads_live_data is True


def test_without_keys_research_mode_says_the_data_is_not_live():
    from app.core.config import Settings
    from app.providers.registry import build_providers

    bundle = build_providers(Settings(research_mode=True))
    assert bundle.target.reads_live_data is False
    assert bundle.demo_mode is True
