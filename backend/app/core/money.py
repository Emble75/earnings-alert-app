"""Exact monetary arithmetic.

Every monetary value in this system is a :class:`Money` backed by
:class:`decimal.Decimal` and persisted as integer cents.  Floating point
arithmetic is never used for money - not in the engines, not in the API layer
and not in the database.

Rounding policy
---------------
All monetary results are quantised to 2 decimal places using ``ROUND_HALF_UP``
(the convention used by marketplace fee schedules and by invoices in the EU).
Percentages and ratios are kept as unrounded ``Decimal`` until the moment they
are presented, and are then quantised to 4 decimal places.
"""

from __future__ import annotations

from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

__all__ = [
    "CENT",
    "RATIO_EXP",
    "Money",
    "CurrencyMismatchError",
    "to_decimal",
    "quantize_money",
    "quantize_ratio",
    "percent_of",
]

CENT = Decimal("0.01")
RATIO_EXP = Decimal("0.0001")

Numeric = int | str | Decimal


class CurrencyMismatchError(ValueError):
    """Raised when two amounts in different currencies are combined."""


def to_decimal(value: Numeric | float) -> Decimal:
    """Convert ``value`` to :class:`Decimal` refusing lossy float input.

    ``float`` is rejected on purpose: ``0.1 + 0.2 != 0.3`` has no place in a
    financial engine.  Callers holding a float must convert it to ``str`` and
    accept responsibility for the precision they chose.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):  # bool is an int subclass - almost always a bug
        raise TypeError("bool is not a monetary value")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, str):
        try:
            return Decimal(value)
        except InvalidOperation as exc:
            raise ValueError(f"not a decimal value: {value!r}") from exc
    if isinstance(value, float):
        raise TypeError(
            "float is not accepted for monetary values; pass a str or Decimal instead"
        )
    raise TypeError(f"unsupported numeric type: {type(value).__name__}")


def quantize_money(value: Decimal) -> Decimal:
    """Quantise to 2 decimals, half-up."""
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def quantize_ratio(value: Decimal) -> Decimal:
    """Quantise a ratio/percentage to 4 decimals, half-up."""
    return value.quantize(RATIO_EXP, rounding=ROUND_HALF_UP)


class Money:
    """An immutable (amount, currency) pair with exact arithmetic."""

    __slots__ = ("_amount", "_currency")

    def __init__(self, amount: Numeric, currency: str = "EUR") -> None:
        if not currency or len(currency) != 3 or not currency.isalpha():
            raise ValueError(f"invalid ISO-4217 currency code: {currency!r}")
        self._amount = quantize_money(to_decimal(amount))
        self._currency = currency.upper()

    # -- constructors -------------------------------------------------------
    @classmethod
    def zero(cls, currency: str = "EUR") -> Money:
        return cls(Decimal("0"), currency)

    @classmethod
    def from_cents(cls, cents: int, currency: str = "EUR") -> Money:
        if not isinstance(cents, int) or isinstance(cents, bool):
            raise TypeError("cents must be an int")
        return cls(Decimal(cents) / Decimal(100), currency)

    # -- accessors ----------------------------------------------------------
    @property
    def amount(self) -> Decimal:
        return self._amount

    @property
    def currency(self) -> str:
        return self._currency

    @property
    def cents(self) -> int:
        return int(self._amount.scaleb(2).to_integral_value(rounding=ROUND_HALF_UP))

    # -- helpers ------------------------------------------------------------
    def _check(self, other: Money) -> None:
        if not isinstance(other, Money):
            raise TypeError(f"expected Money, got {type(other).__name__}")
        if other._currency != self._currency:
            raise CurrencyMismatchError(
                f"cannot combine {self._currency} with {other._currency}"
            )

    # -- arithmetic ---------------------------------------------------------
    def __add__(self, other: Money) -> Money:
        self._check(other)
        return Money(self._amount + other._amount, self._currency)

    def __sub__(self, other: Money) -> Money:
        self._check(other)
        return Money(self._amount - other._amount, self._currency)

    def __mul__(self, factor: Numeric) -> Money:
        return Money(self._amount * to_decimal(factor), self._currency)

    __rmul__ = __mul__

    def __truediv__(self, divisor: Numeric) -> Money:
        d = to_decimal(divisor)
        if d == 0:
            raise ZeroDivisionError("division of money by zero")
        return Money(self._amount / d, self._currency)

    def __neg__(self) -> Money:
        return Money(-self._amount, self._currency)

    def __abs__(self) -> Money:
        return Money(abs(self._amount), self._currency)

    def ratio_to(self, other: Money) -> Decimal | None:
        """``self / other`` as an exact ratio, or ``None`` if ``other`` is zero."""
        self._check(other)
        if other._amount == 0:
            return None
        return quantize_ratio(self._amount / other._amount)

    # -- comparisons --------------------------------------------------------
    def __eq__(self, other: Any) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        return self._amount == other._amount and self._currency == other._currency

    def __hash__(self) -> int:
        return hash((self._amount, self._currency))

    def __lt__(self, other: Money) -> bool:
        self._check(other)
        return self._amount < other._amount

    def __le__(self, other: Money) -> bool:
        self._check(other)
        return self._amount <= other._amount

    def __gt__(self, other: Money) -> bool:
        self._check(other)
        return self._amount > other._amount

    def __ge__(self, other: Money) -> bool:
        self._check(other)
        return self._amount >= other._amount

    def is_zero(self) -> bool:
        return self._amount == 0

    def is_positive(self) -> bool:
        return self._amount > 0

    def is_negative(self) -> bool:
        return self._amount < 0

    # -- representation -----------------------------------------------------
    def __repr__(self) -> str:
        return f"Money('{self._amount}', '{self._currency}')"

    def __str__(self) -> str:
        symbol = {"EUR": "€", "USD": "$", "GBP": "£"}.get(self._currency, "")
        return f"{symbol}{self._amount}" if symbol else f"{self._amount} {self._currency}"


def money_sum(values: Iterable[Money], currency: str = "EUR") -> Money:
    """Sum ``values``, returning ``Money.zero(currency)`` for an empty iterable."""
    total = Money.zero(currency)
    for value in values:
        total = total + value
    return total


def percent_of(base: Money, percent: Numeric) -> Money:
    """``percent`` per cent of ``base``, quantised half-up.

    ``percent`` is expressed in percentage points: ``percent_of(m, "12.5")``
    returns 12.5 % of ``m``.
    """
    return Money(base.amount * to_decimal(percent) / Decimal(100), base.currency)
