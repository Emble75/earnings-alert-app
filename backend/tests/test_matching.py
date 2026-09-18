"""Matching must be wrong in the safe direction."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.matching.identifiers import gtin_check_digit, is_valid_gtin, normalize, to_gtin14
from app.matching.matcher import MatchCandidate, match_products, meets_confidence
from app.models.enums import IdentifierType, MatchStatus, ProductCondition

EAN = "4548736134584"
OTHER_EAN = "4006381333931"
MINIMUM = Decimal("95")


def candidate(**overrides) -> MatchCandidate:
    base = {
        "title": "Sony WH-1000XM5 Wireless Noise Cancelling Headphones, Black",
        "identifiers": {"EAN": EAN},
        "brand": "Sony",
        "model": "WH-1000XM5",
        "condition": ProductCondition.NEW,
        "attributes": {"color": "black"},
    }
    base.update(overrides)
    return MatchCandidate(**base)


def test_identical_identifiers_and_attributes_match_at_high_confidence():
    result = match_products(candidate(), candidate(title="Sony WH1000XM5 Kopfhoerer schwarz"))
    assert result.status is MatchStatus.MATCHED
    assert result.confidence >= MINIMUM
    assert meets_confidence(result, MINIMUM)


def test_conflicting_strong_identifiers_block():
    result = match_products(candidate(), candidate(identifiers={"EAN": OTHER_EAN}))
    assert result.status is MatchStatus.BLOCKED
    assert result.confidence == 0
    assert "EAN" in (result.blocked_reason or "")


def test_variant_mismatch_blocks_rather_than_deducting():
    result = match_products(candidate(), candidate(attributes={"color": "silver"}))
    assert result.status is MatchStatus.BLOCKED
    assert "color" in (result.blocked_reason or "")
    assert not meets_confidence(result, MINIMUM)


def test_condition_mismatch_blocks():
    result = match_products(candidate(), candidate(condition=ProductCondition.USED))
    assert result.status is MatchStatus.BLOCKED
    assert "condition" in (result.blocked_reason or "")


def test_pack_quantity_mismatch_blocks():
    result = match_products(candidate(quantity=1), candidate(quantity=3))
    assert result.status is MatchStatus.BLOCKED
    assert "quantity" in (result.blocked_reason or "")


def test_similar_titles_alone_cannot_reach_the_threshold():
    left = MatchCandidate(title="Sony WH-1000XM5 Wireless Headphones Black")
    right = MatchCandidate(title="Sony WH-1000XM5 Wireless Headphones Black")
    result = match_products(left, right)
    assert not meets_confidence(result, MINIMUM)
    assert result.status in (MatchStatus.UNKNOWN, MatchStatus.REVIEW)


def test_an_identifier_that_fails_its_checksum_is_not_evidence():
    bad = "4548736134585"  # last digit altered
    assert not is_valid_gtin(bad)
    result = match_products(candidate(), candidate(identifiers={"EAN": bad}))
    assert result.evidence["EAN"].startswith("present but invalid")
    # Falls back to brand + model, which is below the 95 threshold
    assert not meets_confidence(result, MINIMUM)


def test_upc_and_ean_of_the_same_article_match_across_types():
    upc = "085126302658"
    assert is_valid_gtin(upc)
    left = MatchCandidate(title="Sigma 30mm", identifiers={"UPC": upc}, brand="Sigma", model="30mm")
    right = MatchCandidate(
        title="Sigma 30mm", identifiers={"EAN": "0085126302658"}, brand="Sigma", model="30mm"
    )
    result = match_products(left, right)
    assert result.status is MatchStatus.MATCHED
    assert to_gtin14(upc) == to_gtin14("0085126302658")


def test_missing_brand_reduces_confidence_below_threshold():
    result = match_products(candidate(brand=None), candidate(brand=None))
    assert result.confidence < MINIMUM


def test_unknown_condition_on_one_side_is_penalised_not_assumed():
    result = match_products(candidate(), candidate(condition=ProductCondition.UNKNOWN))
    assert result.evidence["condition"] == "unknown on at least one side"
    assert result.confidence < Decimal("99")


def test_check_digit_helper_is_correct():
    assert gtin_check_digit("454873613458") == 4
    assert normalize(IdentifierType.EAN, "4548736134584").valid is True
    assert normalize(IdentifierType.EAN, "").is_none if False else normalize(IdentifierType.EAN, "") is None


@pytest.mark.parametrize("attribute", ["size", "capacity", "edition", "region", "compatibility"])
def test_every_variant_attribute_blocks_on_disagreement(attribute):
    result = match_products(
        candidate(attributes={attribute: "A"}), candidate(attributes={attribute: "B"})
    )
    assert result.status is MatchStatus.BLOCKED
