"""Scanning eBay for candidates, and what the scan refuses to claim."""

from __future__ import annotations

import httpx

from app.core.money import Money
from app.providers.ebay.browse import EbayBrowseProvider
from app.providers.readonly import ReadOnlyTargetProvider
from app.providers.registry import ProviderBundle
from app.services.discovery_service import DiscoveryService, _median
from tests.test_ebay_browse import TOKEN_RESPONSE

EUR = "EUR"


def summary(item_id: str, price: str, *, epid: str | None = None, title: str = "Sony WH-1000XM5"):
    return {
        "itemId": f"v1|{item_id}|0",
        "title": title,
        "price": {"value": price, "currency": "EUR"},
        "shippingOptions": [{"shippingCost": {"value": "0.00", "currency": "EUR"}}],
        "conditionId": "1000",
        "itemWebUrl": f"https://www.ebay.de/itm/{item_id}",
        "seller": {"username": f"seller-{item_id}"},
        **({"epid": epid} if epid else {}),
    }


def detail(item_id: str, ean: str = "4548736134584"):
    return {
        "itemId": f"v1|{item_id}|0",
        "legacyItemId": item_id,
        "title": "Sony WH-1000XM5",
        "price": {"value": "300.00", "currency": "EUR"},
        "conditionId": "1000",
        "brand": "Sony",
        "mpn": "WH1000XM5B",
        "ean": [ean],
    }


