"""Money must be exact. These tests exist to keep it that way."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.money import CurrencyMismatchError, Money, money_sum, percent_of, to_decimal


def test_addition_is_exact_where_float_is_not():
    assert Money("0.1") + Money("0.2") == Money("0.3")
    assert (Money("0.1") + Money("0.2")).amount == Decimal("0.30")


def test_floats_are_rejected_everywhere():
    with pytest.raises(TypeError):
        Money(1.5)
    with pytest.raises(TypeError):
        to_decimal(0.1)
    with pytest.raises(TypeError):
        Money("1.00") * 1.5


def test_bool_is_not_money():
    with pytest.raises(TypeError):
        Money(True)


def test_cents_round_trip():
    assert Money("25.00").cents == 2500
    assert Money.from_cents(2500) == Money("25.00")
    assert Money.from_cents(-599) == Money("-5.99")


def test_rounding_is_half_up():
    assert Money("0.005").amount == Decimal("0.01")
    assert Money("2.345").amount == Decimal("2.35")


def test_currency_mismatch_is_refused():
    with pytest.raises(CurrencyMismatchError):
        Money("10.00", "EUR") + Money("10.00", "USD")


def test_percent_of_matches_the_spec_example():
    # 2.5 % of 159.99 is 3.99975, which must round to the 4.00 in the spec.
    assert percent_of(Money("159.99"), Decimal("2.5")) == Money("4.00")


def test_ratio_to_handles_zero():
    assert Money("10.00").ratio_to(Money("0.00")) is None
    assert Money("25.00").ratio_to(Money("159.99")) == Decimal("0.1563")


def test_money_sum_of_empty_is_zero():
    assert money_sum([]) == Money("0.00")
    assert money_sum([Money("1.10"), Money("2.20")]) == Money("3.30")


def test_division_by_zero_is_refused():
    with pytest.raises(ZeroDivisionError):
        Money("10.00") / 0
