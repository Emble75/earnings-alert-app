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
    def ebay_credentials_present(self) -> bool:
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
