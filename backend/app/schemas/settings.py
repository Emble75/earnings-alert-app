from __future__ import annotations

from typing import Any

from pydantic import Field

from app.schemas.common import ApiModel


class SettingsOut(ApiModel):
    values: dict[str, Any]
    groups: dict[str, list[str]]
    runtime: dict[str, Any]


class SettingsUpdateRequest(ApiModel):
    updates: dict[str, Any] = Field(min_length=1)
