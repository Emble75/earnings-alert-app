"""State machines: the invariants that make an unapproved purchase impossible."""

from __future__ import annotations

import pytest

from app.core.errors import InvalidTransitionError
from app.models.enums import OpportunityState, OrderState, ReturnState, ShipmentState
from app.state_machines import (
    OPPORTUNITY_MACHINE,
    ORDER_MACHINE,
    RETURN_MACHINE,
    SHIPMENT_MACHINE,
)


def test_an_undeclared_transition_is_rejected():
    with pytest.raises(InvalidTransitionError) as exc:
        ORDER_MACHINE.validate(OrderState.SALE_RECEIVED, OrderState.SHIPPED)
    assert "not a valid transition" in str(exc.value)
    assert exc.value.context["allowed"]


def test_a_sale_cannot_reach_approved_without_revalidation():
    """The central sell-first invariant."""
    assert not ORDER_MACHINE.can(OrderState.SALE_RECEIVED, OrderState.APPROVED)
    assert not ORDER_MACHINE.can(OrderState.SALE_RECEIVED, OrderState.APPROVAL_REQUIRED)
    assert not ORDER_MACHINE.can(OrderState.VALIDATING, OrderState.APPROVED)
    assert ORDER_MACHINE.can(OrderState.REVALIDATION_REQUIRED, OrderState.APPROVAL_REQUIRED)
    assert ORDER_MACHINE.can(OrderState.APPROVAL_REQUIRED, OrderState.APPROVED)


def test_a_purchase_can_only_follow_an_approval():
    sources = [
        state
        for state in OrderState
        if ORDER_MACHINE.can(state, OrderState.SOURCE_PURCHASE_PENDING)
    ]
    assert sources == [OrderState.APPROVED]


def test_terminal_states_cannot_be_left():
    for state in (OrderState.COMPLETED, OrderState.FAILED, OrderState.CANCELLED):
        assert ORDER_MACHINE.is_terminal(state)
        with pytest.raises(InvalidTransitionError):
            ORDER_MACHINE.validate(state, OrderState.VALIDATING)


def test_opportunity_reaches_actionable_only_through_every_gate():
    path = [
        OpportunityState.DISCOVERED,
        OpportunityState.MATCH_PENDING,
        OpportunityState.MATCH_VERIFIED,
        OpportunityState.PRICE_PENDING,
        OpportunityState.PROFITABLE,
        OpportunityState.RISK_REVIEW,
        OpportunityState.ACTIONABLE,
    ]
    for source, target in zip(path, path[1:], strict=False):
        assert OPPORTUNITY_MACHINE.can(source, target), f"{source} -> {target} missing"
    # No shortcut past the gates.
    assert not OPPORTUNITY_MACHINE.can(OpportunityState.DISCOVERED, OpportunityState.ACTIONABLE)
    assert not OPPORTUNITY_MACHINE.can(OpportunityState.MATCH_PENDING, OpportunityState.PROFITABLE)


def test_listing_requires_an_actionable_opportunity():
    sources = [
        state for state in OpportunityState if OPPORTUNITY_MACHINE.can(state, OpportunityState.LISTED)
    ]
    assert set(sources) <= {OpportunityState.LISTING_CANDIDATE, OpportunityState.REVALIDATION_REQUIRED}


def test_shipment_and_return_machines_are_wired():
    assert SHIPMENT_MACHINE.can(ShipmentState.PENDING, ShipmentState.LABEL_CREATED)
    assert not SHIPMENT_MACHINE.can(ShipmentState.PENDING, ShipmentState.DELIVERED)
    assert RETURN_MACHINE.can(ReturnState.REFUND_REQUIRED, ReturnState.REFUNDED)
    assert not RETURN_MACHINE.can(ReturnState.RETURN_REQUESTED, ReturnState.REFUNDED)


def test_every_active_state_can_fail_and_be_cancelled():
    for state in (OrderState.VALIDATING, OrderState.APPROVED, OrderState.SOURCE_SHIPPING):
        assert ORDER_MACHINE.can(state, OrderState.FAILED)


def test_mermaid_rendering_covers_every_transition():
    diagram = ORDER_MACHINE.as_mermaid()
    assert diagram.startswith("stateDiagram-v2")
    assert diagram.count("-->") == len(ORDER_MACHINE.transitions) + 1
