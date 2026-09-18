"""Password hashing and JWT access tokens."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import bcrypt
from jose import JWTError, jwt

from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.errors import AuthenticationError

# bcrypt refuses inputs longer than 72 bytes; pre-truncating keeps long
# passphrases usable instead of raising at signup time.
_MAX_PASSWORD_BYTES = 72


def _prepare(password: str) -> bytes:
    return password.encode("utf-8")[:_MAX_PASSWORD_BYTES]


def hash_password(password: str) -> str:
    if not password:
        raise ValueError("password must not be empty")
    return bcrypt.hashpw(_prepare(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_prepare(password), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(subject: str, *, expires_delta: timedelta | None = None, **claims: Any) -> str:
    settings = get_settings()
    expire = utcnow() + (expires_delta or timedelta(minutes=settings.access_token_expire_minutes))
    payload: dict[str, Any] = {"sub": subject, "exp": expire, "iat": utcnow(), **claims}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError as exc:
        raise AuthenticationError("invalid or expired access token") from exc
