"""Test fixtures.

Tests run against an in-memory SQLite database created from the ORM metadata.
The schema itself is separately verified against PostgreSQL by the Alembic
migration (see docs/deployment.md); these tests are about behaviour.
"""

from __future__ import annotations

import os
from decimal import Decimal

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production")
os.environ.setdefault("DEMO_MODE", "true")
os.environ.setdefault("LOG_LEVEL", "CRITICAL")

from sqlalchemy.orm import Session, sessionmaker  # noqa: E402

from app.core import clock  # noqa: E402
from app.core.money import Money  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.db.session import _create_engine  # noqa: E402
from app.models import Base  # noqa: E402
from app.models.enums import UserRole  # noqa: E402
from app.models.user import User  # noqa: E402
from app.providers.registry import ProviderBundle, build_providers  # noqa: E402
from app.services.settings_service import BusinessConfig, SettingsService  # noqa: E402


@pytest.fixture(autouse=True)
def _unfreeze_clock():
    yield
    clock.unfreeze()


@pytest.fixture(autouse=True)
def _isolate_providers():
    """Reset the process-wide provider cache between tests.

    The demo providers hold in-memory state (published listings, simulated
    sales, placed purchases). Leaking that between tests would make results
    depend on execution order.
    """
    from app.providers.registry import reset_providers

    reset_providers()
    yield
    reset_providers()


@pytest.fixture
def engine():
    # Use the application's own factory so the test database gets the same
    # SQLite settings the app relies on (StaticPool, check_same_thread=False);
    # TestClient runs endpoints on worker threads.
    engine = _create_engine("sqlite://")
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture
def session(engine) -> Session:
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def config(session) -> BusinessConfig:
    return SettingsService(session).ensure_defaults()


@pytest.fixture
def providers() -> ProviderBundle:
    """A fresh provider bundle per test, so in-memory provider state is isolated."""
    return build_providers()


@pytest.fixture
def operator(session) -> User:
    user = User(
        email="operator@example.com",
        hashed_password=hash_password("test-password"),
        full_name="Test Operator",
        role=UserRole.ADMIN,
    )
    session.add(user)
    session.flush()
    return user


@pytest.fixture
def eur():
    def _make(amount: str) -> Money:
        return Money(Decimal(amount), "EUR")

    return _make


@pytest.fixture
def api_client(engine, monkeypatch):
    """A TestClient wired to the test database."""
    from fastapi.testclient import TestClient

    from app.db import session as db_session

    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_session_factory", factory)

    from app.main import create_app

    app = create_app()
    with TestClient(app) as client:
        yield client
