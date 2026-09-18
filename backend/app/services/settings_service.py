"""Runtime business configuration.

:class:`BusinessConfig` is the single typed view of every business rule the
engines obey.  Defaults live here; overrides live in the ``settings`` table and
are editable through ``/api/settings``.  Nothing in the engines reads an
environment variable for a business decision - that would make the rule
invisible to the operator and unauditable.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import ValidationError
from app.models.enums import FulfillmentMode
from app.models.setting import Setting


class FeeBand(BaseModel):
    """A percentage band of a tiered fee schedule.

    ``up_to`` is the upper bound of the *order value* this band applies to;
    ``None`` means "and everything above".  Bands are applied marginally, the
    way marketplace final-value fees actually work.
    """

    up_to: Decimal | None = None
    percent: Decimal = Decimal("0")


class FeeModel(BaseModel):
    """A marketplace or payment fee schedule.

    Deliberately richer than a single percentage: real schedules combine
    marginal percentage bands, a fixed per-order fee, a per-item fee, a
    regulatory operating fee and sometimes a cap.
    """

    name: str = "default"
    version: str = "1.0.0"
    bands: list[FeeBand] = Field(default_factory=list)
    fixed_per_order: Decimal = Decimal("0")
    fixed_per_item: Decimal = Decimal("0")
    #: Applied to the same base as the bands (e.g. a regulatory operating fee).
    additional_percent: Decimal = Decimal("0")
    #: Whether buyer-paid shipping is part of the fee base. On most
    #: marketplaces it is, which is why it defaults to True.
    includes_shipping_in_base: bool = True
    cap: Decimal | None = None

    @field_validator("bands")
    @classmethod
    def _sorted_bands(cls, bands: list[FeeBand]) -> list[FeeBand]:
        finite = [b for b in bands if b.up_to is not None]
        infinite = [b for b in bands if b.up_to is None]
        if len(infinite) > 1:
            raise ValueError("at most one open-ended fee band is allowed")
        return sorted(finite, key=lambda b: b.up_to) + infinite


def _default_marketplace_fee_model() -> FeeModel:
    """A conservative eBay-shaped default.

    12.5 % up to 990 EUR of order value, 2.35 % above, plus a 0.35 EUR fixed
    per-order fee.  These are defaults, not facts: the operator must set the
    schedule that their own account and category actually incur.
    """
    return FeeModel(
        name="ebay_default",
        version="1.0.0",
        bands=[FeeBand(up_to=Decimal("990"), percent=Decimal("12.5")), FeeBand(percent=Decimal("2.35"))],
        fixed_per_order=Decimal("0.35"),
        includes_shipping_in_base=True,
    )


def _default_payment_fee_model() -> FeeModel:
    """Zero by default.

    On managed-payments marketplaces the payment fee is already inside the
    final value fee; charging it twice would understate profit and hide real
    opportunities.  Operators on a separate PSP set it explicitly.
    """
    return FeeModel(name="managed_payments", version="1.0.0", bands=[], fixed_per_order=Decimal("0"))


class BusinessConfig(BaseModel):
    """Every business rule, in one typed object."""

    # -- profitability thresholds -------------------------------------------
    minimum_net_profit: Decimal = Decimal("20.00")
    minimum_profit_margin: Decimal = Decimal("0.15")
    minimum_match_confidence: Decimal = Decimal("95")
    maximum_risk_score: int = 35

    # -- capital protection --------------------------------------------------
    max_capital_exposure: Decimal = Decimal("2000.00")
    max_capital_per_order: Decimal = Decimal("400.00")
    max_daily_capital: Decimal = Decimal("1000.00")
    max_daily_orders: int = 10
    max_units_per_product: int = 3

    # -- data freshness (seconds) -------------------------------------------
    max_opportunity_age_seconds: int = 86_400
    max_price_age_seconds: int = 3_600
    max_inventory_age_seconds: int = 1_800
    max_delivery_age_seconds: int = 7_200

    # -- fulfilment cost model ----------------------------------------------
    # v1 is manual fulfilment. The operator's own time is NOT a cost: there is
    # no labour, handling or warehouse field here, by design.
    fulfillment_mode: FulfillmentMode = FulfillmentMode.MANUAL
    packaging_cost: Decimal = Decimal("1.00")
    source_to_operator_shipping_cost: Decimal = Decimal("0.00")
    operator_to_customer_shipping_cost: Decimal = Decimal("5.99")
    return_shipping_cost: Decimal = Decimal("5.99")
    other_variable_costs: Decimal = Decimal("0.00")

    # -- risk and returns ----------------------------------------------------
    risk_reserve_percent: Decimal = Decimal("2.5")
    """Percentage of sale revenue held back as a reserve, on top of the
    modelled return cost."""
    expected_return_rate: Decimal = Decimal("0.03")
    return_value_recovery_rate: Decimal = Decimal("0.60")
    """Share of the source cost recovered when a returned item is resold or
    sent back to the source."""

    # -- delivery ------------------------------------------------------------
    target_handling_time_days: int = 1
    target_delivery_expectation_days: int = 5
    max_source_delivery_days: int = 4

    # -- policy switches -----------------------------------------------------
    block_on_unknown_inventory: bool = True
    block_on_unknown_delivery: bool = True
    block_on_variant_mismatch: bool = True
    require_compliance_pass: bool = True
    automation_level: int = 2
    simulation_mode: bool = True
    research_mode: bool = False
    """Analysis only. Listing, purchasing and shipping are disabled at the
    provider layer, in the services and by compliance. Safe against live data."""
    base_currency: str = "EUR"

    # -- pricing -------------------------------------------------------------
    listing_price_markup_percent: Decimal = Decimal("0")
    """Optional markup applied on top of the computed minimum sale price when
    recommending a listing price. 0 means "use the market-derived price"."""
    price_anomaly_ratio: Decimal = Decimal("2.5")
    """Target/source price ratio above which an opportunity is treated as an
    anomaly and routed to review instead of being trusted."""
    min_price_history_points: int = 3

    # -- worst-case scenario deltas -----------------------------------------
    worst_case_sale_price_drop_percent: Decimal = Decimal("5")
    worst_case_source_price_rise_percent: Decimal = Decimal("5")
    worst_case_shipping_increase_percent: Decimal = Decimal("20")
    worst_case_extra_fees_percent: Decimal = Decimal("1")
    worst_case_return_rate: Decimal = Decimal("0.15")
    best_case_sale_price_uplift_percent: Decimal = Decimal("3")
    best_case_return_rate: Decimal = Decimal("0")

    # -- fee models ----------------------------------------------------------
    marketplace_fee_model: FeeModel = Field(default_factory=_default_marketplace_fee_model)
    payment_fee_model: FeeModel = Field(default_factory=_default_payment_fee_model)

    model_config = {"validate_assignment": True}

    @field_validator("maximum_risk_score")
    @classmethod
    def _risk_range(cls, value: int) -> int:
        if not 0 <= value <= 100:
            raise ValueError("maximum_risk_score must be between 0 and 100")
        return value

    @field_validator("minimum_match_confidence")
    @classmethod
    def _confidence_range(cls, value: Decimal) -> Decimal:
        if not Decimal("0") <= value <= Decimal("100"):
            raise ValueError("minimum_match_confidence must be between 0 and 100")
        return value

    @field_validator("automation_level")
    @classmethod
    def _automation_range(cls, value: int) -> int:
        if not 0 <= value <= 4:
            raise ValueError("automation_level must be between 0 and 4")
        return value


#: Grouping and documentation for the settings UI.
FIELD_GROUPS: dict[str, str] = {
    "minimum_net_profit": "profitability",
    "minimum_profit_margin": "profitability",
    "minimum_match_confidence": "matching",
    "maximum_risk_score": "risk",
    "max_capital_exposure": "capital",
    "max_capital_per_order": "capital",
    "max_daily_capital": "capital",
    "max_daily_orders": "capital",
    "max_units_per_product": "capital",
    "max_opportunity_age_seconds": "freshness",
    "max_price_age_seconds": "freshness",
    "max_inventory_age_seconds": "freshness",
    "max_delivery_age_seconds": "freshness",
    "fulfillment_mode": "fulfillment",
    "packaging_cost": "fulfillment",
    "source_to_operator_shipping_cost": "fulfillment",
    "operator_to_customer_shipping_cost": "fulfillment",
    "return_shipping_cost": "fulfillment",
    "other_variable_costs": "fulfillment",
    "risk_reserve_percent": "risk",
    "expected_return_rate": "risk",
    "return_value_recovery_rate": "risk",
    "target_handling_time_days": "delivery",
    "target_delivery_expectation_days": "delivery",
    "max_source_delivery_days": "delivery",
    "block_on_unknown_inventory": "policy",
    "block_on_unknown_delivery": "policy",
    "block_on_variant_mismatch": "policy",
    "require_compliance_pass": "policy",
    "automation_level": "automation",
    "simulation_mode": "automation",
    "research_mode": "automation",
    "base_currency": "general",
    "listing_price_markup_percent": "pricing",
    "price_anomaly_ratio": "pricing",
    "min_price_history_points": "pricing",
    "marketplace_fee_model": "fees",
    "payment_fee_model": "fees",
}

_DECIMAL_FIELDS = {
    name
    for name, field in BusinessConfig.model_fields.items()
    if field.annotation is Decimal
}
_JSON_FIELDS = {"marketplace_fee_model", "payment_fee_model"}


def _serialize(name: str, value: Any) -> tuple[str, str]:
    if name in _JSON_FIELDS:
        return json.dumps(value.model_dump(mode="json") if isinstance(value, BaseModel) else value), "json"
    if isinstance(value, bool):
        return ("true" if value else "false"), "bool"
    if isinstance(value, Decimal):
        return str(value), "decimal"
    if isinstance(value, int):
        return str(value), "int"
    if isinstance(value, FulfillmentMode):
        return value.value, "string"
    return str(value), "string"


def _deserialize(name: str, raw: str, value_type: str) -> Any:
    if value_type == "json":
        return json.loads(raw)
    if value_type == "bool":
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    if value_type == "int":
        return int(raw)
    if value_type == "decimal":
        return Decimal(raw)
    return raw


class SettingsService:
    """Reads and writes :class:`BusinessConfig` against the ``settings`` table."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def load(self) -> BusinessConfig:
        rows = self.session.execute(select(Setting)).scalars().all()
        overrides: dict[str, Any] = {}
        known = set(BusinessConfig.model_fields)
        for row in rows:
            if row.key not in known:
                continue  # unknown keys are kept in the table but ignored here
            try:
                overrides[row.key] = _deserialize(row.key, row.value, row.value_type)
            except (ValueError, json.JSONDecodeError) as exc:
                raise ValidationError(
                    f"stored setting {row.key!r} is not valid {row.value_type}",
                    context={"key": row.key},
                ) from exc
        return BusinessConfig(**overrides)

    def ensure_defaults(self) -> BusinessConfig:
        """Materialise every default into the table on first boot."""
        existing = {row.key for row in self.session.execute(select(Setting)).scalars().all()}
        config = BusinessConfig()
        for name in BusinessConfig.model_fields:
            if name in existing:
                continue
            value, value_type = _serialize(name, getattr(config, name))
            self.session.add(
                Setting(
                    key=name,
                    value=value,
                    value_type=value_type,
                    group=FIELD_GROUPS.get(name, "general"),
                    description=(BusinessConfig.model_fields[name].description or None),
                )
            )
        self.session.flush()
        return self.load()

    def update(self, updates: dict[str, Any]) -> BusinessConfig:
        """Validate ``updates`` as a whole, then persist them.

        Validation happens on the merged config before anything is written, so
        a rejected change cannot leave the table half-updated.
        """
        current = self.load().model_dump()
        unknown = set(updates) - set(BusinessConfig.model_fields)
        if unknown:
            raise ValidationError(
                f"unknown setting(s): {', '.join(sorted(unknown))}",
                context={"unknown": sorted(unknown)},
            )
        merged = {**current, **updates}
        try:
            validated = BusinessConfig(**merged)
        except Exception as exc:  # pydantic ValidationError
            raise ValidationError(f"invalid settings: {exc}", context={"keys": sorted(updates)}) from exc

        rows = {
            row.key: row
            for row in self.session.execute(
                select(Setting).where(Setting.key.in_(list(updates)))
            ).scalars()
        }
        for name in updates:
            value, value_type = _serialize(name, getattr(validated, name))
            row = rows.get(name)
            if row is None:
                self.session.add(
                    Setting(
                        key=name,
                        value=value,
                        value_type=value_type,
                        group=FIELD_GROUPS.get(name, "general"),
                    )
                )
            else:
                row.value = value
                row.value_type = value_type
                row.updated_at = utcnow()
        self.session.flush()
        return validated


def get_business_config(session: Session) -> BusinessConfig:
    return SettingsService(session).load()
