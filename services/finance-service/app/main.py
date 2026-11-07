import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI

from app.api import router as finance_router
from app.auth import create_auth_client, create_org_client
from app.database import SessionLocal
from app.sync import Worker, create_feed_client

log = logging.getLogger("impex.finance")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.auth_client = create_auth_client()
    app.state.org_client = create_org_client()
    app.state.feed_client = create_feed_client()  # None when MODULE_INTERNAL_API_KEY is not set: synchronisation is then off, never open
    worker = None
    if app.state.feed_client is None:
        log.warning("MODULE_INTERNAL_API_KEY is not set: Sales/Purchasing synchronisation is disabled")
    elif os.getenv("FINANCE_SYNC_ENABLED", "true").lower() not in ("0", "false", "no"):
        worker = Worker(SessionLocal, app.state.feed_client, float(os.getenv("FINANCE_SYNC_INTERVAL_SECONDS", "15")))
        worker.start()
    yield
    if worker is not None:
        worker.stop()
    if app.state.feed_client is not None:
        app.state.feed_client.close()
    await app.state.auth_client.aclose()
    await app.state.org_client.aclose()


app = FastAPI(
    title="Impex Finance Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# Every route depends on `finance_tenant`: an ACTIVE organization administrator, setup completed, Finance enabled by the Super Admin.
# The organization is taken only from the Auth Service's record of the caller; no endpoint accepts one as input.
app.include_router(finance_router)

PREFIX = "/api/v1/finance"


@app.get("/health", tags=["Health"])
@app.get(f"{PREFIX}/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "finance-service",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
