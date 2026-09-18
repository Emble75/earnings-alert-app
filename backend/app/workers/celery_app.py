"""Celery application and schedule.

Every task is written to be safe to run twice: they operate through the same
idempotent services the API uses, so a redelivered message or a restarted
worker cannot double-purchase, double-ship or double-refund.
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.core.config import get_settings
from app.core.logging import configure_logging

settings = get_settings()

celery_app = Celery(
    "arbitrage",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    # With acks_late, a worker that dies mid-task must not have its message
    # silently dropped; redelivery is safe because the tasks are idempotent.
    task_reject_on_worker_lost=True,
    task_time_limit=600,
    task_soft_time_limit=540,
    worker_prefetch_multiplier=1,
    task_default_retry_delay=30,
    task_always_eager=settings.celery_task_always_eager,
    broker_connection_retry_on_startup=True,
    task_routes={
        "app.workers.tasks.execute_approved_orders": {"queue": "money"},
        "app.workers.tasks.process_sale": {"queue": "money"},
    },
)

celery_app.conf.beat_schedule = {
    "discover-products": {
        "task": "app.workers.tasks.discover_products",
        "schedule": crontab(minute="*/30"),
    },
    "refresh-prices": {
        "task": "app.workers.tasks.refresh_prices",
        "schedule": crontab(minute="*/10"),
    },
    "refresh-inventory": {
        "task": "app.workers.tasks.refresh_inventory",
        "schedule": crontab(minute="*/10"),
    },
    "calculate-opportunities": {
        "task": "app.workers.tasks.calculate_opportunities",
        "schedule": crontab(minute="*/15"),
    },
    "revalidate-opportunities": {
        "task": "app.workers.tasks.revalidate_opportunities",
        "schedule": crontab(minute="*/20"),
    },
    "monitor-listings": {
        "task": "app.workers.tasks.monitor_listings",
        "schedule": crontab(minute="*/30"),
    },
    "poll-sales": {
        "task": "app.workers.tasks.poll_sales",
        "schedule": crontab(minute="*/5"),
    },
    "revalidate-orders": {
        "task": "app.workers.tasks.revalidate_orders",
        "schedule": crontab(minute="*/5"),
    },
    "execute-approved-orders": {
        "task": "app.workers.tasks.execute_approved_orders",
        "schedule": crontab(minute="*/5"),
    },
    "monitor-shipments": {
        "task": "app.workers.tasks.monitor_shipments",
        "schedule": crontab(minute="0", hour="*/2"),
    },
    "process-returns": {
        "task": "app.workers.tasks.process_returns",
        "schedule": crontab(minute="15", hour="*/2"),
    },
    "send-notifications": {
        "task": "app.workers.tasks.send_notifications",
        "schedule": crontab(minute="*/2"),
    },
    "expire-opportunities": {
        "task": "app.workers.tasks.expire_opportunities",
        "schedule": crontab(minute="5", hour="*"),
    },
}


@celery_app.on_after_configure.connect
def _setup_logging(sender, **_kwargs):  # pragma: no cover - celery signal
    configure_logging(settings.log_level, settings.log_format)
