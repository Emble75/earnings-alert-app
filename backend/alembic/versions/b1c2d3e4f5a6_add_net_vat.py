"""add net_vat to profit_calculations

A profit figure that ignores VAT is wrong for any seller on the standard
scheme, by roughly a fifth of the sale price. The column is signed and
defaults to zero, which is the small-business case and leaves every existing
row exactly as it was calculated.

Revision ID: b1c2d3e4f5a6
Revises: 7344a3f33550
Create Date: 2026-09-19
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b1c2d3e4f5a6'
down_revision: str | None = '7344a3f33550'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'profit_calculations',
        sa.Column('net_vat', sa.BigInteger(), nullable=False, server_default='0'),
    )
    # The default was only needed to backfill; new rows always state it.
    op.alter_column('profit_calculations', 'net_vat', server_default=None)


def downgrade() -> None:
    op.drop_column('profit_calculations', 'net_vat')
