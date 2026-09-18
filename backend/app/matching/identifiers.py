"""Product identifier normalisation and validation.

An identifier is only evidence if it is *valid*.  A UPC with a broken check
digit is a typo or a scrape artefact, and trusting it is exactly how two
different products end up "matched" at 99 % confidence.  Everything here is
deterministic and side-effect free.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.models.enums import IdentifierType

#: Identifier types that, on their own, are strong enough evidence of identity.
STRONG_IDENTIFIERS = (
    IdentifierType.EAN,
    IdentifierType.GTIN,
    IdentifierType.UPC,
    IdentifierType.ISBN,
)

_NON_ALNUM = re.compile(r"[^0-9A-Za-z]")


@dataclass(frozen=True)
class NormalizedIdentifier:
    type: IdentifierType
    value: str
    valid: bool
    #: GTIN-14 normalised form, so EAN-13 / UPC-12 / GTIN-14 of the same
    #: article compare equal.
    canonical: str | None
    reason: str = ""


def _digits(value: str) -> str:
    return _NON_ALNUM.sub("", value or "").upper()


def gtin_check_digit(body: str) -> int:
    """Standard GS1 mod-10 check digit for the first n-1 digits."""
    total = 0
    for index, char in enumerate(reversed(body)):
        weight = 3 if index % 2 == 0 else 1
        total += int(char) * weight
    return (10 - (total % 10)) % 10


def is_valid_gtin(value: str) -> bool:
    if not value.isdigit() or len(value) not in (8, 12, 13, 14):
        return False
    return gtin_check_digit(value[:-1]) == int(value[-1])


def to_gtin14(value: str) -> str | None:
    """Zero-pad a valid GTIN-8/12/13 to its GTIN-14 form."""
    if not is_valid_gtin(value):
        return None
    return value.rjust(14, "0")


def is_valid_isbn(value: str) -> bool:
    cleaned = _digits(value)
    if len(cleaned) == 13:
        return is_valid_gtin(cleaned)
    if len(cleaned) != 10:
        return False
    total = 0
    for index, char in enumerate(cleaned):
        digit = 10 if char == "X" and index == 9 else (int(char) if char.isdigit() else None)
        if digit is None:
            return False
        total += digit * (10 - index)
    return total % 11 == 0


def normalize(identifier_type: IdentifierType, raw: str | None) -> NormalizedIdentifier | None:
    """Normalise and validate one identifier, or return ``None`` if empty."""
    if raw is None:
        return None
    cleaned = _digits(str(raw))
    if not cleaned:
        return None

    if identifier_type in (IdentifierType.EAN, IdentifierType.GTIN, IdentifierType.UPC):
        valid = is_valid_gtin(cleaned)
        return NormalizedIdentifier(
            type=identifier_type,
            value=cleaned,
            valid=valid,
            canonical=to_gtin14(cleaned) if valid else None,
            reason="" if valid else "check digit or length invalid",
        )
    if identifier_type is IdentifierType.ISBN:
        valid = is_valid_isbn(cleaned)
        canonical = to_gtin14(cleaned) if len(cleaned) == 13 and valid else None
        return NormalizedIdentifier(
            type=identifier_type,
            value=cleaned,
            valid=valid,
            canonical=canonical,
            reason="" if valid else "ISBN checksum invalid",
        )
    # ASIN / MPN / SKU / model: no checksum exists, so validity means
    # "plausibly formed", never "verified".
    valid = len(cleaned) >= 3
    return NormalizedIdentifier(
        type=identifier_type,
        value=cleaned,
        valid=valid,
        canonical=cleaned if valid else None,
        reason="" if valid else "too short to be meaningful",
    )


def normalize_map(raw: dict[str, str | None] | None) -> dict[IdentifierType, NormalizedIdentifier]:
    """Normalise a ``{"EAN": "...", "MPN": "..."}`` mapping."""
    result: dict[IdentifierType, NormalizedIdentifier] = {}
    for key, value in (raw or {}).items():
        try:
            identifier_type = IdentifierType(str(key).upper())
        except ValueError:
            continue
        normalized = normalize(identifier_type, value)
        if normalized is not None:
            result[identifier_type] = normalized
    return result
