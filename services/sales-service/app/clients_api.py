"""Client directory. Every route depends on `require_active_tenant`: the organization is always the authenticated
administrator's, an inactive organization is refused, and no route accepts an organization id."""
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.models import Client, DeliveryList, Dispatch, Invoice, SalesOrder
from app.schemas import ClientCreate, ClientList, ClientResponse, ClientUpdate
from app.search import like_pattern
from app.tenancy import create_for_tenant, get_scoped_or_404, scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/sales")
Tenant = Depends(require_active_tenant)


def name_key(name: str) -> str:
    return " ".join(name.split()).casefold()


def name_conflict(name: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f"A client named '{name}' already exists in your directory.")


def _name_taken(db: Session, tenant: TenantContext, key: str, exclude: Optional[uuid.UUID] = None) -> bool:
    query = scoped_count(Client, tenant, Client.name_key == key)
    if exclude is not None:
        query = query.where(Client.id != exclude)
    return db.scalar(query) > 0


@router.post("/clients", response_model=ClientResponse, status_code=status.HTTP_201_CREATED, tags=["Clients"])
def create_client(payload: ClientCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    key = name_key(payload.name)
    if _name_taken(db, tenant, key):
        raise name_conflict(payload.name)
    client = create_for_tenant(Client, tenant, name_key=key, **payload.model_dump())
    db.add(client)
    try:
        db.commit()
    except IntegrityError:  # two requests with the same name raced past the check
        db.rollback()
        raise name_conflict(payload.name)
    db.refresh(client)
    return client


@router.get("/clients", response_model=ClientList, tags=["Clients"])
def list_clients(
    q: Optional[str] = Query(default=None, max_length=100, description="Search name, contact person, e-mail, phone"),
    status_filter: Literal["active", "inactive", "all"] = Query(default="active", alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(*(column.ilike(pattern, escape="\\") for column in (Client.name, Client.contact_person, Client.email, Client.phone))))
    if status_filter == "active":
        filters.append(Client.is_active.is_(True))
    elif status_filter == "inactive":
        filters.append(Client.is_active.is_(False))
    total = db.scalar(scoped_count(Client, tenant, *filters))
    rows = db.scalars(scoped_select(Client, tenant).where(*filters).order_by(Client.name_key, Client.id).limit(limit).offset(offset)).all()
    return ClientList(items=rows, total=total, limit=limit, offset=offset)


@router.get("/clients/{client_id}", response_model=ClientResponse, tags=["Clients"])
def get_client(client_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return get_scoped_or_404(db, Client, tenant, client_id, "Client")


@router.patch("/clients/{client_id}", response_model=ClientResponse, tags=["Clients"])
def update_client(client_id: uuid.UUID, payload: ClientUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    client = get_scoped_or_404(db, Client, tenant, client_id, "Client")
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes:
        key = name_key(changes["name"])
        if key != client.name_key and _name_taken(db, tenant, key, exclude=client.id):
            raise name_conflict(changes["name"])
        client.name_key = key
    for field, value in changes.items():
        setattr(client, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise name_conflict(changes.get("name", client.name))
    db.refresh(client)
    return client


def _set_active(db: Session, tenant: TenantContext, client_id: uuid.UUID, active: bool) -> Client:
    client = get_scoped_or_404(db, Client, tenant, client_id, "Client")
    if client.is_active != active:
        client.is_active = active
        db.commit()
        db.refresh(client)
    return client


@router.post("/clients/{client_id}/deactivate", response_model=ClientResponse, tags=["Clients"])
def deactivate_client(client_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Deactivate: the client stays on its existing records but gets no new ones. (A client with no records at all can be deleted.)"""
    return _set_active(db, tenant, client_id, False)


# What a client can be on record for. A client that appears on any of these can never be deleted (those records are kept, and the database refuses it too): it is deactivated instead.
RECORDS = ((SalesOrder, "sales order", "sales orders"), (DeliveryList, "delivery list", "delivery lists"), (Dispatch, "dispatch", "dispatches"), (Invoice, "invoice", "invoices"))


def _still_on_record(db: Session, tenant: TenantContext, client: Client) -> HTTPException:
    found = []
    for model, singular, plural in RECORDS:
        count = db.scalar(scoped_count(model, tenant, model.client_id == client.id)) or 0
        if count:
            found.append(f"{count} {singular if count == 1 else plural}")
    detail = (f"{client.name} appears on {', '.join(found)}" if found else f"{client.name} appears on records") + \
        ". Those records are kept, so the client cannot be deleted: deactivate it instead."
    return HTTPException(status.HTTP_409_CONFLICT, detail)


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Clients"])
def delete_client(client_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """DELETE a client that nothing refers to (a client registered by mistake). Refused (409) as soon as it is on a sales order, delivery list, dispatch or invoice: those are
    kept for good, so such a client is deactivated, never deleted."""
    client = get_scoped_or_404(db, Client, tenant, client_id, "Client")
    if any(db.scalar(scoped_count(model, tenant, model.client_id == client.id)) for model, _, _ in RECORDS):
        raise _still_on_record(db, tenant, client)
    try:
        db.delete(client)
        db.commit()
    except IntegrityError:  # something this check could not see refers to it (the database's own RESTRICT)
        db.rollback()
        raise _still_on_record(db, tenant, client)


@router.post("/clients/{client_id}/activate", response_model=ClientResponse, tags=["Clients"])
def activate_client(client_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _set_active(db, tenant, client_id, True)
