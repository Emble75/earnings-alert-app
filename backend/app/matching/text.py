"""Text normalisation used as *supplemental* matching evidence only.

Title similarity never establishes a match on its own.  It can confirm or
contradict an identifier-based match, and it can push a weak candidate into
review, but the threshold configuration makes a title-only match unreachable.
"""

from __future__ import annotations

import re
import unicodedata

_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")

#: Marketing noise that carries no identity information.
_STOPWORDS = frozenset(
    {
        "the", "and", "for", "with", "new", "original", "genuine", "official",
        "pcs", "pack", "set", "de", "der", "die", "das", "und", "fuer", "mit",
        "neu", "ovp", "inkl", "incl", "von", "in", "a", "an", "of",
    }
)


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_form = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    lowered = ascii_form.lower().replace("ß", "ss")
    return _SPACES.sub(" ", _PUNCT.sub(" ", lowered)).strip()


def tokenize(value: str | None) -> set[str]:
    return {token for token in normalize_text(value).split() if token and token not in _STOPWORDS}


def jaccard(left: str | None, right: str | None) -> float:
    """Token overlap in ``[0, 1]``.

    This is a *similarity heuristic*, not a monetary calculation, so a float
    is appropriate here; it never touches a price.
    """
    left_tokens, right_tokens = tokenize(left), tokenize(right)
    if not left_tokens or not right_tokens:
        return 0.0
    intersection = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    return intersection / union if union else 0.0


def contains_all_tokens(haystack: str | None, needle: str | None) -> bool:
    needle_tokens = tokenize(needle)
    return bool(needle_tokens) and needle_tokens <= tokenize(haystack)


def normalize_key(value: str | None) -> str:
    """Aggressive normalisation for brand / model comparison."""
    return re.sub(r"[\s\-_/.]", "", normalize_text(value))
