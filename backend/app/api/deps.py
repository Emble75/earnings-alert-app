"""FastAPI dependencies: database session, current user, services."""

from __future__ import annotations

from collections.abc import Generator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
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


#: Hosts that count as "this machine". A request from anywhere else is not a
#: single-user local install, whatever the configuration says.
LOCALHOST = {"127.0.0.1", "::1", "localhost", "testclient"}


def _local_user(session: Session) -> User | None:
    """The account used when sign-in is skipped on a local install."""
    settings = get_settings()
    email = settings.bootstrap_user_email.lower()
    user = session.execute(select(User).where(User.email == email)).scalars().first()
    if user is not None and user.is_active:
        return user
    return session.execute(select(User).where(User.is_active.is_(True))).scalars().first()


def get_current_user(
    request: Request,
    session: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    settings = get_settings()
    if settings.local_no_auth_permitted and not authorization:
        client_host = request.client.host if request.client else ""
        if client_host in LOCALHOST:
            user = _local_user(session)
            if user is None:
                raise AuthenticationError(
                    "sign-in is disabled but no operator account exists"
                )
            user_id_var.set(user.id)
            return user
        raise AuthenticationError(
            "sign-in is only skipped for requests from this machine"
        )
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
