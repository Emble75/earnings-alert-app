"""The risk engine must be deterministic, explainable and blocking-first."""

from __future__ import annotations

from decimal import Decimal

from app.core.money import Money
from app.models.enums import DecisionOutcome, DeliverySpeed, MatchStatus, RiskLevel, StockStatus
from app.risk.engine import assess_risk, level_for, risk_reserve_for
from app.risk.factors import RiskInputs


def healthy() -> RiskInputs:
    return RiskInputs(
        match_status=MatchStatus.MATCHED,
        match_confidence=Decimal("99"),
        source_price_age_seconds=60,
        source_price_change_percent=Decimal("0"),
        stock_status=StockStatus.IN_STOCK,
        stock_confidence=Decimal("0.95"),
        available_quantity=50,
        inventory_age_seconds=120,
        source_delivery_min_days=1,
        source_delivery_max_days=2,
        source_delivery_speed=DeliverySpeed.FAST,
        delivery_age_seconds=120,
        target_price_age_seconds=120,
        price_history_points=10,
        price_volatility=Decimal("0.02"),
        competitor_count=5,
        seller_count=5,
        observed_target_price=Decimal("159.99"),
        realistic_target_price=Decimal("158.00"),
        price_anomaly_ratio=Decimal("1.6"),
        capital_required=Decimal("106.99"),
        max_capital_per_order=Decimal("400"),
        current_exposure=Decimal("0"),
        max_capital_exposure=Decimal("2000"),
        compliance_outcome=DecisionOutcome.PASS,
        expected_return_rate=Decimal("0.03"),
    )


def test_healthy_inputs_score_low_and_do_not_block():
    result = assess_risk(healthy())
    assert result.score <= 35
    assert not result.is_blocking
    assert result.within(35)
    assert result.level in (RiskLevel.LOW, RiskLevel.MODERATE)


def test_the_same_inputs_always_produce_the_same_score():
    inputs = healthy()
    scores = {assess_risk(inputs).score for _ in range(25)}
    assert len(scores) == 1, "risk scoring must be deterministic"


def test_every_factor_is_explained():
    result = assess_risk(healthy())
    assert len(result.factors) == 12
    for factor in result.factors:
        assert factor.reason, f"{factor.name} has no explanation"
        assert 0 <= factor.score <= 100
    assert len(result.reasons()) == 12


def test_unknown_inventory_blocks():
    result = assess_risk(
        RiskInputs(**{**healthy().__dict__, "stock_status": StockStatus.UNKNOWN})
    )
    assert result.is_blocking
    assert any("UNKNOWN" in b for b in result.blockers)
    assert not result.within(100)


def test_out_of_stock_blocks():
    result = assess_risk(
        RiskInputs(**{**healthy().__dict__, "stock_status": StockStatus.OUT_OF_STOCK})
    )
    assert result.is_blocking


def test_delivery_that_cannot_meet_the_promise_blocks():
    result = assess_risk(
        RiskInputs(
            **{
                **healthy().__dict__,
                "source_delivery_max_days": 9,
                "target_delivery_expectation_days": 5,
            }
        )
    )
    assert result.is_blocking
    assert any("delivery" in b for b in result.blockers)


def test_price_anomaly_blocks_rather_than_merely_scoring():
    """A 3x price gap is a variant or condition difference, not free money."""
    result = assess_risk(
        RiskInputs(**{**healthy().__dict__, "price_anomaly_ratio": Decimal("3.4")})
    )
    assert result.is_blocking
    assert any("anomalous" in b for b in result.blockers)


def test_capital_over_the_per_order_limit_blocks():
    result = assess_risk(
        RiskInputs(
            **{
                **healthy().__dict__,
                "capital_required": Decimal("900"),
                "max_capital_per_order": Decimal("400"),
            }
        )
    )
    assert result.is_blocking


def test_stale_price_blocks():
    result = assess_risk(
        RiskInputs(
            **{**healthy().__dict__, "source_price_age_seconds": 999_999, "max_price_age_seconds": 3600}
        )
    )
    assert result.is_blocking


def test_match_below_the_threshold_blocks():
    result = assess_risk(
        RiskInputs(
            **{
                **healthy().__dict__,
                "match_confidence": Decimal("80"),
                "minimum_match_confidence": Decimal("95"),
            }
        )
    )
    assert result.is_blocking


def test_compliance_block_is_a_risk_blocker():
    result = assess_risk(
        RiskInputs(**{**healthy().__dict__, "compliance_outcome": DecisionOutcome.BLOCK})
    )
    assert result.is_blocking


def test_missing_data_raises_risk_rather_than_being_ignored():
    sparse = RiskInputs()
    result = assess_risk(sparse)
    assert result.score > 50
    assert result.is_blocking


def test_level_boundaries():
    assert level_for(0) is RiskLevel.LOW
    assert level_for(19) is RiskLevel.LOW
    assert level_for(20) is RiskLevel.MODERATE
    assert level_for(40) is RiskLevel.ELEVATED
    assert level_for(60) is RiskLevel.HIGH
    assert level_for(80) is RiskLevel.CRITICAL


def test_risk_reserve_scales_with_the_score():
    low = assess_risk(healthy())
    reserve_low = risk_reserve_for(low, Money("159.99"), Decimal("2.5"))
    high = assess_risk(RiskInputs(**{**healthy().__dict__, "competitor_count": 200}))
    reserve_high = risk_reserve_for(high, Money("159.99"), Decimal("2.5"))
    assert reserve_high >= reserve_low
    assert reserve_low.is_positive()
