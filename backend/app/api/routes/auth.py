"""Authentication."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, TxSession
from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.errors import AuthenticationError
from app.core.security import create_access_token, verify_password
from app.models.user import User
from app.schemas.auth import LoginRequest, TokenResponse, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, session: TxSession) -> TokenResponse:
    user = session.execute(select(User).where(User.email == payload.email.lower())).scalars().first()
    # The same message for both failure modes, so the endpoint cannot be used
    # to enumerate which addresses have accounts.
    if user is None or not verify_password(payload.password, user.hashed_password):
        raise AuthenticationError("invalid email or password")
    if not user.is_active:
        raise AuthenticationError("this account is disabled")
    user.last_login_at = utcnow()
    settings = get_settings()
    return TokenResponse(
        access_token=create_access_token(str(user.id), role=user.role.value),
        expires_in=settings.access_token_expire_minutes * 60,
    )


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser, session: DbSession) -> User:
    return user
