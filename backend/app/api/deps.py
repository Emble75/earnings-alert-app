"""FastAPI dependencies: database session, current user, services."""

from __future__ import annotations

from collections.abc import Generator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from app.core.errors import AuthenticationError, AuthorizationError
from app.core.logging import user_id_var
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.providers.registry import ProviderBundle, get_providers
from app.services.settings_service import BusinessConfig, SettingsService

DbSession = Annotated[Session, Depends(get_db)]


def get_config(session: DbSession) -> BusinessConfig:
    return SettingsService(session).load()


BusinessSettings = Annotated[BusinessConfig, Depends(get_config)]


def get_provider_bundle() -> ProviderBundle:
    return get_providers()


Providers = Annotated[ProviderBundle, Depends(get_provider_bundle)]


def get_current_user(
    session: DbSession, authorization: Annotated[str | None, Header()] = None
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthenticationError("missing bearer token")
    payload = decode_access_token(authorization.split(" ", 1)[1].strip())
    try:
        user_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        raise AuthenticationError("malformed token subject") from None
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("user does not exist or is inactive")
    user_id_var.set(user.id)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_operator(user: CurrentUser) -> User:
    """Anything that changes state needs an operator or admin."""
    if user.role is UserRole.VIEWER:
        raise AuthorizationError("this action requires an operator role")
    return user


Operator = Annotated[User, Depends(require_operator)]


def require_admin(user: CurrentUser) -> User:
    if user.role is not UserRole.ADMIN:
        raise AuthorizationError("this action requires an admin role")
    return user


Admin = Annotated[User, Depends(require_admin)]


def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


def transactional(session: DbSession) -> Generator[Session, None, None]:
    """Commit on success, roll back on any exception."""
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise


TxSession = Annotated[Session, Depends(transactional)]
