"""Exactly-once execution."""

from __future__ import annotations

import pytest

from app.core.errors import ConflictError
from app.core.ids import deterministic_key
from app.services.idempotency import IdempotencyService


def test_the_same_inputs_always_produce_the_same_key():
    assert deterministic_key("purchase", "ORD-1", 2) == deterministic_key("purchase", "ORD-1", 2)
    assert deterministic_key("purchase", "ORD-1", 2) != deterministic_key("purchase", "ORD-2", 2)


def test_a_claim_can_only_be_made_once(session):
    service = IdempotencyService(session)
    first = service.claim("purchase", "key-1")
    assert first.replayed is False
    second = service.claim("purchase", "key-1")
    assert second.replayed is True
    assert second.record.id == first.record.id


def test_run_once_executes_the_work_a_single_time(session):
    service = IdempotencyService(session)
    calls = {"count": 0}

    def work():
        calls["count"] += 1
        return "done"

    assert service.run_once("scope", "key", work) == "done"
    with pytest.raises(ConflictError):
        service.run_once("scope", "key", work)
    assert calls["count"] == 1


def test_a_replay_can_return_the_recorded_result(session):
    service = IdempotencyService(session)
    service.run_once("scope", "key", lambda: "first")
    replayed = service.run_once(
        "scope", "key", lambda: "second", on_replay=lambda record: f"replayed:{record.status}"
    )
    assert replayed == "replayed:COMPLETED"


def test_a_failure_is_recorded_and_re_raises(session):
    service = IdempotencyService(session)

    def boom():
        raise ValueError("nope")

    with pytest.raises(ValueError):
        service.run_once("scope", "fail-key", boom)
    record = service.find("scope", "fail-key")
    assert record.status == "FAILED"
    assert "nope" in record.result["error"]


def test_scopes_are_independent(session):
    service = IdempotencyService(session)
    assert service.claim("purchase", "shared").replayed is False
    assert service.claim("shipment", "shared").replayed is False
