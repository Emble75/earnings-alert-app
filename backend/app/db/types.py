"""Custom SQLAlchemy column types.

:class:`MoneyCents` is the reason this module exists: money is persisted as a
signed integer number of cents (``BIGINT``) and surfaced in Python as an exact
:class:`~decimal.Decimal`.  That representation is identical on PostgreSQL and
on SQLite, immune to float coercion by any driver, and safe to SUM() in SQL.
"""

from __future__ import annotations

import json
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import BigInteger, Numeric, Text, TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.types import JSON

CENT = Decimal("0.01")


class MoneyCents(TypeDecorator):
    """Stores a monetary amount as integer cents, returns ``Decimal``."""

    impl = BigInteger
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, float):
            raise TypeError("refusing to persist a float as money")
        if isinstance(value, (int, str)):
            value = Decimal(value)
        elif not isinstance(value, Decimal):
            # Money value objects expose .amount
            amount = getattr(value, "amount", None)
            if amount is None:
                raise TypeError(f"cannot persist {type(value).__name__} as money")
            value = amount
        return int(value.scaleb(2).to_integral_value(rounding=ROUND_HALF_UP))

    def process_result_value(self, value: Any, dialect: Any) -> Decimal | None:
        if value is None:
            return None
        return (Decimal(int(value)) / Decimal(100)).quantize(CENT)


class Ratio(TypeDecorator):
    """A unit-less ratio (margin, ROI, probability) with 6 decimal places."""

    impl = Numeric(18, 6)
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Decimal | None:
        if value is None:
            return None
        if isinstance(value, float):
            raise TypeError("refusing to persist a float as a ratio")
        return Decimal(str(value)) if not isinstance(value, Decimal) else value

    def process_result_value(self, value: Any, dialect: Any) -> Decimal | None:
        return None if value is None else Decimal(str(value))


class JSONDict(TypeDecorator):
    """``JSONB`` on PostgreSQL, portable JSON elsewhere."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())


class StringEnum(TypeDecorator):
    """Persists a ``str``-valued Enum by *value* (never by name or ordinal).

    Storing the value keeps the database readable and means reordering the
    Python enum can never silently remap historical rows.
    """

    impl = Text
    cache_ok = True

    def __init__(self, enum_cls: type, **kwargs: Any) -> None:
        self.enum_cls = enum_cls
        super().__init__(**kwargs)

    def process_bind_param(self, value: Any, dialect: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, self.enum_cls):
            return value.value
        candidate = str(value)
        self.enum_cls(candidate)  # raises ValueError on an unknown member
        return candidate

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        return None if value is None else self.enum_cls(value)


def dumps(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)
