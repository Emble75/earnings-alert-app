"""Generic, explicit state machine.

A transition exists only if it is declared.  Anything else raises
:class:`~app.core.errors.InvalidTransitionError` - there is no "just set the
column" path anywhere in the services, which is what keeps a crashed worker or
a replayed webhook from teleporting an order into ``APPROVED``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import Enum
from typing import Generic, TypeVar

from app.core.errors import InvalidTransitionError

S = TypeVar("S", bound=Enum)


@dataclass(frozen=True)
class Transition(Generic[S]):
    source: S
    target: S
    label: str = ""
    requires_approval: bool = False
    external_effect: bool = False
    """``True`` when entering the target state touches the outside world
    (money, marketplace, carrier).  Compliance must pass before these."""


@dataclass
class StateMachine(Generic[S]):
    name: str
    initial: S
    transitions: list[Transition[S]]
    terminal_states: frozenset[S] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        self._index: dict[tuple[S, S], Transition[S]] = {
            (t.source, t.target): t for t in self.transitions
        }

    def allowed_targets(self, source: S) -> list[S]:
        return [t.target for t in self.transitions if t.source == source]

    def can(self, source: S, target: S) -> bool:
        return (source, target) in self._index

    def get(self, source: S, target: S) -> Transition[S]:
        try:
            return self._index[(source, target)]
        except KeyError:
            raise InvalidTransitionError(
                f"{self.name}: {source.value} -> {target.value} is not a valid transition",
                context={
                    "machine": self.name,
                    "from": source.value,
                    "to": target.value,
                    "allowed": [s.value for s in self.allowed_targets(source)],
                },
            ) from None

    def validate(self, source: S, target: S) -> Transition[S]:
        """Raise unless ``source -> target`` is declared.

        Re-entering the same state is rejected too: an idempotent operation
        must short-circuit *before* asking for a transition, so that a repeated
        webhook cannot append a second history row.
        """
        if source in self.terminal_states:
            raise InvalidTransitionError(
                f"{self.name}: {source.value} is terminal",
                context={"machine": self.name, "from": source.value, "to": target.value},
            )
        return self.get(source, target)

    def is_terminal(self, state: S) -> bool:
        return state in self.terminal_states

    def reachable_from(self, source: S) -> set[S]:
        """Transitive closure - used by tests and by the docs generator."""
        seen: set[S] = set()
        frontier: list[S] = [source]
        while frontier:
            current = frontier.pop()
            for target in self.allowed_targets(current):
                if target not in seen:
                    seen.add(target)
                    frontier.append(target)
        return seen

    def as_mermaid(self) -> str:  # pragma: no cover - documentation helper
        lines = ["stateDiagram-v2"]
        lines.append(f"    [*] --> {self.initial.value}")
        for t in self.transitions:
            label = f": {t.label}" if t.label else ""
            lines.append(f"    {t.source.value} --> {t.target.value}{label}")
        return "\n".join(lines)


def build(
    name: str,
    initial: S,
    edges: Iterable[tuple[S, S] | tuple[S, S, str] | tuple[S, S, str, bool]],
    terminal: Iterable[S] = (),
) -> StateMachine[S]:
    transitions: list[Transition[S]] = []
    for edge in edges:
        source, target = edge[0], edge[1]
        label = edge[2] if len(edge) > 2 else ""
        external = bool(edge[3]) if len(edge) > 3 else False
        transitions.append(Transition(source, target, label, external_effect=external))
    return StateMachine(
        name=name,
        initial=initial,
        transitions=transitions,
        terminal_states=frozenset(terminal),
    )
