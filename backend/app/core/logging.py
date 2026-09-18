"""Structured logging.

Logs are JSON by default so that ``request_id``, ``order_id``,
``opportunity_id``, ``provider``, ``action``, ``status`` and ``duration_ms``
are queryable fields rather than prose.  Secrets are scrubbed before a record
leaves the process.
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

import structlog

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[int | None] = ContextVar("user_id", default=None)

_SENSITIVE_KEYS = {
    "password",
    "secret",
    "secret_key",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "api_secret",
    "client_secret",
    "authorization",
    "webhook_secret",
    "smtp_password",
}


def _scrub(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    for key in list(event_dict):
        if key.lower() in _SENSITIVE_KEYS:
            event_dict[key] = "***redacted***"
    return event_dict


def _bind_context(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    request_id = request_id_var.get()
    if request_id and "request_id" not in event_dict:
        event_dict["request_id"] = request_id
    user_id = user_id_var.get()
    if user_id is not None and "user_id" not in event_dict:
        event_dict["user_id"] = user_id
    return event_dict


def configure_logging(level: str = "INFO", fmt: str = "json") -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=getattr(logging, level, logging.INFO))
    renderer = (
        structlog.processors.JSONRenderer()
        if fmt == "json"
        else structlog.dev.ConsoleRenderer(colors=False)
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _bind_context,
            _scrub,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level, logging.INFO)),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> Any:
    return structlog.get_logger(name)
