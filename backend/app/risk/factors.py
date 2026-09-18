"""Individual risk factors.

Each factor is a pure function of observed data returning a 0-100 sub-score
and a sentence explaining it.  Nothing here calls a model, an LLM or a random
number generator: the same inputs always produce the same score, which is what
makes a past decision auditable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.models.enums import DecisionOutcome, DeliverySpeed, MatchStatus, StockStatus


@dataclass(frozen=True)
class FactorScore:
    name: str
    score: int
    weight: Decimal
    reason: str
    blocking: bool = False

    def to_dict(self) -> dict:
        return {
            "factor": self.name,
            "score": self.score,
            "weight": str(self.weight),
            "reason": self.reason,
            "blocking": self.blocking,
        }


@dataclass
class RiskInputs:
    """Everything the risk engine looks at. Missing values mean *unknown*."""

    # -- matching -----------------------------------------------------------
    match_status: MatchStatus = MatchStatus.UNKNOWN
    match_confidence: Decimal | None = None
    minimum_match_confidence: Decimal = Decimal("95")

    # -- source price -------------------------------------------------------
    source_price_age_seconds: float | None = None
    max_price_age_seconds: int = 3600
    source_price_change_percent: Decimal | None = None

    # -- inventory ----------------------------------------------------------
    stock_status: StockStatus = StockStatus.UNKNOWN
    stock_confidence: Decimal = Decimal("0")
    available_quantity: int | None = None
    required_quantity: int = 1
    inventory_age_seconds: float | None = None
    max_inventory_age_seconds: int = 1800
    stock_flapped_recently: bool = False

    # -- delivery -----------------------------------------------------------
    source_delivery_min_days: int | None = None
    source_delivery_max_days: int | None = None
    source_delivery_speed: DeliverySpeed = DeliverySpeed.UNKNOWN
    delivery_age_seconds: float | None = None
    max_delivery_age_seconds: int = 7200
    handling_time_days: int = 1
    target_delivery_expectation_days: int = 5
    max_source_delivery_days: int = 4

    # -- target price / market ---------------------------------------------
    target_price_age_seconds: float | None = None
    observed_target_price: Decimal | None = None
    realistic_target_price: Decimal | None = None
    median_target_price: Decimal | None = None
    price_volatility: Decimal | None = None
    price_history_points: int = 0
    min_price_history_points: int = 3
    price_anomaly_ratio: Decimal | None = None
    max_price_anomaly_ratio: Decimal = Decimal("2.5")

    # -- competition --------------------------------------------------------
    competitor_count: int | None = None
    seller_count: int | None = None
    price_spread_ratio: Decimal | None = None

    # -- returns / fulfilment ----------------------------------------------
    expected_return_rate: Decimal = Decimal("0.03")
    repack_required: bool = False
    fulfillment_is_manual: bool = True

    # -- capital ------------------------------------------------------------
    capital_required: Decimal | None = None
    max_capital_per_order: Decimal | None = None
    current_exposure: Decimal | None = None
    max_capital_exposure: Decimal | None = None

    # -- compliance / operations -------------------------------------------
    compliance_outcome: DecisionOutcome | None = None
    provider_degraded: bool = False
    is_simulated: bool = False

    # -- policy -------------------------------------------------------------
    block_on_unknown_inventory: bool = True
    block_on_unknown_delivery: bool = True
    notes: list[str] = field(default_factory=list)


def _clamp(value: int) -> int:
    return max(0, min(100, value))


def product_match_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.18")
    if i.match_status is MatchStatus.BLOCKED:
        return FactorScore("product_match_risk", 100, weight, "match is BLOCKED (conflicting data)", True)
    if i.match_status in (MatchStatus.UNKNOWN, MatchStatus.REVIEW):
        return FactorScore(
            "product_match_risk", 85, weight, f"match status is {i.match_status.value}", True
        )
    confidence = i.match_confidence or Decimal("0")
    if confidence < i.minimum_match_confidence:
        return FactorScore(
            "product_match_risk",
            80,
            weight,
            f"match confidence {confidence} below minimum {i.minimum_match_confidence}",
            True,
        )
    # 100 -> 0, at-threshold -> 30, scaled linearly in between.
    span = Decimal("100") - i.minimum_match_confidence
    headroom = (confidence - i.minimum_match_confidence) / span if span > 0 else Decimal("1")
    score = _clamp(int(30 * (1 - headroom)))
    return FactorScore(
        "product_match_risk", score, weight, f"identifier-verified match at {confidence} confidence"
    )


def source_price_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.10")
    if i.source_price_age_seconds is None:
        return FactorScore("source_price_risk", 100, weight, "no source price observation", True)
    if i.source_price_age_seconds > i.max_price_age_seconds:
        return FactorScore(
            "source_price_risk",
            90,
            weight,
            f"source price is {int(i.source_price_age_seconds)}s old "
            f"(limit {i.max_price_age_seconds}s)",
            True,
        )
    freshness = i.source_price_age_seconds / max(i.max_price_age_seconds, 1)
    score = int(25 * freshness)
    reason = f"source price observed {int(i.source_price_age_seconds)}s ago"
    change = abs(i.source_price_change_percent or Decimal("0"))
    if change >= Decimal("10"):
        score += 35
        reason += f"; moved {change}% since the previous observation"
    elif change >= Decimal("3"):
        score += 15
        reason += f"; moved {change}% since the previous observation"
    return FactorScore("source_price_risk", _clamp(score), weight, reason)


def inventory_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.14")
    if i.stock_status is StockStatus.OUT_OF_STOCK:
        return FactorScore("inventory_risk", 100, weight, "source is out of stock", True)
    if i.stock_status is StockStatus.UNKNOWN:
        return FactorScore(
            "inventory_risk",
            85,
            weight,
            "source stock status is UNKNOWN",
            i.block_on_unknown_inventory,
        )
    if i.inventory_age_seconds is None or i.inventory_age_seconds > i.max_inventory_age_seconds:
        age = "never observed" if i.inventory_age_seconds is None else f"{int(i.inventory_age_seconds)}s old"
        return FactorScore("inventory_risk", 75, weight, f"inventory observation is {age}", True)
    if i.available_quantity is not None and i.available_quantity < i.required_quantity:
        return FactorScore(
            "inventory_risk",
            95,
            weight,
            f"only {i.available_quantity} available, {i.required_quantity} required",
            True,
        )

    score = 10 if i.stock_status is StockStatus.IN_STOCK else 45
    reason = f"stock status {i.stock_status.value}"
    if i.stock_confidence < Decimal("0.5"):
        score += 20
        reason += f"; low stock confidence ({i.stock_confidence})"
    if i.available_quantity is not None and i.available_quantity <= i.required_quantity * 2:
        score += 15
        reason += f"; thin cover ({i.available_quantity} units)"
    if i.stock_flapped_recently:
        score += 20
        reason += "; stock level has been fluctuating"
    return FactorScore("inventory_risk", _clamp(score), weight, reason)


def delivery_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.12")
    if i.source_delivery_max_days is None:
        return FactorScore(
            "delivery_risk",
            85,
            weight,
            "no source delivery estimate available",
            i.block_on_unknown_delivery,
        )
    if i.delivery_age_seconds is None or i.delivery_age_seconds > i.max_delivery_age_seconds:
        return FactorScore("delivery_risk", 70, weight, "delivery estimate is stale", True)

    total = i.source_delivery_max_days + i.handling_time_days
    if total > i.target_delivery_expectation_days:
        return FactorScore(
            "delivery_risk",
            100,
            weight,
            f"source delivery ({i.source_delivery_max_days}d) plus handling "
            f"({i.handling_time_days}d) exceeds the buyer's "
            f"{i.target_delivery_expectation_days}d expectation",
            True,
        )
    if i.source_delivery_max_days > i.max_source_delivery_days:
        return FactorScore(
            "delivery_risk",
            65,
            weight,
            f"source delivery {i.source_delivery_max_days}d exceeds the configured "
            f"maximum of {i.max_source_delivery_days}d",
        )
    slack = i.target_delivery_expectation_days - total
    score = _clamp(int(50 / (1 + slack)))
    speed_note = (
        f" (observed speed {i.source_delivery_speed.value})"
        if i.source_delivery_speed is not DeliverySpeed.UNKNOWN
        else ""
    )
    return FactorScore(
        "delivery_risk",
        score,
        weight,
        f"arrives in {total}d against a {i.target_delivery_expectation_days}d expectation, "
        f"{slack}d of slack{speed_note}",
    )


def target_price_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.10")
    if i.target_price_age_seconds is None:
        return FactorScore("target_price_risk", 90, weight, "no target price observation", True)
    score = int(25 * min(1.0, i.target_price_age_seconds / max(i.max_price_age_seconds, 1)))
    reasons = [f"target price observed {int(i.target_price_age_seconds)}s ago"]

    if i.price_history_points < i.min_price_history_points:
        score += 25
        reasons.append(
            f"only {i.price_history_points} price observations "
            f"(want {i.min_price_history_points})"
        )
    if (
        i.observed_target_price is not None
        and i.realistic_target_price is not None
        and i.observed_target_price > 0
    ):
        gap = (i.observed_target_price - i.realistic_target_price) / i.observed_target_price
        if gap > Decimal("0.15"):
            score += 30
            reasons.append(
                f"observed price is {round(float(gap) * 100)}% above the realistic achievable price"
            )
        elif gap > Decimal("0.05"):
            score += 12
            reasons.append("observed price is modestly above the realistic achievable price")
    if i.price_anomaly_ratio is not None and i.price_anomaly_ratio >= i.max_price_anomaly_ratio:
        # A gap this large is almost never free money. It is a variant, a
        # bundle, a used unit, a regional model, a wrong pack size or a stale
        # observation. Blocking it for review is the whole point of the
        # false-positive discipline: a weighted deduction would let a 3x
        # "profit" sail through on the strength of its own size.
        reasons.append(
            f"target/source price ratio {i.price_anomaly_ratio} looks anomalous "
            f"(threshold {i.max_price_anomaly_ratio}) - likely a variant, bundle, "
            "condition or regional difference rather than a real margin"
        )
        return FactorScore("target_price_risk", 100, weight, "; ".join(reasons), True)
    return FactorScore("target_price_risk", _clamp(score), weight, "; ".join(reasons))


def competition_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.07")
    if i.competitor_count is None:
        return FactorScore("competition_risk", 60, weight, "competitive landscape unknown")
    if i.competitor_count == 0:
        return FactorScore(
            "competition_risk",
            45,
            weight,
            "no comparable listings found - the achievable price is unproven",
        )
    score = _clamp(int(min(60, i.competitor_count * 3)))
    reason = f"{i.competitor_count} comparable listings"
    if i.price_spread_ratio is not None and i.price_spread_ratio > Decimal("0.5"):
        score += 20
        reason += f"; wide price spread ({i.price_spread_ratio})"
    if i.seller_count is not None and i.seller_count <= 2 and i.competitor_count > 5:
        score += 10
        reason += "; the listings are concentrated in very few sellers"
    return FactorScore("competition_risk", _clamp(score), weight, reason)


def price_volatility_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.06")
    if i.price_volatility is None:
        return FactorScore("price_volatility_risk", 50, weight, "no price history to measure volatility")
    volatility = i.price_volatility
    score = _clamp(int(volatility * Decimal("250")))
    return FactorScore(
        "price_volatility_risk", score, weight, f"target price volatility {volatility}"
    )


def return_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.07")
    score = _clamp(int(i.expected_return_rate * Decimal("400")))
    reason = f"expected return rate {i.expected_return_rate}"
    if i.repack_required:
        score += 10
        reason += "; repackaging required before dispatch"
    return FactorScore("return_risk", _clamp(score), weight, reason)


def fulfillment_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.05")
    if i.fulfillment_is_manual:
        # Manual fulfilment is a single-operator dependency: no cash cost, but
        # a real operational one. It is scored here, never in the cash model.
        score = 25
        reason = "manual fulfilment depends on the operator being available to ship"
    else:
        score = 15
        reason = "external fulfilment provider"
    if i.repack_required:
        score += 10
        reason += "; repack step adds handling"
    return FactorScore("fulfillment_risk", _clamp(score), weight, reason)


def capital_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.06")
    if i.capital_required is None:
        return FactorScore("capital_risk", 50, weight, "capital requirement unknown")
    reasons: list[str] = []
    score = 10
    if i.max_capital_per_order is not None and i.max_capital_per_order > 0:
        usage = i.capital_required / i.max_capital_per_order
        if usage > 1:
            return FactorScore(
                "capital_risk",
                100,
                weight,
                f"capital required ({i.capital_required}) exceeds the per-order limit "
                f"({i.max_capital_per_order})",
                True,
            )
        score = _clamp(int(usage * 60))
        reasons.append(f"{round(float(usage) * 100)}% of the per-order capital limit")
    if (
        i.current_exposure is not None
        and i.max_capital_exposure is not None
        and i.max_capital_exposure > 0
    ):
        projected = (i.current_exposure + i.capital_required) / i.max_capital_exposure
        if projected > 1:
            return FactorScore(
                "capital_risk",
                100,
                weight,
                f"total exposure would reach {i.current_exposure + i.capital_required}, "
                f"above the {i.max_capital_exposure} limit",
                True,
            )
        score = max(score, _clamp(int(projected * 70)))
        reasons.append(f"total exposure would reach {round(float(projected) * 100)}% of the limit")
    return FactorScore("capital_risk", score, weight, "; ".join(reasons) or "within capital limits")


def compliance_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.03")
    if i.compliance_outcome is None:
        return FactorScore("compliance_risk", 50, weight, "compliance not yet checked")
    if i.compliance_outcome is DecisionOutcome.BLOCK:
        return FactorScore("compliance_risk", 100, weight, "compliance check blocked this action", True)
    if i.compliance_outcome is DecisionOutcome.REVIEW:
        return FactorScore("compliance_risk", 55, weight, "compliance check requires review")
    if i.compliance_outcome is DecisionOutcome.REJECT:
        return FactorScore("compliance_risk", 90, weight, "compliance check rejected this action", True)
    return FactorScore("compliance_risk", 5, weight, "compliance checks passed")


def operational_risk(i: RiskInputs) -> FactorScore:
    weight = Decimal("0.02")
    score = 10
    reasons = []
    if i.provider_degraded:
        score += 50
        reasons.append("a provider is degraded or rate limited")
    if i.is_simulated:
        reasons.append("running in simulation/demo mode - no real transaction will occur")
    return FactorScore(
        "operational_risk", _clamp(score), weight, "; ".join(reasons) or "providers healthy"
    )


#: Evaluated in a fixed order so that the stored explanation is stable.
ALL_FACTORS = (
    product_match_risk,
    source_price_risk,
    inventory_risk,
    delivery_risk,
    target_price_risk,
    competition_risk,
    price_volatility_risk,
    return_risk,
    fulfillment_risk,
    capital_risk,
    compliance_risk,
    operational_risk,
)
