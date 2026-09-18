"""A single source of time.

Freshness rules, state timestamps and idempotency windows all depend on "now".
Routing every read through :func:`utcnow` keeps them consistent and lets tests
freeze time without patching :mod:`datetime` globally.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

_frozen: datetime | None = None


def utcnow() -> datetime:
    """Timezone-aware current UTC time (or the frozen test time)."""
    return _frozen or datetime.now(UTC)


def freeze(at: datetime) -> None:
    """Freeze :func:`utcnow` at ``at`` (tests only)."""
    global _frozen
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    _frozen = at


def unfreeze() -> None:
    global _frozen
    _frozen = None


def age_seconds(timestamp: datetime | None, *, now: datetime | None = None) -> float | None:
    """Age of ``timestamp`` in seconds, or ``None`` when it is unknown."""
    if timestamp is None:
        return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return ((now or utcnow()) - timestamp).total_seconds()


def is_stale(timestamp: datetime | None, max_age_seconds: int, *, now: datetime | None = None) -> bool:
    """``True`` when ``timestamp`` is missing or older than ``max_age_seconds``.

    Missing data counts as stale on purpose: absent information is never
    treated as favourable.
    """
    age = age_seconds(timestamp, now=now)
    return age is None or age > max_age_seconds


def seconds(value: int) -> timedelta:
    return timedelta(seconds=value)
