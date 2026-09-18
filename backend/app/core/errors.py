"""Structured application errors.

Every failure carries a stable machine-readable ``code``, a human-readable
``message`` and a ``context`` mapping.  Nothing fails silently: services raise
:class:`AppError` subclasses, the API layer renders them as a consistent JSON
body, and the audit log stores the code.
"""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Base class for all application errors."""

    code: str = "internal_error"
    http_status: int = 500
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        context: dict[str, Any] | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        self.context = context or {}
        if retryable is not None:
            self.retryable = retryable

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "context": self.context,
                "retryable": self.retryable,
            }
        }


class ValidationError(AppError):
    code = "validation_error"
    http_status = 422


class NotFoundError(AppError):
    code = "not_found"
    http_status = 404


class ConflictError(AppError):
    code = "conflict"
    http_status = 409


class AuthenticationError(AppError):
    code = "authentication_failed"
    http_status = 401


class AuthorizationError(AppError):
    code = "not_authorized"
    http_status = 403


class InvalidTransitionError(ConflictError):
    code = "invalid_state_transition"


class LimitExceededError(AppError):
    """A configured capital/volume limit would be breached."""

    code = "limit_exceeded"
    http_status = 409


class ComplianceBlockedError(AppError):
    """A compliance rule blocks the requested external action."""

    code = "compliance_blocked"
    http_status = 409


class StaleDataError(AppError):
    """Data required for a financial commitment is too old to be trusted."""

    code = "stale_data"
    http_status = 409


class ProviderError(AppError):
    """A source/target/fulfilment provider failed."""

    code = "provider_error"
    http_status = 502
    retryable = True


class ProviderRateLimitedError(ProviderError):
    code = "provider_rate_limited"
    http_status = 429
    retryable = True


class CircuitOpenError(ProviderError):
    code = "provider_circuit_open"
    http_status = 503
    retryable = True
