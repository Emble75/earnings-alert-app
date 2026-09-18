"""Conservative cross-marketplace product matching.

The matcher answers one question: *is the thing we can buy on the source
marketplace the same thing we would be selling on the target marketplace?*

It is built to be wrong in the safe direction.  Similar titles are not a
match.  A variant mismatch is not a small deduction, it is a block.  Missing
or contradictory data produces ``UNKNOWN`` or ``BLOCKED``, never an optimistic
number.  Confidence starts from the strength of the evidence and is only ever
reduced by disagreement - it is never inflated by the absence of it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.core.clock import utcnow
from app.matching.identifiers import STRONG_IDENTIFIERS, NormalizedIdentifier, normalize_map
from app.matching.text import jaccard, normalize_key
from app.models.enums import IdentifierType, MatchMethod, MatchStatus, ProductCondition

MATCHER_VERSION = "1.0.0"

#: Attributes that define a distinct sellable variant.  A disagreement in any
#: of these means the two offers are different products, not a near-match.
VARIANT_ATTRIBUTES = (
    "variant",
    "size",
    "color",
    "capacity",
    "quantity",
    "edition",
    "region",
    "model_year",
    "compatibility",
    "included_accessories",
    "platform",
    "language",
)

#: Ceilings by evidence class.  Nothing can exceed the ceiling of its own
#: strongest evidence, which is what makes a title-only match unable to reach
#: the default 95 threshold.
_CEILING_STRONG_ID = Decimal("99")
_CEILING_WEAK_ID = Decimal("92")
_CEILING_BRAND_MPN = Decimal("88")
_CEILING_ATTRIBUTES = Decimal("70")
_CEILING_TITLE = Decimal("45")


@dataclass
class MatchCandidate:
    """One side of a match (a source offer or a target listing)."""

    title: str
    identifiers: dict[str, str | None] = field(default_factory=dict)
    brand: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    condition: ProductCondition = ProductCondition.UNKNOWN
    quantity: int = 1
    attributes: dict[str, object] = field(default_factory=dict)
    label: str = "candidate"

    def normalized_identifiers(self) -> dict[IdentifierType, NormalizedIdentifier]:
        return normalize_map(self.identifiers)


@dataclass
class MatchResult:
    status: MatchStatus
    confidence: Decimal
    method: MatchMethod
    evidence: dict[str, str] = field(default_factory=dict)
    conflicts: list[str] = field(default_factory=list)
    blocked_reason: str | None = None
    quantity_ratio: int = 1
    matcher_version: str = MATCHER_VERSION

    @property
    def is_match(self) -> bool:
        return self.status is MatchStatus.MATCHED

    def to_dict(self) -> dict:
        return {
            "status": self.status.value,
            "confidence": str(self.confidence),
            "method": self.method.value,
            "evidence": self.evidence,
            "conflicts": self.conflicts,
            "blocked_reason": self.blocked_reason,
            "quantity_ratio": self.quantity_ratio,
            "matcher_version": self.matcher_version,
            "matched_at": utcnow().isoformat(),
        }


def _identifier_comparison(
    source: dict[IdentifierType, NormalizedIdentifier],
    target: dict[IdentifierType, NormalizedIdentifier],
) -> tuple[list[tuple[IdentifierType, bool]], dict[str, str]]:
    """Compare every identifier type both sides declare.

    Returns ``(comparisons, evidence)`` where each comparison is
    ``(type, agrees)``.  Only *valid* identifiers are compared: an invalid
    check digit is recorded as evidence of nothing.
    """
    comparisons: list[tuple[IdentifierType, bool]] = []
    evidence: dict[str, str] = {}
    for identifier_type in IdentifierType:
        left, right = source.get(identifier_type), target.get(identifier_type)
        if left is None or right is None:
            continue
        if not left.valid or not right.valid:
            evidence[identifier_type.value] = "present but invalid - ignored as evidence"
            continue
        left_value = left.canonical or left.value
        right_value = right.canonical or right.value
        agrees = left_value == right_value
        comparisons.append((identifier_type, agrees))
        evidence[identifier_type.value] = "exact match" if agrees else "conflict"
    return comparisons, evidence


def _cross_gtin_match(
    source: dict[IdentifierType, NormalizedIdentifier],
    target: dict[IdentifierType, NormalizedIdentifier],
) -> bool:
    """A UPC on one side and an EAN on the other can be the same article."""
    gtin_types = (IdentifierType.EAN, IdentifierType.GTIN, IdentifierType.UPC)
    left = {n.canonical for t, n in source.items() if t in gtin_types and n.valid and n.canonical}
    right = {n.canonical for t, n in target.items() if t in gtin_types and n.valid and n.canonical}
    return bool(left & right)


def _compare_variant_attributes(
    source: MatchCandidate, target: MatchCandidate
) -> tuple[list[str], dict[str, str], int]:
    """Compare variant-defining attributes.

    Returns ``(conflicts, evidence, agreements)``.  Attributes only one side
    declares are recorded as unknown - they neither confirm nor deny.
    """
    conflicts: list[str] = []
    evidence: dict[str, str] = {}
    agreements = 0
    for name in VARIANT_ATTRIBUTES:
        left, right = source.attributes.get(name), target.attributes.get(name)
        if left is None or right is None:
            if left is not None or right is not None:
                evidence[name] = "declared on one side only - inconclusive"
            continue
        if normalize_key(str(left)) == normalize_key(str(right)):
            evidence[name] = f"agrees ({left})"
            agreements += 1
        else:
            evidence[name] = f"CONFLICT ({left} vs {right})"
            conflicts.append(f"{name}: source={left!r} target={right!r}")
    return conflicts, evidence, agreements


def match_products(
    source: MatchCandidate,
    target: MatchCandidate,
    *,
    block_on_variant_mismatch: bool = True,
) -> MatchResult:
    """Decide whether ``source`` and ``target`` are the same sellable product."""
    evidence: dict[str, str] = {}
    conflicts: list[str] = []

    source_ids = source.normalized_identifiers()
    target_ids = target.normalized_identifiers()
    comparisons, id_evidence = _identifier_comparison(source_ids, target_ids)
    evidence.update(id_evidence)

    strong_agree = [t for t, ok in comparisons if ok and t in STRONG_IDENTIFIERS]
    strong_conflict = [t for t, ok in comparisons if not ok and t in STRONG_IDENTIFIERS]
    weak_agree = [t for t, ok in comparisons if ok and t not in STRONG_IDENTIFIERS]
    weak_conflict = [t for t, ok in comparisons if not ok and t not in STRONG_IDENTIFIERS]

    # 1. A contradicting strong identifier ends the discussion.
    if strong_conflict:
        names = ", ".join(t.value for t in strong_conflict)
        return MatchResult(
            status=MatchStatus.BLOCKED,
            confidence=Decimal("0"),
            method=MatchMethod.IDENTIFIER,
            evidence=evidence,
            conflicts=[f"{names} disagree between source and target"],
            blocked_reason=f"conflicting {names}",
        )

    if not strong_agree and _cross_gtin_match(source_ids, target_ids):
        strong_agree = [IdentifierType.GTIN]
        evidence["GTIN"] = "cross-type GTIN match (UPC/EAN normalised to GTIN-14)"

    # 2. Variant attributes.
    variant_conflicts, variant_evidence, variant_agreements = _compare_variant_attributes(source, target)
    evidence.update(variant_evidence)
    conflicts.extend(variant_conflicts)

    # 3. Condition. A new item and a used item are not the same offer.
    known = (source.condition is not ProductCondition.UNKNOWN) and (
        target.condition is not ProductCondition.UNKNOWN
    )
    if known and source.condition is not target.condition:
        conflicts.append(f"condition: source={source.condition.value} target={target.condition.value}")
        evidence["condition"] = f"CONFLICT ({source.condition.value} vs {target.condition.value})"
    elif known:
        evidence["condition"] = f"agrees ({source.condition.value})"
    else:
        evidence["condition"] = "unknown on at least one side"

    # 4. Quantity / bundles.
    quantity_ratio = 1
    if source.quantity != target.quantity:
        conflicts.append(f"quantity: source pack={source.quantity} target pack={target.quantity}")
        evidence["pack_quantity"] = f"CONFLICT ({source.quantity} vs {target.quantity})"
    else:
        evidence["pack_quantity"] = f"agrees ({source.quantity})"

    if conflicts and block_on_variant_mismatch:
        return MatchResult(
            status=MatchStatus.BLOCKED,
            confidence=Decimal("0"),
            method=MatchMethod.IDENTIFIER if strong_agree else MatchMethod.ATTRIBUTES,
            evidence=evidence,
            conflicts=conflicts,
            blocked_reason="; ".join(conflicts),
            quantity_ratio=quantity_ratio,
        )

    # 5. Brand / manufacturer / model.
    brand_agrees = model_agrees = None
    source_brand = normalize_key(source.brand or source.manufacturer)
    target_brand = normalize_key(target.brand or target.manufacturer)
    if source_brand and target_brand:
        brand_agrees = source_brand == target_brand
        evidence["brand"] = "exact match" if brand_agrees else "CONFLICT"
        if not brand_agrees:
            conflicts.append(f"brand: {source.brand!r} vs {target.brand!r}")
    else:
        evidence["brand"] = "missing on at least one side"

    source_model = normalize_key(source.model)
    target_model = normalize_key(target.model)
    if source_model and target_model:
        model_agrees = source_model == target_model
        evidence["model"] = "exact match" if model_agrees else "differs"
    else:
        evidence["model"] = "missing on at least one side"

    mpn_agrees = IdentifierType.MPN in weak_agree
    title_similarity = jaccard(source.title, target.title)
    evidence["title_similarity"] = f"{title_similarity:.2f} (supplemental only)"

    # 6. Choose the evidence class and its ceiling.
    if strong_agree:
        method = MatchMethod.IDENTIFIER
        confidence = _CEILING_STRONG_ID
        ceiling = _CEILING_STRONG_ID
    elif weak_agree and (mpn_agrees or IdentifierType.ASIN in weak_agree):
        method = MatchMethod.BRAND_MPN if mpn_agrees else MatchMethod.IDENTIFIER
        confidence = _CEILING_WEAK_ID
        ceiling = _CEILING_WEAK_ID
    elif brand_agrees and model_agrees:
        method = MatchMethod.BRAND_MPN
        confidence = _CEILING_BRAND_MPN
        ceiling = _CEILING_BRAND_MPN
    elif variant_agreements >= 3 and brand_agrees:
        method = MatchMethod.ATTRIBUTES
        confidence = _CEILING_ATTRIBUTES
        ceiling = _CEILING_ATTRIBUTES
    else:
        method = MatchMethod.TITLE
        confidence = Decimal(str(round(title_similarity * float(_CEILING_TITLE), 2)))
        ceiling = _CEILING_TITLE

    # 7. Deductions. Agreement never adds; disagreement always subtracts.
    if brand_agrees is False:
        confidence -= Decimal("40")
    elif brand_agrees is None:
        confidence -= Decimal("6")
    if model_agrees is False:
        confidence -= Decimal("15")
    elif model_agrees is None:
        confidence -= Decimal("4")
    if weak_conflict:
        confidence -= Decimal("10") * len(weak_conflict)
        evidence["weak_identifier_conflict"] = ", ".join(t.value for t in weak_conflict)
    if conflicts:
        confidence -= Decimal("25") * len(conflicts)
    if not known:
        confidence -= Decimal("5")
    if title_similarity < 0.2 and method is not MatchMethod.TITLE:
        confidence -= Decimal("8")
        evidence["title_similarity"] += " - unusually low for a claimed match"

    confidence = max(Decimal("0"), min(confidence, ceiling))

    if conflicts:
        status = MatchStatus.REVIEW
    elif confidence >= _CEILING_BRAND_MPN:
        status = MatchStatus.MATCHED
    elif confidence >= Decimal("50"):
        status = MatchStatus.REVIEW
    else:
        status = MatchStatus.UNKNOWN

    return MatchResult(
        status=status,
        confidence=confidence,
        method=method,
        evidence=evidence,
        conflicts=conflicts,
        blocked_reason=None,
        quantity_ratio=quantity_ratio,
    )


def meets_confidence(result: MatchResult, minimum_confidence: Decimal) -> bool:
    """Whether a match clears the configured threshold.

    Both conditions are required: a ``REVIEW`` or ``UNKNOWN`` status never
    passes, however high the number next to it.
    """
    return result.status is MatchStatus.MATCHED and result.confidence >= minimum_confidence
