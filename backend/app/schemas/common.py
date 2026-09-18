"""Shared API schema pieces.

Money crosses the API boundary as a decimal *string* on purpose: JSON numbers
are IEEE-754 doubles in most clients, and a JavaScript frontend parsing
``25.00`` as a float would reintroduce exactly the imprecision the backend
works to avoid.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_serializer

T = TypeVar("T")


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class MoneyOut(ApiModel):
    amount: str
    currency: str = "EUR"

    @classmethod
    def of(cls, value: Decimal | None, currency: str = "EUR") -> MoneyOut | None:
        return None if value is None else cls(amount=str(value), currency=currency)


class Page(ApiModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ErrorBody(ApiModel):
    code: str
    message: str
    context: dict[str, Any] = Field(default_factory=dict)
    retryable: bool = False


class ErrorResponse(ApiModel):
    error: ErrorBody


class DecimalStringMixin(BaseModel):
    """Serialises every Decimal field as a string."""

    @field_serializer("*", when_used="json")
    def _serialize(self, value: Any) -> Any:
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        return value
