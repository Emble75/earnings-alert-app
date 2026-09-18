"""Provider selection.

One rule decides everything here: **a half-configured system degrades to demo
providers, it never reaches a live marketplace.**  Missing credentials are a
configuration state, not an exception to be handled three layers down inside
an order.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from app.core.config import Settings, get_settings
from app.core.logging import get_logger
from app.fulfillment.base import FulfillmentProvider
from app.fulfillment.manual import ManualFulfillmentProvider
from app.models.enums import ExecutionMode, FulfillmentMode, NotificationChannel
from app.providers.amazon.demo import DemoAmazonProvider
from app.providers.base import (
    NotificationProvider,
    ShippingProvider,
    SourceProvider,
    TargetMarketplaceProvider,
)
from app.providers.ebay.demo import DemoEbayProvider
from app.providers.http_gateway import HttpSourceProvider, HttpTargetProvider
from app.providers.notifications.channels import (
    DiscordNotificationProvider,
    EmailNotificationProvider,
    InAppNotificationProvider,
    TelegramNotificationProvider,
)
from app.providers.readonly import ReadOnlySourceProvider, ReadOnlyTargetProvider
from app.shipping.manual_carrier import ManualShippingProvider

logger = get_logger(__name__)


@dataclass
class ProviderBundle:
    source: SourceProvider
    target: TargetMarketplaceProvider
    fulfillment: FulfillmentProvider
    shipping: ShippingProvider
    execution_mode: ExecutionMode
    demo_mode: bool

    @property
    def is_live(self) -> bool:
        return self.execution_mode is ExecutionMode.LIVE

    @property
    def is_read_only(self) -> bool:
        return self.execution_mode is ExecutionMode.RESEARCH

    def describe(self) -> dict:
        return {
            "source": self.source.name,
            "target": self.target.name,
            "fulfillment": self.fulfillment.name,
            "shipping": getattr(self.shipping, "name", "shipping"),
            "execution_mode": self.execution_mode.value,
            "demo_mode": self.demo_mode,
            "read_only": self.is_read_only,
        }


def _execution_mode(settings: Settings) -> ExecutionMode:
    # Research mode is checked first: it is the only mode that may run against
    # live credentials, because it cannot act on them.
    if settings.effective_research_mode:
        return ExecutionMode.RESEARCH
    if settings.effective_demo_mode:
        return ExecutionMode.DEMO
    if settings.simulation_mode:
        return ExecutionMode.SIMULATION
    return ExecutionMode.LIVE


def build_providers(settings: Settings | None = None, *, currency: str = "EUR") -> ProviderBundle:
    settings = settings or get_settings()
    mode = _execution_mode(settings)

    # In research mode the real adapters are used when credentials exist, so
    # the data is real; only the write paths are removed.
    if mode is ExecutionMode.RESEARCH:
        if settings.amazon_credentials_present:
            source: SourceProvider = HttpSourceProvider(
                base_url=settings.amazon_api_base_url,
                api_key=settings.amazon_api_key,
                api_secret=settings.amazon_api_secret,
                currency=currency,
                marketplace=settings.amazon_marketplace,
            )
        else:
            source = DemoAmazonProvider(currency=currency)
        if settings.ebay_credentials_present:
            target: TargetMarketplaceProvider = HttpTargetProvider(
                base_url=settings.ebay_api_base_url,
                api_key=settings.ebay_client_id,
                api_secret=settings.ebay_client_secret,
                currency=currency,
                marketplace=settings.ebay_marketplace,
                webhook_secret=settings.ebay_webhook_secret,
            )
        else:
            target = DemoEbayProvider(currency=currency)
        logger.info(
            "research_mode_active",
            amazon="live" if settings.amazon_credentials_present else "demo",
            ebay="live" if settings.ebay_credentials_present else "demo",
        )
        return ProviderBundle(
            source=ReadOnlySourceProvider(source),
            target=ReadOnlyTargetProvider(target),
            fulfillment=build_fulfillment_provider(FulfillmentMode.MANUAL, currency=currency),
            shipping=ManualShippingProvider(currency=currency),
            execution_mode=mode,
            demo_mode=not (
                settings.amazon_credentials_present or settings.ebay_credentials_present
            ),
        )

    if mode is ExecutionMode.LIVE:
        source: SourceProvider = HttpSourceProvider(
            base_url=settings.amazon_api_base_url,
            api_key=settings.amazon_api_key,
            api_secret=settings.amazon_api_secret,
            currency=currency,
            marketplace=settings.amazon_marketplace,
        )
        target: TargetMarketplaceProvider = HttpTargetProvider(
            base_url=settings.ebay_api_base_url,
            api_key=settings.ebay_client_id,
            api_secret=settings.ebay_client_secret,
            currency=currency,
            marketplace=settings.ebay_marketplace,
            webhook_secret=settings.ebay_webhook_secret,
        )
    else:
        if not settings.demo_mode:
            logger.warning(
                "demo_mode_forced",
                reason="provider credentials incomplete - refusing to run live",
                amazon_configured=settings.amazon_credentials_present,
                ebay_configured=settings.ebay_credentials_present,
            )
        source = DemoAmazonProvider(currency=currency)
        target = DemoEbayProvider(currency=currency, webhook_secret=settings.ebay_webhook_secret)

    return ProviderBundle(
        source=source,
        target=target,
        fulfillment=build_fulfillment_provider(FulfillmentMode.MANUAL, currency=currency),
        shipping=ManualShippingProvider(currency=currency),
        execution_mode=mode,
        demo_mode=settings.effective_demo_mode,
    )


def build_fulfillment_provider(mode: FulfillmentMode, *, currency: str = "EUR") -> FulfillmentProvider:
    """Resolve the configured fulfilment mode to a provider.

    Only ``MANUAL`` exists in v1.  ``EXTERNAL_3PL`` and ``WAREHOUSE`` fail
    loudly rather than silently falling back, because silently fulfilling
    through the wrong provider would mis-state costs on every order.
    """
    if mode is FulfillmentMode.MANUAL:
        return ManualFulfillmentProvider(currency=currency)
    raise NotImplementedError(
        f"fulfillment mode {mode.value} has no provider yet; implement FulfillmentProvider "
        "and register it here (see docs/fulfillment.md)"
    )


def build_notification_providers(
    settings: Settings | None = None,
) -> dict[NotificationChannel, NotificationProvider]:
    settings = settings or get_settings()
    providers: dict[NotificationChannel, NotificationProvider] = {
        NotificationChannel.IN_APP: InAppNotificationProvider()
    }
    if settings.smtp_host:
        providers[NotificationChannel.EMAIL] = EmailNotificationProvider(
            host=settings.smtp_host,
            port=settings.smtp_port,
            user=settings.smtp_user,
            password=settings.smtp_password,
            sender=settings.smtp_from,
            recipient=settings.bootstrap_user_email,
        )
    if settings.telegram_bot_token and settings.telegram_chat_id:
        providers[NotificationChannel.TELEGRAM] = TelegramNotificationProvider(
            bot_token=settings.telegram_bot_token, chat_id=settings.telegram_chat_id
        )
    if settings.discord_webhook_url:
        providers[NotificationChannel.DISCORD] = DiscordNotificationProvider(
            webhook_url=settings.discord_webhook_url
        )
    return providers


@lru_cache
def get_providers() -> ProviderBundle:
    """Process-wide provider bundle (cached; call :func:`reset` after config changes)."""
    return build_providers()


def reset_providers() -> None:
    get_providers.cache_clear()
