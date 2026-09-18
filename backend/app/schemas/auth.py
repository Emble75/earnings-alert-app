from __future__ import annotations

from datetime import datetime

from pydantic import EmailStr, Field

from app.models.enums import UserRole
from app.schemas.common import ApiModel


class LoginRequest(ApiModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class TokenResponse(ApiModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserOut(ApiModel):
    id: int
    email: str
    full_name: str | None = None
    role: UserRole
    is_active: bool
    last_login_at: datetime | None = None