def make(search_payload, *, detail_payload=None, config=None):
    """A discovery service over a scripted eBay."""
    calls = {"search": 0, "detail": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/token" in request.url.path:
            return httpx.Response(200, json=TOKEN_RESPONSE)
        if "item_summary/search" in request.url.path:
            calls["search"] += 1
            payload = (
                search_payload(calls["search"])
                if callable(search_payload)
                else search_payload
            )
            return httpx.Response(200, json=payload)
        calls["detail"] += 1
        return httpx.Response(200, json=detail_payload or detail("123456789012"))

    from app.providers.resilience import ProviderGuard, RetryPolicy
    from app.services.settings_service import BusinessConfig

    browse = EbayBrowseProvider(
        client_id="id",
        client_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        guard=ProviderGuard(provider="ebay-browse", retry=RetryPolicy(attempts=1)),
    )
    bundle = ProviderBundle(
        source=None,
        target=ReadOnlyTargetProvider(browse),
        fulfillment=None,
        shipping=None,
        execution_mode=None,
        demo_mode=False,
    )
    return DiscoveryService(None, config or BusinessConfig(), bundle), calls


# -- the shape of the answer -------------------------------------------------
def test_a_scan_returns_products_with_a_maximum_amazon_price():
    """The point of the whole thing: one number to compare on Amazon."""
    service, _ = make(
        {"itemSummaries": [summary("1" * 12, "300.00", epid="E1"),
                           summary("2" * 12, "320.00", epid="E1"),
                           summary("3" * 12, "310.00", epid="E1")]}
    )
    result = service.scan(category_ids=["9355"])

    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.listing_count == 3
    # The median, not the highest: 310, not 320.
    assert candidate.ebay_price == Money("310.00", EUR)
    assert candidate.max_amazon_price is not None
    assert candidate.max_amazon_price.amount < candidate.ebay_price.amount
    assert candidate.item_url == "https://www.ebay.de/itm/333333333333"


def test_the_product_code_comes_from_the_detail_lookup():
    """It is what lets the matcher later confirm an Amazon offer is the same
    thing, rather than a similar-sounding one."""
    service, _ = make(
        {"itemSummaries": [summary("1" * 12, "300.00", epid="E1"),
                           summary("2" * 12, "320.00", epid="E1")]}
    )
    candidate = service.scan(category_ids=["9355"]).candidates[0]
    assert candidate.ean == "4548736134584"
    assert candidate.brand == "Sony"


# -- what it will not claim --------------------------------------------------
def test_a_product_with_one_listing_is_left_out():
    """One asking price is not evidence of what something sells for."""
    service, _ = make({"itemSummaries": [summary("1" * 12, "300.00", epid="ONLY")]})
    result = service.scan(category_ids=["9355"])

    assert result.candidates == []
    assert result.products_found == 1
    assert any("only one listing" in note for note in result.notes)


def test_the_price_is_never_the_highest_listing():
    assert _median([Money("10", EUR), Money("20", EUR), Money("99", EUR)]) == Money("20", EUR)
    # An even count averages the middle two rather than rounding up to the pair.
    assert _median([Money("10", EUR), Money("21", EUR)]) == Money("15.50", EUR)


def test_a_sale_price_too_low_to_work_says_so_instead_of_guessing():
    service, _ = make(
        {"itemSummaries": [summary("1" * 12, "8.00", epid="E1"),
                           summary("2" * 12, "9.00", epid="E1")]}
    )
    candidate = service.scan(category_ids=["9355"]).candidates[0]
    assert candidate.max_amazon_price is None
    assert "at any purchase price" in candidate.impossible_reason


def test_no_amazon_price_is_ever_invented():
    """The scan has no Amazon data source. It must produce a worklist, not a
    profit figure that looks researched."""
    service, _ = make(
        {"itemSummaries": [summary("1" * 12, "300.00", epid="E1"),
                           summary("2" * 12, "320.00", epid="E1")]}
    )
    candidate = service.scan(category_ids=["9355"]).candidates[0]
    assert not hasattr(candidate, "amazon_price")
    assert not hasattr(candidate, "net_profit")
    # Only a link to go and look it up yourself.
    assert "amazon" in candidate.amazon_search_url


# -- staying inside the call budget ------------------------------------------
def test_one_lookup_per_product_not_per_listing():
    """Twenty listings of one product cost one detail call, not twenty."""
    service, calls = make(
        {"itemSummaries": [summary(f"{i:012d}", "300.00", epid="SAME") for i in range(20)]}
    )
    result = service.scan(category_ids=["9355"])

    assert result.listings_seen == 20
    assert result.products_found == 1
    assert calls["detail"] == 1


def test_the_lookup_budget_is_respected_and_reported():
    listings = [
        summary(f"{i:012d}", "300.00", epid=f"E{i // 2}") for i in range(20)
    ]  # ten products, two listings each
    service, calls = make({"itemSummaries": listings})
    result = service.scan(category_ids=["9355"], detail_budget=3)

    assert calls["detail"] == 3
    assert len(result.candidates) == 3
    assert any("stay inside the eBay call budget" in note for note in result.notes)


def test_paging_stops_at_a_short_page():
    """A page under the maximum is the last one; asking for more wastes calls."""
    service, calls = make({"itemSummaries": [summary("1" * 12, "300.00", epid="E1")]})
    service.scan(category_ids=["9355"], pages=5)
    assert calls["search"] == 1


# -- availability ------------------------------------------------------------
def test_without_ebay_keys_the_scan_explains_itself():
    from app.core.config import Settings
    from app.providers.registry import build_providers
    from app.services.settings_service import BusinessConfig

    bundle = build_providers(Settings(research_mode=True))
    service = DiscoveryService(None, BusinessConfig(), bundle)

    possible, reason = service.can_scan()
    assert possible is False
    assert "EBAY_CLIENT_ID" in reason

    result = service.scan(category_ids=["9355"])
    assert result.candidates == []
    assert any("EBAY_CLIENT_ID" in note for note in result.notes)


def test_a_scan_with_no_category_and_no_query_is_refused():
    """Scanning "everything" is not a request that can be honoured, and
    papering over it with a wildcard would burn the call budget."""
    service, _ = make({"itemSummaries": []})
    result = service.scan()
    assert result.candidates == []
    assert any("needs a category" in note for note in result.notes)


def test_the_price_band_defaults_to_what_may_actually_be_spent():
    """A 900 EUR listing is not a candidate under a 400 EUR per-order limit."""
    def handler(page):
        return {"itemSummaries": []}

    service, _ = make(handler)
    captured = []
    inner = service.providers.target.inner
    original = inner.scan_listings

    def spy(**kwargs):
        captured.append(kwargs)
        return original(**kwargs)

    inner.scan_listings = spy
    service.scan(category_ids=["9355"])
    assert captured[0]["max_price"] == service.config.max_capital_per_order
