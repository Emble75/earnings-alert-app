"""FastAPI application.

Wiring only: middleware, error rendering, router mounting and first-boot
bootstrap.  Business logic lives in the services.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.api.routes import api_router
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging, get_logger, request_id_var
from app.core.security import hash_password
from app.db.session import get_engine, session_scope
from app.models import Base
from app.models.enums import UserRole
from app.models.user import User
from app.services.settings_service import SettingsService

logger = get_logger(__name__)


def bootstrap() -> None:
    """Make a fresh deployment usable without manual SQL.

    Creates the schema when Alembic has not been run (development and tests),
    materialises the default business configuration, and creates the operator
    account when one is configured. A production deployment should run
    ``alembic upgrade head`` instead of relying on ``create_all``.
    """
    settings = get_settings()
    if settings.environment in ("development", "test"):
        Base.metadata.create_all(get_engine())

    with session_scope() as session:
        SettingsService(session).ensure_defaults()
        if settings.bootstrap_user_email and settings.bootstrap_user_password:
            existing = session.execute(
                select(User).where(User.email == settings.bootstrap_user_email.lower())
            ).scalars().first()
            if existing is None:
                session.add(
                    User(
                        email=settings.bootstrap_user_email.lower(),
                        hashed_password=hash_password(settings.bootstrap_user_password),
                        full_name="Operator",
                        role=UserRole.ADMIN,
                    )
                )
                logger.info("bootstrap_user_created", email=settings.bootstrap_user_email)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    logger.info(
        "starting",
        environment=settings.environment,
        demo_mode=settings.effective_demo_mode,
        simulation_mode=settings.simulation_mode,
        automation_level=settings.automation_level,
    )
    if settings.effective_demo_mode and not settings.demo_mode:
        logger.warning(
            "demo_mode_forced",
            reason="provider credentials are incomplete; live trading is disabled",
        )
    bootstrap()
    yield
    logger.info("stopping")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        description=(
            "Amazon -> eBay sell-first arbitrage platform. "
            "Exact cash-based profit calculation, deterministic risk scoring, "
            "conservative product matching and a single source-purchase approval."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable]
    ):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        request.state.request_id = request_id
        token = request_id_var.set(request_id)
        started = time.monotonic()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        duration_ms = round((time.monotonic() - started) * 1000, 2)
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=duration_ms,
        )
        return response

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        # User-facing message stays readable; the technical detail is in the log.
        logger.warning(
            "app_error",
            code=exc.code,
            message=exc.message,
            context=exc.context,
            path=request.url.path,
        )
        return JSONResponse(status_code=exc.http_status, content=exc.to_dict())

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "request_validation_error",
                    "message": "the request body or query parameters are invalid",
                    "context": {"details": exc.errors()[:10]},
                    "retryable": False,
                }
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.error("unhandled_error", error=str(exc), path=request.url.path, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "an unexpected error occurred; the incident has been logged",
                    "context": {"request_id": request_id_var.get()},
                    "retryable": True,
                }
            },
        )

    app.include_router(api_router, prefix=settings.api_prefix)

    @app.get("/", include_in_schema=False)
    def root() -> dict:
        return {
            "name": settings.app_name,
            "docs": "/docs",
            "api": settings.api_prefix,
            "demo_mode": settings.effective_demo_mode,
        }

    return app


app = create_app()
