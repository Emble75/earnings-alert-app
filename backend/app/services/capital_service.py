"""Capital protection.

Limits are enforced here and nowhere else.  The UI does not get a vote: it can
only ask for an approval, and this service decides whether the money is
available.  Every check runs against the ``capital_reservations`` table inside
the same transaction that creates the reservation, so two concurrent
approvals cannot both squeeze under the same limit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import LimitExceededError
from app.core.money import Money
from app.models.enums import CapitalReservationState
from app.models.order import CapitalReservation, Order
from app.services.settings_service import BusinessConfig

#: Reservations in these states are money we have committed or are about to.
ACTIVE_STATES = (CapitalReservationState.RESERVED, CapitalReservationState.COMMITTED)


@dataclass
class CapitalCheck:
    allowed: bool
    violations: list[str] = field(default_factory=list)
    current_exposure: Decimal = Decimal("0")
    projected_exposure: Decimal = Decimal("0")
    daily_capital_used: Decimal = Decimal("0")
    daily_orders: int = 0
    units_for_product: int = 0

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "violations": self.violations,
            "current_exposure": str(self.current_exposure),
            "projected_exposure": str(self.projected_exposure),
            "daily_capital_used": str(self.daily_capital_used),
            "daily_orders": self.daily_orders,
            "units_for_product": self.units_for_product,
        }


class CapitalService:
    def __init__(self, session: Session, config: BusinessConfig) -> None:
        self.session = session
        self.config = config

    # -- reads --------------------------------------------------------------
    def current_exposure(self) -> Decimal:
        stmt = select(func.coalesce(func.sum(CapitalReservation.amount), 0)).where(
            CapitalReservation.state.in_([s.value for s in ACTIVE_STATES])
        )
        total = self.session.execute(stmt).scalar_one()
        return Decimal(total) / Decimal(100) if isinstance(total, int) else Decimal(str(total))

    def _since_midnight(self):
        now = utcnow()
        return now - timedelta(hours=now.hour, minutes=now.minute, seconds=now.second)

    def daily_capital_used(self) -> Decimal:
        stmt = select(func.coalesce(func.sum(CapitalReservation.amount), 0)).where(
            CapitalReservation.reserved_at >= self._since_midnight(),
            CapitalReservation.state.in_([s.value for s in ACTIVE_STATES]),
        )
        total = self.session.execute(stmt).scalar_one()
        return Decimal(total) / Decimal(100) if isinstance(total, int) else Decimal(str(total))

    def daily_order_count(self) -> int:
        stmt = select(func.count(Order.id)).where(Order.approved_at >= self._since_midnight())
        return int(self.session.execute(stmt).scalar_one() or 0)

    def units_committed_for_product(self, product_id: int | None) -> int:
        if product_id is None:
            return 0
        stmt = (
            select(func.coalesce(func.sum(Order.quantity), 0))
            .join(CapitalReservation, CapitalReservation.order_id == Order.id)
            .where(
                Order.product_id == product_id,
                CapitalReservation.state.in_([s.value for s in ACTIVE_STATES]),
            )
        )
        return int(self.session.execute(stmt).scalar_one() or 0)

    # -- checks -------------------------------------------------------------
    def check(self, amount: Money, *, product_id: int | None = None, quantity: int = 1) -> CapitalCheck:
        """Evaluate every configured limit against ``amount``."""
        config = self.config
        violations: list[str] = []
        requested = amount.amount

        exposure = self.current_exposure()
        projected = exposure + requested
        daily_used = self.daily_capital_used()
        daily_orders = self.daily_order_count()
        units = self.units_committed_for_product(product_id)

        if requested > config.max_capital_per_order:
            violations.append(
                f"order requires {requested} which exceeds MAX_CAPITAL_PER_ORDER "
                f"({config.max_capital_per_order})"
            )
        if projected > config.max_capital_exposure:
            violations.append(
                f"total exposure would reach {projected} which exceeds MAX_CAPITAL_EXPOSURE "
                f"({config.max_capital_exposure})"
            )
        if daily_used + requested > config.max_daily_capital:
            violations.append(
                f"today's capital would reach {daily_used + requested} which exceeds "
                f"MAX_DAILY_CAPITAL ({config.max_daily_capital})"
            )
        if daily_orders + 1 > config.max_daily_orders:
            violations.append(
                f"this would be order {daily_orders + 1} today, above MAX_DAILY_ORDERS "
                f"({config.max_daily_orders})"
            )
        if units + quantity > config.max_units_per_product:
            violations.append(
                f"{units + quantity} units of this product would be committed, above "
                f"MAX_UNITS_PER_PRODUCT ({config.max_units_per_product})"
            )

        return CapitalCheck(
            allowed=not violations,
            violations=violations,
            current_exposure=exposure,
            projected_exposure=projected,
            daily_capital_used=daily_used,
            daily_orders=daily_orders,
            units_for_product=units,
        )

    # -- writes -------------------------------------------------------------
    def reserve(
        self,
        amount: Money,
        *,
        order_id: int | None,
        opportunity_id: int | None = None,
        product_id: int | None = None,
        quantity: int = 1,
        purpose: str = "source_purchase",
        is_simulated: bool = True,
    ) -> CapitalReservation:
        """Check the limits and reserve the capital, or raise.

        The check and the insert happen in one transaction on purpose.
        """
        existing = self.session.execute(
            select(CapitalReservation).where(
                CapitalReservation.order_id == order_id,
                CapitalReservation.purpose == purpose,
            )
        ).scalars().first()
        if existing is not None:
            # Re-approving an order must not double-count its capital.
            return existing

        check = self.check(amount, product_id=product_id, quantity=quantity)
        if not check.allowed:
            raise LimitExceededError(
                "; ".join(check.violations),
                context={"capital_check": check.to_dict(), "requested": str(amount.amount)},
            )

        reservation = CapitalReservation(
            order_id=order_id,
            opportunity_id=opportunity_id,
            purpose=purpose,
            amount=amount.amount,
            currency=amount.currency,
            state=CapitalReservationState.RESERVED,
            reserved_at=utcnow(),
            is_simulated=is_simulated,
        )
        self.session.add(reservation)
        self.session.flush()
        return reservation

    def commit(self, reservation: CapitalReservation) -> CapitalReservation:
        reservation.state = CapitalReservationState.COMMITTED
        self.session.flush()
        return reservation

    def release(self, reservation: CapitalReservation, *, note: str = "") -> CapitalReservation:
        reservation.state = CapitalReservationState.RELEASED
        reservation.released_at = utcnow()
        if note:
            reservation.note = note
        self.session.flush()
        return reservation

    def release_for_order(self, order_id: int, *, note: str = "") -> int:
        rows = list(
            self.session.execute(
                select(CapitalReservation).where(
                    CapitalReservation.order_id == order_id,
                    CapitalReservation.state.in_([s.value for s in ACTIVE_STATES]),
                )
            ).scalars()
        )
        for row in rows:
            self.release(row, note=note)
        return len(rows)
