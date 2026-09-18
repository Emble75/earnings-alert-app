"""Alembic environment.

The database URL always comes from the application settings, so migrations
and the running application can never disagree about which database they are
talking to.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import get_settings
from app.models import Base  # noqa: F401 - registers every mapper

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata


def render_item(type_, obj, autogen_context):
    """Render the application's custom column types as plain DDL types.

    A migration should describe the database, not import application code:
    keeping ``app.db.types`` out of the generated files means old migrations
    keep working after those classes are refactored or moved.
    """
    if type_ != "type":
        return False
    name = type(obj).__name__
    if name == "MoneyCents":
        return "sa.BigInteger()"
    if name == "Ratio":
        return "sa.Numeric(precision=18, scale=6)"
    if name == "StringEnum":
        return "sa.Text()"
    if name == "JSONDict":
        autogen_context.imports.add("from sqlalchemy.dialects import postgresql")
        return "postgresql.JSONB(astext_type=sa.Text())"
    return False


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            render_item=render_item,
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
