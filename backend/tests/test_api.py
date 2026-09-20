"""API tests: auth, authorisation, filtering, and the approval endpoint."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.security import hash_password
from app.models.enums import UserRole
from app.models.user import User


@pytest.fixture
def auth(api_client, engine):
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = factory()
    for email, role in (("admin@example.com", UserRole.ADMIN), ("viewer@example.com", UserRole.VIEWER)):
        if session.query(User).filter_by(email=email).first() is None:
            session.add(
                User(email=email, hashed_password=hash_password("test-password"), role=role)
            )
    session.commit()
    session.close()

    def _headers(email: str = "admin@example.com") -> dict[str, str]:
        response = api_client.post(
            "/api/auth/login", json={"email": email, "password": "test-password"}
        )
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    return _headers


def test_health_is_public_and_reports_the_mode(api_client):
    response = api_client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["demo_mode"] is True
    assert body["model_versions"]["profit"]
    assert body["providers"]["execution_mode"] == "DEMO"


def test_protected_endpoints_require_a_token(api_client):
    assert api_client.get("/api/opportunities").status_code == 401
    assert api_client.get("/api/orders").status_code == 401
    assert api_client.get("/api/settings").status_code == 401


def test_a_wrong_password_is_rejected_without_revealing_the_reason(api_client, auth):
    response = api_client.post(
        "/api/auth/login", json={"email": "admin@example.com", "password": "nope"}
    )
    assert response.status_code == 401
    assert response.json()["error"]["message"] == "invalid email or password"

    unknown = api_client.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": "nope"}
    )
    assert unknown.json()["error"]["message"] == response.json()["error"]["message"]


def test_a_viewer_cannot_change_anything(api_client, auth):
    headers = auth("viewer@example.com")
    assert api_client.get("/api/opportunities", headers=headers).status_code == 200
    assert (
        api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers).status_code
        == 403
    )


def test_only_an_admin_can_change_the_business_rules(api_client, auth):
    body = {"updates": {"minimum_net_profit": "50.00"}}
    assert api_client.put("/api/settings", json=body, headers=auth("viewer@example.com")).status_code == 403
    response = api_client.put("/api/settings", json=body, headers=auth())
    assert response.status_code == 200
    assert response.json()["values"]["minimum_net_profit"] == "50.00"


def test_an_unknown_setting_is_refused(api_client, auth):
    response = api_client.put(
        "/api/settings", json={"updates": {"make_me_rich": True}}, headers=auth()
    )
    assert response.status_code == 422
    assert "unknown setting" in response.json()["error"]["message"]


def test_an_invalid_setting_value_is_refused(api_client, auth):
    response = api_client.put(
        "/api/settings", json={"updates": {"maximum_risk_score": 500}}, headers=auth()
    )
    assert response.status_code == 422


def test_discovery_then_default_filtering(api_client, auth):
    headers = auth()
    discovered = api_client.post(
        "/api/opportunities/discover", json={"query": "", "limit": 20}, headers=headers
    )
    assert discovered.status_code == 200
    assert len(discovered.json()) == 10

    listed = api_client.get("/api/opportunities", headers=headers).json()
    # The default view applies the configured thresholds.
    assert listed["total"] < 10
    for item in listed["items"]:
        assert Decimal(item["expected_net_profit"]) >= Decimal("20.00")
        assert Decimal(item["profit_margin"]) >= Decimal("0.15")
        assert item["risk_score"] <= 35


def test_filters_can_be_relaxed_explicitly(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    relaxed = api_client.get(
        "/api/opportunities",
        params={"apply_defaults": False, "state": ["REJECTED", "BLOCKED"]},
        headers=headers,
    ).json()
    assert relaxed["total"] > 0


def test_money_is_serialised_as_a_string_not_a_float(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    item = api_client.get("/api/opportunities", headers=headers).json()["items"][0]
    assert isinstance(item["expected_net_profit"], str)
    assert isinstance(item["source_price"], str)


def test_opportunity_detail_includes_scenarios_and_freshness(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    item = api_client.get("/api/opportunities", headers=headers).json()["items"][0]
    detail = api_client.get(f"/api/opportunities/{item['id']}", headers=headers).json()
    scenarios = {c["scenario"] for c in detail["profit_calculations"]}
    assert scenarios == {"BEST_CASE", "BASE_CASE", "WORST_CASE"}
    assert detail["risk_assessments"][0]["factors"]
    assert detail["staleness"] == []


def test_the_sell_first_path_through_the_api(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    opportunity = api_client.get("/api/opportunities", headers=headers).json()["items"][0]

    candidate = api_client.post(
        "/api/listings", json={"opportunity_id": opportunity["id"]}, headers=headers
    ).json()
    assert Decimal(candidate["recommended_sale_price"]) >= Decimal(candidate["minimum_sale_price"])

    published = api_client.post(
        f"/api/listings/{candidate['listing']['id']}/publish", headers=headers
    ).json()
    assert published["state"] == "PUBLISHED"

    from app.providers.registry import get_providers

    sale = get_providers().target.simulate_sale(listing_external_id=published["external_id"])
    payload = {
        "external_order_id": sale.external_order_id,
        "listing_external_id": sale.listing_external_id,
        "sku": sale.sku,
        "quantity": sale.quantity,
        "sale_price": str(sale.sale_price.amount),
        "buyer_shipping_paid": "0",
        "currency": "EUR",
        "ship_to": sale.ship_to,
    }
    order = api_client.post("/api/webhooks/sales", json=payload).json()
    assert order["state"] == "APPROVAL_REQUIRED"

    duplicate = api_client.post("/api/webhooks/sales", json=payload).json()
    assert duplicate["reference"] == order["reference"]

    pending = api_client.get("/api/orders/pending-approval", headers=headers).json()
    assert len(pending) == 1
    summary = pending[0]["approval_summary"]
    assert summary["can_approve"] is True
    assert summary["costs"]["fulfillment_cost"] == "0.00"

    approved = api_client.post(
        f"/api/orders/{order['id']}/approve", json={"note": "ok"}, headers=headers
    ).json()
    assert approved["state"] == "APPROVED"

    executed = api_client.post(f"/api/orders/{order['id']}/execute", headers=headers).json()
    assert executed["state"] == "SOURCE_PURCHASED"


def test_errors_use_the_structured_body(api_client, auth):
    response = api_client.get("/api/opportunities/999999", headers=auth())
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found"
    assert "message" in error and "retryable" in error


def test_every_response_carries_a_request_id(api_client):
    response = api_client.get("/api/health")
    assert response.headers["X-Request-ID"]


def test_the_audit_log_is_queryable(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    logs = api_client.get(
        "/api/logs", params={"entity_type": "opportunity"}, headers=headers
    ).json()
    assert logs["total"] > 0
    assert logs["items"][0]["action"].startswith("opportunity.")


def test_analytics_and_backtest_endpoints_respond(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    analytics = api_client.get("/api/analytics", headers=headers).json()
    assert "dashboard" in analytics
    assert analytics["dashboard"]["currency"] == "EUR"
    assert analytics["rejection_breakdown"]

    backtest = api_client.get("/api/analytics/backtest", headers=headers).json()
    assert "available" in backtest
    if not backtest["available"]:
        assert "no data will be invented" in backtest["reason"]


def test_risk_endpoint_explains_each_assessment(api_client, auth):
    headers = auth()
    api_client.post("/api/opportunities/discover", json={"query": ""}, headers=headers)
    risk = api_client.get("/api/risk", headers=headers).json()
    assert risk["risk_model_version"]
    assert risk["recent_assessments"]
    assert risk["recent_assessments"][0]["factors"]


def test_the_ebay_lookup_explains_itself_when_no_keys_are_configured(api_client, auth):
    """"Not configured" is a state the operator can fix, so it is reported as
    one - not as a 500 that looks like the system is broken."""
    response = api_client.get("/api/research/ebay?q=sony", headers=auth())
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert "EBAY_CLIENT_ID" in body["reason"]
    assert body["listings"] == []


def test_the_ebay_lookup_returns_real_listings_when_keys_exist(api_client, auth, monkeypatch):
    import httpx

    from app.api import deps
    from app.providers.ebay.browse import EbayBrowseProvider
    from app.providers.readonly import ReadOnlyTargetProvider
    from app.providers.registry import ProviderBundle, get_providers
    from app.providers.resilience import ProviderGuard, RetryPolicy
    from tests.test_ebay_browse import SEARCH_RESPONSE, TOKEN_RESPONSE

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/token" in request.url.path:
            return httpx.Response(200, json=TOKEN_RESPONSE)
        return httpx.Response(200, json=SEARCH_RESPONSE)

    browse = EbayBrowseProvider(
        client_id="id",
        client_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        guard=ProviderGuard(provider="ebay-browse", retry=RetryPolicy(attempts=1)),
    )
    live = get_providers()
    bundle = ProviderBundle(
        source=live.source,
        target=ReadOnlyTargetProvider(browse),
        fulfillment=live.fulfillment,
        shipping=live.shipping,
        execution_mode=live.execution_mode,
        demo_mode=False,
    )
    api_client.app.dependency_overrides[deps.get_provider_bundle] = lambda: bundle
    try:
        response = api_client.get("/api/research/ebay?q=Sony+WH-1000XM5", headers=auth())
    finally:
        api_client.app.dependency_overrides.pop(deps.get_provider_bundle, None)

    body = response.json()
    assert body["available"] is True
    first = body["listings"][0]
    # The item number is what makes this one offer rather than a search.
    assert first["item_id"] == "123456789012"
    assert first["url"] == "https://www.ebay.de/itm/123456789012"
    # Money crosses the API as a string, never a float.
    assert first["price"] == "279.00"
    assert first["total"] == "283.99"


def test_the_scan_endpoint_explains_itself_without_ebay_keys(api_client, auth):
    response = api_client.post(
        "/api/research/scan", json={"query": "kopfhörer"}, headers=auth()
    )
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert "EBAY_CLIENT_ID" in body["notes"][0]
    assert body["candidates"] == []


def test_the_scan_endpoint_returns_a_worklist(api_client, auth, monkeypatch):
    """Each row is a real eBay product plus the Amazon price it must beat -
    and never an Amazon price the system does not have."""
    import httpx

    from app.api import deps
    from app.providers.ebay.browse import EbayBrowseProvider
    from app.providers.readonly import ReadOnlyTargetProvider
    from app.providers.registry import ProviderBundle, get_providers
    from app.providers.resilience import ProviderGuard, RetryPolicy
    from tests.test_discovery import detail, summary
    from tests.test_ebay_browse import TOKEN_RESPONSE

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/token" in request.url.path:
            return httpx.Response(200, json=TOKEN_RESPONSE)
        if "item_summary/search" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "itemSummaries": [
                        summary("111111111111", "300.00", epid="E1"),
                        summary("222222222222", "320.00", epid="E1"),
                        summary("333333333333", "310.00", epid="E1"),
                    ]
                },
            )
        return httpx.Response(200, json=detail("333333333333"))

    browse = EbayBrowseProvider(
        client_id="id",
        client_secret="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        guard=ProviderGuard(provider="ebay-browse", retry=RetryPolicy(attempts=1)),
    )
    live = get_providers()
    bundle = ProviderBundle(
        source=live.source,
        target=ReadOnlyTargetProvider(browse),
        fulfillment=live.fulfillment,
        shipping=live.shipping,
        execution_mode=live.execution_mode,
        demo_mode=False,
    )
    api_client.app.dependency_overrides[deps.get_provider_bundle] = lambda: bundle
    try:
        response = api_client.post(
            "/api/research/scan", json={"query": "kopfhörer"}, headers=auth()
        )
    finally:
        api_client.app.dependency_overrides.pop(deps.get_provider_bundle, None)

    body = response.json()
    assert body["available"] is True
    assert body["listings_seen"] == 3
    assert body["products_found"] == 1

    row = body["candidates"][0]
    assert row["ebay_price"] == "310.00"          # the median, not the 320 high
    assert row["item_url"] == "https://www.ebay.de/itm/333333333333"
    assert row["ean"] == "4548736134584"
    # The number to beat, as an exact decimal string.
    assert Decimal(row["max_amazon_price"]) < Decimal(row["ebay_price"])
    assert row["headroom_percent"] is not None
