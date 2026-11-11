import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI

from app import api
from app.purge_api import router as purge_router
from app.db_migrations import verify_database_schema
from app.auth import create_auth_client, create_org_client
from app.database import SessionLocal
from app.outbox import run_worker
from app.worker_api import router as worker_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    verify_database_schema()  # refuses to start while a database migration is pending or failed (see app/db_migrations.py)
    app.state.auth_client = create_auth_client()
    app.state.org_client = create_org_client()
    stop = asyncio.Event()
    worker = None
    # The email outbox worker (see app/outbox.py). Switched off in tests, which run passes explicitly.
    # On Vercel there is no background task: a schedule calls /internal/v1/support/outbox-run instead (app/worker_api.py).
    if not os.getenv("VERCEL") and os.getenv("SUPPORT_OUTBOX_WORKER", "on").strip().lower() not in ("0", "off", "false", "no"):
        # (the session factory can be replaced through app.state.session_factory: tests point the worker at their own database)
        worker = asyncio.create_task(run_worker(getattr(app.state, "session_factory", SessionLocal), stop))
    yield
    stop.set()
    if worker is not None:
        await worker
    await app.state.auth_client.aclose()
    await app.state.org_client.aclose()


app = FastAPI(
    title="Impex Support Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# Tenant routes depend on `require_tenant` (an ACTIVE organization administrator of an ACTIVE organization, organization taken only from
# the Auth Service's record); platform routes on `require_super_admin`. See app/auth.py.
app.include_router(api.router)
app.include_router(api.admin)
app.include_router(worker_router)  # one outbox pass for a scheduler (shared secret; not in the OpenAPI document)
app.include_router(purge_router)  # internal: delete everything one organization owns here (the Super Admin deleting an organization)


@app.get("/health", tags=["Health"])
@app.get("/api/v1/support/health", tags=["Health"])
async def health_check():
    return {"status": "healthy", "service": "support-service", "timestamp": datetime.now(timezone.utc).isoformat()}
