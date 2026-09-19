"""Read-only provider wrappers for research mode.

Research mode exists to answer one question with real market data: *which
opportunities would this system act on?* - without it being able to act.

The guarantee is structural rather than procedural. These wrappers delegate
every read to the wrapped provider and replace every write with a raised
:class:`ResearchModeError`. There is no flag to pass, no argument to override
and no code path that reaches ``purchase()``: the method that would spend
money is not connected to anything that can.

This is the outermost of three independent defences. The services check the
mode before they act, and the compliance layer blocks the action. Any one of
them alone would do; all three are here because the failure being prevented is
spending real money by accident.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.core.errors import AppError
from app.core.logging import get_logger
from app.providers.base import (
    ListingSnapshot,
    MarketStats,
    OfferSnapshot,
    PublishRequest,
    PublishResult,
    PurchaseRequest,
    PurchaseResult,
    SaleEvent,
    SourceProvider,
    TargetMarketplaceProvider,
)

logger = get_logger(__name__)


class ResearchModeError(AppError):
    """Raised whenever research mode is asked to change the outside world."""

    code = "research_mode_read_only"
    http_status = 409

    def __init__(self, action: str) -> None:
        super().__init__(
            f"research mode is read-only: {action} is disabled. "
            "Turn research mode off in Settings to enable it.",
            context={"attempted_action": action},
        )


class ReadOnlySourceProvider(SourceProvider):
    """A source provider that can look but cannot buy."""

    is_live = False

    def __init__(self, inner: SourceProvider) -> None:
        self._inner = inner
        self.name = f"{inner.name}-readonly"

    @property
    def inner(self) -> SourceProvider:
        return self._inner

    @property
    def reads_live_data(self) -> bool:
        """Whether what comes back is the real marketplace.

        Distinct from :attr:`is_live`, which is always ``False`` here and means
        "may act". Research mode over real credentials reads live data and can
        do nothing with it - that is the whole point - so a caller asking "are
        these real listings?" must not be answered with "can you buy them?".
        """
        return bool(getattr(self._inner, "is_live", False))

    # -- reads pass straight through ---------------------------------------
    def health(self) -> dict[str, Any]:
        return {**self._inner.health(), "read_only": True}

    def search(self, query: str, *, limit: int = 20) -> list[OfferSnapshot]:
        return self._inner.search(query, limit=limit)

    def get_offer(self, external_id: str) -> OfferSnapshot | None:
        return self._inner.get_offer(external_id)

    def get_offers(self, external_ids: list[str]) -> list[OfferSnapshot]:
        return self._inner.get_offers(external_ids)

    def find_by_identifier(self, identifier_type: str, value: str) -> list[OfferSnapshot]:
        return self._inner.find_by_identifier(identifier_type, value)

    # -- the write is not wired to anything --------------------------------
    def purchase(self, request: PurchaseRequest) -> PurchaseResult:
        logger.warning(
            "research_mode_blocked",
            action="purchase",
            offer=request.offer_external_id,
            quantity=request.quantity,
        )
        raise ResearchModeError("purchasing from the source marketplace")


class ReadOnlyTargetProvider(TargetMarketplaceProvider):
    """A target provider that can observe the market but cannot list on it."""

    is_live = False

    def __init__(self, inner: TargetMarketplaceProvider) -> None:
        self._inner = inner
        self.name = f"{inner.name}-readonly"

    @property
    def inner(self) -> TargetMarketplaceProvider:
        return self._inner

    @property
    def reads_live_data(self) -> bool:
        """See :attr:`ReadOnlySourceProvider.reads_live_data`."""
        return bool(getattr(self._inner, "is_live", False))

    # -- reads --------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        return {**self._inner.health(), "read_only": True}

    def search_listings(self, query: str, *, limit: int = 20) -> list[ListingSnapshot]:
        return self._inner.search_listings(query, limit=limit)

    def find_by_identifier(self, identifier_type: str, value: str) -> list[ListingSnapshot]:
        return self._inner.find_by_identifier(identifier_type, value)

    def get_market_stats(
        self, *, identifier: str | None = None, query: str | None = None
    ) -> MarketStats:
        return self._inner.get_market_stats(identifier=identifier, query=query)

    def get_listing_status(self, external_id: str) -> ListingSnapshot | None:
        return self._inner.get_listing_status(external_id)

    def fetch_sales(self, *, since: datetime | None = None) -> list[SaleEvent]:
        # Reading sales is harmless, but in research mode there are no listings
        # of ours to sell, so this is always empty in practice.
        return self._inner.fetch_sales(since=since)

    def verify_webhook(self, payload: bytes, signature: str | None) -> bool:
        return self._inner.verify_webhook(payload, signature)

    # -- writes -------------------------------------------------------------
    def publish_listing(self, request: PublishRequest) -> PublishResult:
        logger.warning("research_mode_blocked", action="publish_listing", sku=request.sku)
        raise ResearchModeError("publishing a listing")

    def update_listing(self, external_id: str, **kwargs: Any) -> PublishResult:
        raise ResearchModeError("updating a listing")

    def end_listing(self, external_id: str, *, reason: str = "") -> PublishResult:
        raise ResearchModeError("ending a listing")

    def upload_tracking(self, external_order_id: str, **kwargs: Any) -> bool:
        raise ResearchModeError("uploading tracking")
