"""Runtime business configuration.

Business rules (thresholds, limits, cost assumptions) live here rather than in
the environment so the operator can change them without a redeploy, and so
every change is auditable.  Values are stored as strings and parsed through
:mod:`app.services.settings_service`, which owns the typed schema.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Setting(Base, IdMixin, TimestampMixin):
    __tablename__ = "settings"
    __table_args__ = (Index("ix_settings_group", "group"),)

    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    value_type: Mapped[str] = mapped_column(String(20), nullable=False, default="string")
    group: Mapped[str] = mapped_column(String(50), nullable=False, default="general")
    description: Mapped[str | None] = mapped_column(Text)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Setting {self.key}={'***' if self.is_sensitive else self.value}>"
