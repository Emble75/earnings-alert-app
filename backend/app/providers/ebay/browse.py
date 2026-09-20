"""eBay Browse API - real listings, read-only.

Two things make this adapter worth having over the generic HTTP gateway.

The first is that it addresses **one specific listing**. Every result carries
eBay's item number, so a price that went into a calculation can be traced back
to the offer it came from, today and in a month.

The second is that the API can be searched by GTIN, which the eBay *website*
cannot. Typing an EAN into ebay.de returns nothing, because sellers do not put
the number in the listing title and the site searches titles. The API indexes
the structured field instead, so ``find_by_identifier`` is a real lookup rather
than a hopeful keyword search - and an EAN that comes back from eBay's own
catalogue is evidence the matcher can use.

What this adapter deliberately does **not** do is sell. Listing, revising and
uploading tracking are Sell API calls that need a user-consent token, not the
application token used here. Those methods raise rather than pretend, which is
also why this provider is safe to point at live credentials in research mode.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx

from app.core.clock import utcnow
from app.core.errors import ProviderError, ProviderRateLimitedError
from app.core.logging import get_logger
from app.core.money import Money
from app.models.enums import ProductCondition
from app.providers.base import (
    ListingSnapshot,
    MarketStats,
    PublishRequest,
    PublishResult,
    SaleEvent,
    TargetMarketplaceProvider,
)
from app.providers.resilience import ProviderGuard, RateLimit

logger = get_logger(__name__)

#: eBay runs two completely separate worlds. Sandbox keys are issued
#: immediately; production keys wait for the account to be verified.
ENVIRONMENTS = {
    "production": ("https://api.ebay.com", "https://api.ebay.com/identity/v1/oauth2/token"),
    "sandbox": (
        "https://api.sandbox.ebay.com",
        "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
    ),
}

#: The only scope an application token can hold. It grants public read access
#: and nothing else - it cannot list, sell, or see another seller's account.
PUBLIC_SCOPE = "https://api.ebay.com/oauth/api_scope"

#: eBay's condition ids, which are stable across marketplaces and languages -
#: unlike ``conditionDisplayName``, which arrives translated.
_CONDITIONS = {
    "1000": ProductCondition.NEW,
    "1500": ProductCondition.NEW_OTHER,     # open box
    "1750": ProductCondition.NEW_OTHER,     # new with defects
    "2000": ProductCondition.REFURBISHED,
    "2010": ProductCondition.REFURBISHED,
    "2020": ProductCondition.REFURBISHED,
    "2030": ProductCondition.REFURBISHED,
    "2500": ProductCondition.REFURBISHED,
    "3000": ProductCondition.USED,
    "4000": ProductCondition.USED,
    "5000": ProductCondition.USED,
    "6000": ProductCondition.USED,
    "7000": ProductCondition.DAMAGED,       # for parts or not working
}

#: The default Browse quota is a few thousand calls a day. Pacing to five a
#: second keeps a burst from spending a chunk of it in one loop.
_DEFAULT_RATE = RateLimit(max_calls=5, per_seconds=1.0)


def _condition(payload: dict[str, Any]) -> ProductCondition:
    return _CONDITIONS.get(str(payload.get("conditionId") or ""), ProductCondition.UNKNOWN)


def legacy_item_id(item_id: str | None) -> str | None:
    """The plain item number behind eBay's RESTful id.

    ``v1|123456789012|0`` is what the API returns; ``123456789012`` is what
    appears in an ``/itm/`` address and on the listing page. The third field is
    the variation, which is 0 for a listing without variations.
    """
    if not item_id:
        return None
    parts = item_id.split("|")
    if len(parts) >= 2 and parts[1].isdigit():
        return parts[1]
    return item_id if item_id.isdigit() else None


class EbayOAuth:
    """Application token, cached until shortly before it expires.

    The client-credentials grant needs no user interaction and yields a token
    that can only read public data. It lasts two hours; a token is re-used
    until a minute before expiry rather than fetched per call.
    """

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        token_url: str,
        client: httpx.Client,
        scope: str = PUBLIC_SCOPE,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._token_url = token_url
        self._client = client
        self._scope = scope
        self._token: str | None = None
        self._expires_at: datetime | None = None

    def invalidate(self) -> None:
        self._token = None
        self._expires_at = None

    def token(self) -> str:
        now = utcnow()
        if self._token and self._expires_at and now < self._expires_at:
            return self._token

        basic = base64.b64encode(
            f"{self._client_id}:{self._client_secret}".encode()
        ).decode()
        try:
            response = self._client.post(
                self._token_url,
                headers={
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "client_credentials", "scope": self._scope},
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"eBay token request failed: {exc}") from exc

        if response.status_code in (400, 401):
            # Wrong keys are a configuration problem, not a transient one:
            # retrying cannot fix them, so this must not be retryable.
            error = ProviderError(
                "eBay rejected the application credentials. Check EBAY_CLIENT_ID and "
                "EBAY_CLIENT_SECRET, and that they are for the same environment as "
                "EBAY_ENVIRONMENT (sandbox keys do not work against production)."
            )
            error.retryable = False
            raise error
        if response.status_code >= 400:
            raise ProviderError(f"eBay token request failed with HTTP {response.status_code}")

        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise ProviderError("eBay returned no access token")
        # A minute of headroom: a token that expires mid-request is a 401 that
        # costs a retry.
        lifetime = int(payload.get("expires_in") or 7200)
        self._token = token
        self._expires_at = now + timedelta(seconds=max(lifetime - 60, 60))
        return token


class EbayBrowseProvider(TargetMarketplaceProvider):
    """Read-only access to live eBay listings."""

    name = "ebay-browse"
    is_live = True

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        currency: str = "EUR",
        marketplace: str = "EBAY_DE",
        environment: str = "production",
        client: httpx.Client | None = None,
        guard: ProviderGuard | None = None,
        timeout: float = 15.0,
    ) -> None:
        if environment not in ENVIRONMENTS:
            raise ValueError(
                f"unknown eBay environment {environment!r}; expected one of "
                f"{sorted(ENVIRONMENTS)}"
            )
        base_url, token_url = ENVIRONMENTS[environment]
        self.currency = currency
        self.marketplace = marketplace
        self.environment = environment
        self._base_url = base_url
        self._client = client or httpx.Client(timeout=timeout)
        self._oauth = EbayOAuth(
            client_id=client_id,
            client_secret=client_secret,
            token_url=token_url,
            client=self._client,
        )
        self._guard = guard or ProviderGuard(provider=self.name, rate_limit=_DEFAULT_RATE)

    def health(self) -> dict[str, Any]:
        """Configuration, not a live probe.

        Health is polled; an OAuth round trip on every poll would spend the
        daily call budget on answering "are you configured". Whether the keys
        actually work shows up on the first search, with eBay's own reason.
        """
        return {
            "provider": self.name,
            "status": "HEALTHY",
            "live": True,
            "environment": self.environment,
            "marketplace": self.marketplace,
            "can_sell": False,
            "note": "public read access only; listing and tracking need a Sell API token",
        }

    # -- transport ----------------------------------------------------------
    def _request(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        def call() -> dict[str, Any]:
            return self._get(path, params)

        return self._guard.call(path, call)

    def _get(self, path: str, params: dict[str, Any], *, retry_auth: bool = True) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self._oauth.token()}",
            "X-EBAY-C-MARKETPLACE-ID": self.marketplace,
            "Accept": "application/json",
        }
        try:
            response = self._client.get(
                f"{self._base_url}{path}", params=params, headers=headers
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"eBay request to {path} failed: {exc}") from exc

        if response.status_code == 401 and retry_auth:
            # The token expired earlier than advertised. One fresh attempt.
            self._oauth.invalidate()
            return self._get(path, params, retry_auth=False)
        if response.status_code == 429:
            raise ProviderRateLimitedError("eBay rate limit reached")
        if response.status_code == 403:
            raise self._forbidden(path, response)
        if response.status_code == 404:
            return {}
        if response.status_code >= 400:
            raise ProviderError(
                f"eBay returned HTTP {response.status_code} for {path}: "
                f"{response.text[:200]}"
            )
        return response.json()

    def _forbidden(self, path: str, response: httpx.Response) -> ProviderError:
        """A 403 from eBay is almost always a missing grant, not a bad request."""
        error = ProviderError(
            f"eBay refused access to {path}. This usually means the keyset is not "
            "enabled for that API, or the application is still pending review."
        )
        error.retryable = False
        return error

    # -- parsing ------------------------------------------------------------
    def _money(self, block: Any) -> Money | None:
        """Money straight from eBay, or nothing.

        A listing priced in another currency is not converted here. Inventing a
        rate would put a number the engine treats as exact next to one that is
        a guess, so the price is dropped and the listing is unusable for
        pricing - which is the truth.
        """
        if not isinstance(block, dict):
            return None
        value = block.get("value")
        currency = block.get("currency")
        if value in (None, "") or currency != self.currency:
            return None
        return Money(str(value), self.currency)

    def _shipping(self, payload: dict[str, Any]) -> Money:
        options = payload.get("shippingOptions") or []
        for option in options:
            cost = self._money(option.get("shippingCost"))
            if cost is not None:
                return cost
        return Money("0", self.currency)

    def _identifiers(self, payload: dict[str, Any]) -> dict[str, str]:
        """The structured product codes eBay holds for a listing.

        These are what let the matcher confirm that an eBay listing and an
        Amazon offer are the same physical item. They are only present when
        the seller filled them in, which is exactly why the matcher treats a
        missing one as missing evidence rather than as agreement.
        """
        identifiers: dict[str, str] = {}
        for key, name in (("ean", "EAN"), ("gtin", "GTIN"), ("upc", "UPC"), ("isbn", "ISBN")):
            value = payload.get(key)
            if isinstance(value, list):
                value = value[0] if value else None
            if value:
                identifiers[name] = str(value).strip()
        mpn = payload.get("mpn")
        if mpn:
            identifiers["MPN"] = str(mpn).strip()
        epid = payload.get("epid")
        if epid:
            identifiers["EPID"] = str(epid).strip()
        return identifiers

    def _snapshot(self, payload: dict[str, Any], *, observed_at: datetime) -> ListingSnapshot:
        item_id = str(payload.get("itemId") or "")
        legacy = str(payload.get("legacyItemId") or "") or legacy_item_id(item_id)
        seller = payload.get("seller") or {}
        categories = payload.get("categories") or []
        category_id = None
        if categories and isinstance(categories[0], dict):
            category_id = categories[0].get("categoryId")

        return ListingSnapshot(
            # The legacy number is the one that appears in an /itm/ address,
            # so it is what the rest of the system stores and links back to.
            external_id=legacy or item_id,
            title=str(payload.get("title") or "").strip(),
            price=self._money(payload.get("price")),
            shipping_price=self._shipping(payload),
            observed_at=observed_at,
            identifiers=self._identifiers(payload),
            brand=(payload.get("brand") or None),
            model=(payload.get("mpn") or None),
            condition=_condition(payload),
            seller_id=(seller.get("username") or None),
            quantity=int(payload.get("estimatedAvailableQuantity") or 1),
            sold_quantity=(
                int(payload["estimatedSoldQuantity"])
                if str(payload.get("estimatedSoldQuantity") or "").isdigit()
                else None
            ),
            category_id=str(category_id) if category_id else None,
            url=(payload.get("itemWebUrl") or None),
            attributes={
                "item_id": item_id,
                "legacy_item_id": legacy,
                # eBay's own catalogue id, present on summaries for matched
                # listings. Grouping on it turns many listings of one product
                # into one product, which is what makes a scan affordable.
                "epid": payload.get("epid"),
                "condition_id": payload.get("conditionId"),
                "buying_options": payload.get("buyingOptions") or [],
                "seller_feedback_percentage": (seller.get("feedbackPercentage") or None),
                "seller_feedback_score": (seller.get("feedbackScore") or None),
                "item_location": (payload.get("itemLocation") or {}).get("country"),
                "marketplace": self.marketplace,
            },
            raw=payload,
        )

    # -- reads --------------------------------------------------------------
    def _search(self, params: dict[str, Any], *, limit: int) -> list[ListingSnapshot]:
        payload = self._request(
            "/buy/browse/v1/item_summary/search",
            {
                **params,
                "limit": max(1, min(limit, 200)),
                # Auctions have no price until they end. Only a fixed price is
                # a number we can compare against an Amazon price today.
                "filter": "buyingOptions:{FIXED_PRICE}",
            },
        )
        observed_at = utcnow()
        items = payload.get("itemSummaries") or []
        snapshots = [self._snapshot(item, observed_at=observed_at) for item in items]
        # A listing with no usable price cannot be priced against. Dropping it
        # here keeps "no price" out of the statistics below.
        return [s for s in snapshots if s.price is not None]

    def scan_listings(
        self,
        *,
        category_ids: list[str] | None = None,
        query: str = "",
        min_price: Decimal | None = None,
        max_price: Decimal | None = None,
        condition: str = "NEW",
        offset: int = 0,
        limit: int = 200,
    ) -> list[ListingSnapshot]:
        """A page of listings from a whole category, rather than one search.

        This is the discovery entry point. One call returns up to 200 real
        listings, which is what makes scanning a category affordable against a
        daily call budget - the per-item detail lookups are the expensive part
        and are rationed separately.

        A price band is not a nicety. Below a few euros nothing survives the
        fees, and the upper bound is the operator's capital limit; filtering at
        eBay's end rather than ours means the budget is spent on candidates
        that could actually qualify.
        """
        filters = ["buyingOptions:{FIXED_PRICE}"]
        if condition:
            filters.append(f"conditions:{{{condition}}}")
        if min_price is not None or max_price is not None:
            low = "" if min_price is None else f"{min_price}"
            high = "" if max_price is None else f"{max_price}"
            filters.append(f"price:[{low}..{high}]")
            filters.append(f"priceCurrency:{self.currency}")

        params: dict[str, Any] = {
            "limit": max(1, min(limit, 200)),
            "offset": max(0, offset),
            "filter": ",".join(filters),
        }
        if category_ids:
            params["category_ids"] = ",".join(category_ids)
        if query.strip():
            params["q"] = query.strip()
        if not category_ids and not query.strip():
            # eBay rejects a filter-only search, and a scan of everything is
            # not something to paper over with a wildcard.
            raise ValueError("a scan needs a category or a search term")

        payload = self._request("/buy/browse/v1/item_summary/search", params)
        observed_at = utcnow()
        snapshots = [
            self._snapshot(item, observed_at=observed_at)
            for item in (payload.get("itemSummaries") or [])
        ]
        return [s for s in snapshots if s.price is not None]

    def search_listings(self, query: str, *, limit: int = 20) -> list[ListingSnapshot]:
        query = (query or "").strip()
        if not query:
            return []
        return self._search({"q": query}, limit=limit)

    def find_by_identifier(self, identifier_type: str, value: str) -> list[ListingSnapshot]:
        """Look a product up by its product code.

        ``gtin`` searches eBay's structured field, so unlike the website this
        actually finds listings by EAN. Anything that is not a GTIN falls back
        to a keyword search, which is weaker evidence and is treated as such by
        the matcher.
        """
        value = (value or "").strip()
        if not value:
            return []
        kind = (identifier_type or "").upper()
        if kind in ("EAN", "GTIN", "UPC", "ISBN"):
            return self._search({"gtin": value}, limit=50)
        if kind == "EPID":
            return self._search({"epid": value}, limit=50)
        return self.search_listings(value, limit=50)

    def get_listing_status(self, external_id: str) -> ListingSnapshot | None:
        """One specific listing, by item number.

        The detail endpoint returns the structured product codes that the
        search results omit, which is why a candidate found by search is
        re-fetched before it is trusted as a match.
        """
        external_id = (external_id or "").strip()
        if not external_id:
            return None
        path = (
            "/buy/browse/v1/item/get_item_by_legacy_id"
            if external_id.isdigit()
            else f"/buy/browse/v1/item/{external_id}"
        )
        params = {"legacy_item_id": external_id} if external_id.isdigit() else {}
        payload = self._request(path, params)
        if not payload:
            return None
        return self._snapshot(payload, observed_at=utcnow())

    def get_market_stats(
        self, *, identifier: str | None = None, query: str | None = None
    ) -> MarketStats:
        """What the competition currently asks.

        These are *asking* prices. What the thing has actually sold for is a
        different question, answered by the Marketplace Insights API, which
        needs a separate grant from eBay - see :meth:`sold_prices`.
        """
        if identifier:
            listings = self.find_by_identifier("EAN", identifier)
        elif query:
            listings = self.search_listings(query, limit=50)
        else:
            listings = []

        prices = sorted(
            (listing.price for listing in listings if listing.price is not None),
            key=lambda money: money.amount,
        )
        observed_at = utcnow()
        if not prices:
            return MarketStats(
                observed_at=observed_at,
                competitor_count=0,
                seller_count=0,
                lowest_price=None,
                median_price=None,
                highest_price=None,
                realistic_sale_price=None,
            )

        middle = len(prices) // 2
        median = (
            prices[middle]
            if len(prices) % 2 == 1
            else Money(
                ((prices[middle - 1].amount + prices[middle].amount) / Decimal(2)),
                self.currency,
            )
        )
        sellers = {listing.seller_id for listing in listings if listing.seller_id}
        return MarketStats(
            observed_at=observed_at,
            competitor_count=len(prices),
            seller_count=len(sellers) or len(prices),
            lowest_price=prices[0],
            median_price=median,
            highest_price=prices[-1],
            # The median, never the highest. The highest asking price is one
            # seller's hope; pricing a purchase on it is how a calculation
            # turns out wrong after the money is spent.
            realistic_sale_price=median,
            distribution={"sample_size": len(prices), "source": "ebay-browse-asking-prices"},
        )

    def sold_prices(self, *, identifier: str | None = None, query: str | None = None) -> list[Money]:
        """What buyers actually paid, if eBay has granted access to it.

        Marketplace Insights is a restricted API: a keyset has to be approved
        for it individually. Without that approval this raises, and the caller
        reports that sold data is unavailable. It does not fall back to asking
        prices, because a number labelled "sold" that is really an asking price
        is worse than no number at all.
        """
        if identifier:
            params: dict[str, Any] = {"gtin": identifier}
        elif query:
            params = {"q": query}
        else:
            return []
        payload = self._request(
            "/buy/marketplace_insights/v1_beta/item_sales/search", {**params, "limit": 50}
        )
        sales = payload.get("itemSales") or []
        prices = []
        for sale in sales:
            price = self._money(sale.get("lastSoldPrice") or sale.get("price"))
            if price is not None:
                prices.append(price)
        return prices

    def fetch_sales(self, *, since: datetime | None = None) -> list[SaleEvent]:
        """Our own sales - which an application token cannot see.

        This is the Fulfillment API and needs a user token, so there is nothing
        honest to return here. An empty list is correct rather than misleading:
        this provider never listed anything, so nothing of ours can have sold.
        """
        return []

    # -- writes: not possible with an application token ---------------------
    def _read_only(self, action: str) -> ProviderError:
        error = ProviderError(
            f"the eBay Browse API cannot {action}. Browse is a public read API; "
            "listing, revising and tracking are Sell APIs and need a user-consent "
            "token from your own seller account."
        )
        error.retryable = False
        return error

    def publish_listing(self, request: PublishRequest) -> PublishResult:
        raise self._read_only("publish a listing")

    def update_listing(
        self, external_id: str, *, price: Money | None = None, quantity: int | None = None
    ) -> PublishResult:
        raise self._read_only("update a listing")

    def end_listing(self, external_id: str, *, reason: str = "") -> PublishResult:
        raise self._read_only("end a listing")

    def upload_tracking(
        self,
        external_order_id: str,
        *,
        carrier: str,
        tracking_number: str,
        idempotency_key: str,
    ) -> bool:
        raise self._read_only("upload tracking")

    def verify_webhook(self, payload: bytes, signature: str | None) -> bool:
        """No webhook can be trusted here.

        Browse does not send notifications, so anything arriving claiming to be
        one did not come from this integration.
        """
        return False
