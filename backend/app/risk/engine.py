"""The risk engine.

A weighted sum of deterministic factors, producing a 0-100 score, a level, a
per-factor explanation and a list of hard blockers.

Two rules make the output trustworthy:

* **Determinism.** No model, no sampling, no clock-dependent behaviour beyond
  the data ages handed in.  Re-running a stored :class:`RiskInputs` reproduces
  the score exactly, which is what ``risk_model_version`` promises.
* **Blockers override the number.** A factor may raise a hard blocker (stock
  unknown, compliance blocked, delivery infeasible, capital over limit).  A
  blocked assessment can never be actioned, no matter how low the weighted
  score happens to be.

An LLM may narrate this output.  It may not produce it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from app.core.money import Money
from app.models.enums import RiskLevel
from app.risk.factors import ALL_FACTORS, FactorScore, RiskInputs

RISK_MODEL_VERSION = "1.0.0"

_LEVEL_BOUNDS = (
    (20, RiskLevel.LOW),
    (40, RiskLevel.MODERATE),
    (60, RiskLevel.ELEVATED),
    (80, RiskLevel.HIGH),
)


def level_for(score: int) -> RiskLevel:
    for bound, level in _LEVEL_BOUNDS:
        if score < bound:
            return level
    return RiskLevel.CRITICAL


@dataclass(frozen=True)
class RiskAssessmentResult:
    score: int
    level: RiskLevel
    factors: list[FactorScore]
    blockers: list[str] = field(default_factory=list)
    risk_model_version: str = RISK_MODEL_VERSION

    @property
    def is_blocking(self) -> bool:
        return bool(self.blockers)

    def within(self, maximum_score: int) -> bool:
        """Acceptable only if it is both unblocked and under the limit."""
        return not self.is_blocking and self.score <= maximum_score

    def reasons(self) -> list[str]:
        """Human-readable explanation, highest-contribution factor first."""
        ordered = sorted(self.factors, key=lambda f: -(f.score * float(f.weight)))
        return [f"{f.name.replace('_', ' ')}: {f.reason} ({f.score}/100)" for f in ordered]

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "level": self.level.value,
            "factors": [f.to_dict() for f in self.factors],
            "blockers": self.blockers,
            "reasons": self.reasons(),
            "risk_model_version": self.risk_model_version,
        }

    def explain(self) -> str:  # pragma: no cover - presentation helper
        lines = [f"Risk Score: {self.score} ({self.level.value})", "", "Reasons:"]
        lines += [f"- {reason}" for reason in self.reasons()]
        if self.blockers:
            lines += ["", "Blockers:"] + [f"- {blocker}" for blocker in self.blockers]
        return "\n".join(lines)


def assess_risk(inputs: RiskInputs) -> RiskAssessmentResult:
    """Score ``inputs`` across every factor."""
    factors = [factor(inputs) for factor in ALL_FACTORS]
    total_weight = sum((f.weight for f in factors), Decimal("0"))
    if total_weight <= 0:  # pragma: no cover - guards a misconfigured factor set
        raise ValueError("risk factor weights must sum to a positive value")

    weighted = sum((Decimal(f.score) * f.weight for f in factors), Decimal("0")) / total_weight
    score = int(weighted.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    blockers = [f"{f.name}: {f.reason}" for f in factors if f.blocking]
    return RiskAssessmentResult(score=score, level=level_for(score), factors=factors, blockers=blockers)


def risk_reserve_for(
    result: RiskAssessmentResult, sale_revenue: Money, base_percent: Decimal
) -> Money:
    """Scale the configured reserve by the assessed risk.

    A 0-score opportunity still carries the base reserve; a 100-score one
    carries three times it.  The reserve is a cash haircut applied to the
    profit calculation, not an accounting entry.
    """
    multiplier = Decimal(1) + (Decimal(result.score) / Decimal(50))
    return Money(sale_revenue.amount * base_percent * multiplier / Decimal(100), sale_revenue.currency)
