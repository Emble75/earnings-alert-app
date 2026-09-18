"""Rate limiting, retry and circuit breaking for outbound provider calls.

Providers are shared, metered resources.  Hammering one gets an account
throttled or banned, which in this system means losing the ability to buy the
thing we have already sold.  Every live provider call goes through here.
"""

from __future__ import annotations

import random
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from app.core.errors import CircuitOpenError, ProviderError, ProviderRateLimitedError
from app.core.logging import get_logger

T = TypeVar("T")
logger = get_logger(__name__)


@dataclass
class RateLimit:
    """Token-bucket style sliding window limiter."""

    max_calls: int
    per_seconds: float
    _calls: deque[float] = field(default_factory=deque, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def acquire(self, *, block: bool = True, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                now = time.monotonic()
                while self._calls and now - self._calls[0] >= self.per_seconds:
                    self._calls.popleft()
                if len(self._calls) < self.max_calls:
                    self._calls.append(now)
                    return
                wait = self.per_seconds - (now - self._calls[0])
            if not block:
                raise ProviderRateLimitedError(
                    "local rate limit reached", context={"max_calls": self.max_calls}
                )
            if time.monotonic() + wait > deadline:
                raise ProviderRateLimitedError(
                    "timed out waiting for rate limit headroom",
                    context={"waited_for": round(wait, 3)},
                )
            time.sleep(min(wait, 0.25))


@dataclass
class CircuitBreaker:
    """Stops calling a provider that is consistently failing."""

    failure_threshold: int = 5
    reset_timeout: float = 60.0
    _failures: int = 0
    _opened_at: float | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def state(self) -> str:
        with self._lock:
            if self._opened_at is None:
                return "CLOSED"
            if time.monotonic() - self._opened_at >= self.reset_timeout:
                return "HALF_OPEN"
            return "OPEN"

    def before_call(self, provider: str) -> None:
        if self.state == "OPEN":
            raise CircuitOpenError(
                f"circuit breaker is open for provider {provider}",
                context={"provider": provider, "failures": self._failures},
            )

    def record_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._opened_at = time.monotonic()


@dataclass
class RetryPolicy:
    attempts: int = 3
    base_delay: float = 0.5
    max_delay: float = 8.0
    jitter: float = 0.25

    def delay_for(self, attempt: int) -> float:
        """Exponential backoff with jitter, so retries do not synchronise."""
        delay = min(self.base_delay * (2 ** (attempt - 1)), self.max_delay)
        return delay + random.uniform(0, self.jitter * delay)  # noqa: S311 - not security related


@dataclass
class ProviderGuard:
    """Rate limit + circuit breaker + retry around one provider."""

    provider: str
    rate_limit: RateLimit | None = None
    breaker: CircuitBreaker = field(default_factory=CircuitBreaker)
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    sleeper: Callable[[float], None] = time.sleep

    def call(self, action: str, func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        last_error: Exception | None = None
        for attempt in range(1, self.retry.attempts + 1):
            self.breaker.before_call(self.provider)
            if self.rate_limit is not None:
                self.rate_limit.acquire()
            started = time.monotonic()
            try:
                result = func(*args, **kwargs)
            except ProviderError as exc:
                last_error = exc
                self.breaker.record_failure()
                logger.warning(
                    "provider_call_failed",
                    provider=self.provider,
                    action=action,
                    attempt=attempt,
                    error=str(exc),
                    retryable=exc.retryable,
                )
                if not exc.retryable or attempt == self.retry.attempts:
                    raise
                self.sleeper(self.retry.delay_for(attempt))
            except Exception as exc:  # non-provider errors are bugs: do not retry
                self.breaker.record_failure()
                logger.error("provider_call_error", provider=self.provider, action=action, error=str(exc))
                raise ProviderError(
                    f"{self.provider}.{action} failed: {exc}",
                    context={"provider": self.provider, "action": action},
                    retryable=False,
                ) from exc
            else:
                self.breaker.record_success()
                logger.info(
                    "provider_call",
                    provider=self.provider,
                    action=action,
                    status="ok",
                    duration_ms=round((time.monotonic() - started) * 1000, 2),
                )
                return result
        raise last_error or ProviderError(f"{self.provider}.{action} exhausted retries")
