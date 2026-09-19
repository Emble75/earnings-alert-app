"""Application configuration.

Infrastructure configuration (credentials, URLs, ports) lives in the
environment.  *Business* configuration (profit thresholds, capital limits,
cost assumptions) lives in the database so that it can be changed at runtime
through the settings UI - see :mod:`app.services.settings_service`.  The
values here are only the bootstrap defaults for a fresh database.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # -- application --------------------------------------------------------
    app_name: str = "Arbitrage Platform"
    environment: Literal["development", "staging", "production", "test"] = "development"
    api_prefix: str = "/api"
    log_level: str = "INFO"
    log_format: Literal["json", "console"] = "json"

    # -- security -----------------------------------------------------------
    secret_key: str = "dev-only-insecure-secret-key-change-me"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 720
    cors_origins: str = "http://localhost:3000"
    bootstrap_user_email: str = "operator@example.com"
    bootstrap_user_password: str = ""
    #: Skip the sign-in screen for a single-user install on this machine.
    #: Only honoured for requests arriving from localhost, never in
    #: production, and never while the system is able to spend money.
    local_no_auth: bool = False

    # -- persistence --------------------------------------------------------
    database_url: str = "postgresql+psycopg://arbitrage:arbitrage@localhost:5432/arbitrage"
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"
    celery_task_always_eager: bool = False

    # -- operating modes ----------------------------------------------------
    demo_mode: bool = True
    simulation_mode: bool = True
    #: Real market data, analysis only. Nothing can be listed, bought or
    #: shipped. Safe to point at live credentials.
    research_mode: bool = False
    automation_level: int = Field(default=2, ge=0, le=4)
    base_currency: str = "EUR"

    # -- provider credentials ----------------------------------------------
    amazon_api_base_url: str = ""
    amazon_api_key: str = ""
    amazon_api_secret: str = ""
    amazon_partner_tag: str = ""
    amazon_marketplace: str = "DE"

    ebay_api_base_url: str = ""
    ebay_client_id: str = ""
    ebay_client_secret: str = ""
    ebay_refresh_token: str = ""
    ebay_marketplace: str = "EBAY_DE"
    ebay_webhook_secret: str = ""
    #: "production" or "sandbox". Sandbox keysets are issued immediately and
    #: hold almost no inventory; production keysets wait for eBay to verify the
    #: developer account. The two are not interchangeable.
    ebay_environment: str = "production"

    # -- notifications ------------------------------------------------------
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    discord_webhook_url: str = ""

    @field_validator("log_level")
    @classmethod
    def _upper(cls, value: str) -> str:
        return value.upper()

    # -- derived ------------------------------------------------------------
    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def amazon_credentials_present(self) -> bool:
        return bool(self.amazon_api_key and self.amazon_api_secret and self.amazon_api_base_url)

    @property
    def ebay_browse_configured(self) -> bool:
        """Can we *read* live eBay listings?

        An application key pair is all the Browse API needs. It grants public
        read access and nothing else - it cannot list, sell or see an account -
        which is why it is enough for research mode but not for selling.
        """
        return bool(self.ebay_client_id and self.ebay_client_secret)

    @property
    def ebay_credentials_present(self) -> bool:
        """Can we *sell* on eBay?

        Deliberately stricter than reading. Listing, revising and uploading
        tracking are Sell API calls behind a user-consent token, which this
        system reaches through a gateway. Browse keys alone must never be
        mistaken for the ability to trade.
        """
        return bool(self.ebay_client_id and self.ebay_client_secret and self.ebay_api_base_url)

    @property
    def effective_research_mode(self) -> bool:
        """Research mode wins over every other mode.

        It is the only mode that is safe to run against live credentials
        without a further decision, so it is never silently downgraded.
        """
        return self.research_mode

    @property
    def effective_demo_mode(self) -> bool:
        """Demo mode is forced on whenever live credentials are incomplete.

        A half-configured system must never be able to reach a live
        marketplace: absent credentials degrade to the demo providers rather
        than to a runtime error in the middle of an order.
        """
        if self.demo_mode:
            return True
        return not (self.amazon_credentials_present and self.ebay_credentials_present)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def auth_required(self) -> bool:
        return not self.local_no_auth_permitted

    @property
    def local_no_auth_permitted(self) -> bool:
        """Whether skipping sign-in is allowed at all.

        Three conditions, all required. The flag alone is not enough: an
        install that can list, buy or ship must never be reachable without
        credentials, however it was configured.
        """
        if not self.local_no_auth:
            return False
        if self.is_production:
            return False
        return self.effective_research_mode or self.effective_demo_mode


@lru_cache
def get_settings() -> Settings:
    return Settings()
