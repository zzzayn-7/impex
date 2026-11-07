from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI

from app.auth import create_auth_client, create_org_client
from app.inventory import create_inventory_client
from app.orders_api import router as orders_router
from app.module_usage_api import router as module_usage_router
from app.finance_feed_api import router as finance_feed_router
from app.receipts_api import router as receipts_router
from app.suppliers_api import router as suppliers_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.auth_client = create_auth_client()
    app.state.org_client = create_org_client()
    app.state.inventory_client = create_inventory_client()
    yield
    await app.state.auth_client.aclose()
    await app.state.org_client.aclose()
    app.state.inventory_client.close()


app = FastAPI(
    title="Impex Purchasing Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# Every route depends on `require_active_tenant`: an ACTIVE organization administrator whose organization is active.
# The organization is taken only from the Auth Service's record of the caller; no endpoint accepts one as input.
app.include_router(suppliers_router)
app.include_router(orders_router)
app.include_router(receipts_router)
# Asked only by the Organization Service (shared secret), before Purchasing is switched off: what is in progress.
app.include_router(module_usage_router)
# Read-only financial events, pulled by the Finance Service's worker (shared secret; see app/finance_feed_api.py).
app.include_router(finance_feed_router)

PREFIX = "/api/v1/purchasing"


@app.get("/health", tags=["Health"])
@app.get(f"{PREFIX}/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "purchasing-service",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
