"""ORM models.

Importing this package registers every mapper with :class:`app.db.base.Base`,
which is what Alembic autogenerate and ``Base.metadata.create_all`` rely on.
"""

from app.db.base import Base
from app.models.enums import *  # noqa: F403
from app.models.fulfillment import (
    FulfillmentOrder,
    Inspection,
    Return,
    Shipment,
    WarehouseReceipt,
)
from app.models.market import (
    CompetitionSnapshot,
    DeliveryEstimate,
    InventorySnapshot,
    PriceHistory,
    SourceOffer,
    TargetListing,
)
from app.models.opportunity import Opportunity, ProfitCalculation, RiskAssessment
from app.models.ops import (
    AuditLog,
    ComplianceCheck,
    IdempotencyKey,
    Notification,
    ProviderHealth,
)
from app.models.order import CapitalReservation, Order, OrderEvent, SourceOrder
from app.models.product import Product, ProductIdentifier, ProductMatch
from app.models.setting import Setting
from app.models.user import User

__all__ = [
    "AuditLog",
    "Base",
    "CapitalReservation",
    "CompetitionSnapshot",
    "ComplianceCheck",
    "DeliveryEstimate",
    "FulfillmentOrder",
    "IdempotencyKey",
    "Inspection",
    "InventorySnapshot",
    "Notification",
    "Opportunity",
    "Order",
    "OrderEvent",
    "PriceHistory",
    "Product",
    "ProductIdentifier",
    "ProductMatch",
    "ProfitCalculation",
    "ProviderHealth",
    "Return",
    "RiskAssessment",
    "Setting",
    "Shipment",
    "SourceOffer",
    "SourceOrder",
    "TargetListing",
    "User",
    "WarehouseReceipt",
]
