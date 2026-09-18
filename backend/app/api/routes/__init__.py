from fastapi import APIRouter

from app.api.routes import (
    auth,
    fulfillment,
    listings,
    opportunities,
    orders,
    research,
    system,
    webhooks,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(opportunities.router)
api_router.include_router(research.router)
api_router.include_router(listings.router)
api_router.include_router(orders.router)
api_router.include_router(fulfillment.router)
api_router.include_router(webhooks.router)
api_router.include_router(system.router)

__all__ = ["api_router"]
